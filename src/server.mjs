/** The local dashboard server (loopback only). Split out of sparelimit.mjs (A11). */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DAY, interventionFeed, overview } from "./dashdata.mjs";
import { STATE_DIR } from "./constants.mjs";
import { analyzeTranscript, executeMuzzle, executeReset, syncStatusFiles } from "./report.mjs";
import { cacheEvents, refreshPlanCache } from "./plancache.mjs";
import { discoverTranscripts, listClaudeSessions, readAuditRows } from "./transcripts.mjs";
import { estimatePlanUsage, accountScope } from "./planestimate.mjs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactReport } from "./redact.mjs";

/** The host of an Origin header, or null when it is not a web address ("null", garbage). Never throws. */
const originHost = (/** @type {string} */ origin) => {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
};

/**
 * HTTP Server for Live Dashboard
 */
/**
 * @param {string | null | undefined} customPath
 * @param {string | null} [modelKey]
 * @param {number} [port]
 */
export function startServer(customPath, modelKey = null, port = 4321) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const send = (/** @type {any} */ res, /** @type {any} */ code, /** @type {any} */ body, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };

  /** @type {Record<string, any>} */
  const jobs = {};
  /** One request. Anything it throws is answered with an error by the caller: a request must never stop the server. */
  const handle = (/** @type {any} */ req, /** @type {any} */ res) => {
    // No other website may read, load or frame anything here, whatever it asks for.
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Block DNS-rebinding: only answer requests addressed to this machine's loopback.
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      send(res, 403, "Forbidden host");
      return;
    }
    // Only the dashboard itself (or a person typing the address) may ask: a request another website started is refused. Browsers say
    // where a request came from in Sec-Fetch-Site and Origin; "null" (a sandboxed frame, a local file) is not the dashboard.
    const from = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((from && from !== "same-origin" && from !== "none") || (origin !== undefined && originHost(origin) !== req.headers.host)) {
      send(res, 403, "Forbidden origin");
      return;
    }
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // State-changing actions must be POST.
    if ((url.pathname.startsWith("/api/action/") || url.pathname === "/api/reset") && req.method !== "POST") {
      send(res, 405, JSON.stringify({ error: "POST from the dashboard only" }), "application/json");
      return;
    }

    // API: Live Telemetry
    if (url.pathname === "/api/live") {
      const selectedModel = url.searchParams.get("model") || modelKey || null;
      const latest = discoverTranscripts(customPath)[0];
      const freshReport = latest ? analyzeTranscript(latest.filePath, selectedModel) : null;
      if (freshReport) syncStatusFiles(freshReport);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(redactReport(freshReport) || {}));
      return;
    }

    // API: the full handoff prompt, for the copy button (POST only, like the other actions): the text you asked for by clicking
    if (url.pathname === "/api/action/handoff") {
      const latest = discoverTranscripts(customPath)[0];
      const fresh = latest ? analyzeTranscript(latest.filePath, modelKey) : null;
      res.writeHead(fresh ? 200 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(fresh ? { ok: true, prompt: fresh.handoffPrompt } : { error: "No active session" }));
      return;
    }

    // API: the heavy reports (the "what to change" card, the weekly digest, the ledger) scan every transcript, which takes seconds, so each
    // runs in a child process (the live view keeps updating) and its answer is kept for 10 minutes.
    const childJson = (/** @type {any} */ name, extra = /** @type {string[]} */ ([])) => {
      const c = (jobs[[name, ...extra].join(" ")] ||= { value: null, at: 0, pending: null });
      if (c.value && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.value);
      c.pending ||= new Promise((resolve) => {
        execFile(process.execPath, [path.join(rootDir, "sparelimit.mjs"), name, ...extra, "--json"], { maxBuffer: 20e6, timeout: 120e3 }, (err, out) => {
          let body = null;
          try {
            if (!err) body = JSON.parse(out);
          } catch {}
          if (body) Object.assign(c, { value: body, at: Date.now() });
          c.pending = null;
          resolve(body);
        });
      });
      return c.pending;
    };
    const reportJob = { "/api/coach": ["coach", "Could not build the card (no Claude Code transcripts found?)"], "/api/digest": ["digest", "Could not build the digest (no Claude Code transcripts found?)"], "/api/codex": ["codex", "No Codex sessions found."], "/api/planner": ["plan", "Could not build the account planner.", ["--accounts"]], "/api/history": ["history", "Could not build the history (no Claude Code transcripts found?)", ["--days=30"]], "/api/drains": ["drains", "Could not build the drains report."], "/api/files": ["files", "Could not build the file report."] }[url.pathname];
    if (reportJob) {
      childJson(reportJob[0], /** @type {string[]} */ (reportJob[2] || [])).then((/** @type {any} */ body) => send(res, body ? 200 : 503, JSON.stringify(body || { error: reportJob[1] }), "application/json"));
      return;
    }

    // API: plan-limit gauges (estimated), spend history (derived) and the spend rate. Cheap: it reads the incremental plan cache.
    if (url.pathname === "/api/overview") {
      const now = Date.now();
      refreshPlanCache({ now })
        .then(({ cache }) => {
          const events = cacheEvents(cache, now - cache.days * DAY, accountScope());
          send(res, 200, JSON.stringify(overview({ events, estimate: estimatePlanUsage({ now, events }), now })), "application/json");
        })
        .catch(() => send(res, 503, JSON.stringify({ error: "Could not read your session logs." }), "application/json"));
      return;
    }

    // API: the sessions that can be shown on the timeline, and one session's timeline. The client sends an id only; it is looked up in the
    // list of transcripts found on this machine, never used as a path.
    if (url.pathname === "/api/sessions") {
      send(res, 200, JSON.stringify(listClaudeSessions().slice(0, 40).map(({ filePath, ...x }) => x)), "application/json");
      return;
    }
    if (url.pathname === "/api/timeline") {
      const id = url.searchParams.get("id") || "";
      if (!/^[\w-]{8,80}$/.test(id)) return send(res, 400, JSON.stringify({ error: "Bad session id." }), "application/json");
      if (!listClaudeSessions().some((x) => x.id === id)) return send(res, 404, JSON.stringify({ error: "No such session on this machine." }), "application/json");
      childJson("timeline", [id]).then((/** @type {any} */ body) => send(res, body ? 200 : 503, JSON.stringify(body || { error: "Could not build the timeline." }), "application/json"));
      return;
    }

    // API: what Sparelimit said recently and what came of it (the audit log joined with the savings ledger).
    if (url.pathname === "/api/feed") {
      childJson("ledger").then((/** @type {any} */ ledger) => send(res, 200, JSON.stringify({ items: interventionFeed(readAuditRows(), ledger?.entries || [], Date.now()), ledger: ledger?.totals || null, ledgerReady: !!ledger }), "application/json"));
      return;
    }

    // API: Trigger Reset Action
    if (url.pathname === "/api/action/reset" || url.pathname === "/api/reset") {
      const latest = discoverTranscripts(customPath)[0];
      if (latest) {
        const freshReport = analyzeTranscript(latest.filePath, modelKey);
        executeReset(freshReport);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, prompt: freshReport.handoffPrompt }));
        return;
      }
      res.writeHead(400);
      res.end(JSON.stringify({ error: "No active session" }));
      return;
    }

    // API: Muzzle Action
    if (url.pathname === "/api/action/muzzle") {
      executeMuzzle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Log muzzle created at .sparelimit-muzzle.sh" }));
      return;
    }

    // Static Web Assets: strict allow-list, never an arbitrary file from disk.
    const assets = {
      "/": [rootDir, "index.html", "text/html"],
      "/index.html": [rootDir, "index.html", "text/html"],
      "/styles.css": [rootDir, "styles.css", "text/css"],
      "/app.js": [rootDir, "app.js", "application/javascript"],
      "/live-session.js": [STATE_DIR, "live-session.js", "application/javascript"],
      "/live-session.json": [STATE_DIR, "live-session.json", "application/json"]
    };
    const asset = req.method === "GET" ? /** @type {Record<string, string[]>} */ (assets)[url.pathname] : undefined;
    if (asset) {
      try {
        send(res, 200, fs.readFileSync(path.join(asset[0], asset[1])), asset[2]);
      } catch {
        // Dashboard opened before the first snapshot exists: serve an empty one.
        if (asset[1].startsWith("live-session")) send(res, 200, asset[1].endsWith(".js") ? "window.__LIVE_SESSION__ = null;\n" : "null", asset[2]);
        else send(res, 404, "Not found");
      }
    } else {
      send(res, 404, "Not found");
    }
  };
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, "Could not answer that request");
      else res.end();
    }
  });
  server.on("error", (/** @type {any} */ e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use by another program. Close it and run this again.` : `The dashboard could not start: ${e.message}`);
    process.exitCode = 1;
  });

  // Loopback only: the dashboard exposes prompt text and local paths.
  server.listen(port, "127.0.0.1", () => {
    console.log(`\n⚡ sparelimit Live Dashboard running at:`);
    console.log(`   http://127.0.0.1:${port}\n`);
  });
  return server;
}
