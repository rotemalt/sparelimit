// sparelimit Web Cockpit Client Logic

const modelSelect = document.getElementById("modelSelect");
const sessionPill = document.getElementById("sessionPill");
const preActionBanner = document.getElementById("preActionBanner");
const alertIcon = document.getElementById("alertIcon");
const alertHeading = document.getElementById("alertHeading");
const alertBody = document.getElementById("alertBody");
const quickResetBtn = document.getElementById("quickResetBtn");

const savingsValue = document.getElementById("savingsValue");
const savingsSub = document.getElementById("savingsSub");
const currentCostValue = document.getElementById("currentCostValue");
const tokensSub = document.getElementById("tokensSub");
const contextSizeValue = document.getElementById("contextSizeValue");
const nextTurnCostSub = document.getElementById("nextTurnCostSub");
let fiveHourLimitUSD = null; // from the overview: the calibrated five-hour limit in dollars
let lastReport = null;

// Pre-flight (X10): one message's cost as a share of the five-hour limit. The dollar model, so an estimate that can be well off.
function showNextTurn() {
  if (!lastReport) return;
  const cost = Number(lastReport.nextTurnCostUSD || 0);
  const pct = cost > 0 && fiveHourLimitUSD > 0 ? Math.round((cost / fiveHourLimitUSD) * 1000) / 10 : null;
  nextTurnCostSub.textContent = `Next message carries ~$${cost.toFixed(3)} before code generation${pct != null ? `, about ${pct}% of your 5-hour limit` : ""} (estimated)`;
}
const depthValue = document.getElementById("depthValue");
const churnSub = document.getElementById("churnSub");

const flowStatusTag = document.getElementById("flowStatusTag");
const telemetryIntro = document.getElementById("telemetryIntro");
const fileChurnChips = document.getElementById("fileChurnChips");
const signalsList = document.getElementById("signalsList");
const handoffBox = document.getElementById("handoffBox");
const copyHandoffBtn = document.getElementById("copyHandoffBtn");
const copyBtnText = document.getElementById("copyBtnText");
const createHandoffFileBtn = document.getElementById("createHandoffFileBtn");
const installMuzzleBtn = document.getElementById("installMuzzleBtn");
const lockScopeBtn = document.getElementById("lockScopeBtn");
const copyRuleShieldBtn = document.getElementById("copyRuleShieldBtn");

// Pre-Action Tester Elements
const userDraftInput = document.getElementById("userDraftInput");
const draftTrapsList = document.getElementById("draftTrapsList");
const cleanDraftOutput = document.getElementById("cleanDraftOutput");
const promptTaxBadge = document.getElementById("promptTaxBadge");
const copyCleanDraftBtn = document.getElementById("copyCleanDraftBtn");

let activeReport = null;

function renderDashboard(report) {
  if (!report || !report.tokens) return;
  activeReport = report;

  // Header
  sessionPill.textContent = `Session: ${report.sessionId.slice(0, 8)}…`;

  // Pre-Action Alert Banner
  preActionBanner.className = `alert-banner ${report.statusLevel}`;
  if (report.statusLevel === "critical") {
    alertIcon.textContent = "";
    alertHeading.textContent = "Start fresh before your next message";
    quickResetBtn.style.display = "inline-block";
  } else if (report.statusLevel === "warn") {
    alertIcon.textContent = "";
    alertHeading.textContent = "This conversation is getting long";
    quickResetBtn.style.display = "inline-block";
  } else {
    alertIcon.textContent = "";
    alertHeading.textContent = "This session is in good shape";
    quickResetBtn.style.display = "none";
  }
  alertBody.textContent = report.preActionAlert;

  // Hero Metrics
  savingsValue.textContent = `$${Number(report.potentialSavingsUSD || 0).toFixed(2)}`;
  savingsSub.textContent = `if you started fresh now (${(report.tokens.latestTurnContext / 1000).toFixed(1)}k tokens) instead of carrying on. Estimated, not counted`;

  currentCostValue.textContent = `$${Number(report.realCostUSD || 0).toFixed(3)}`;
  tokensSub.textContent = `${(report.tokens.total / 1000).toFixed(1)}k tokens (${report.tokens.cacheReadRatio}% cache re-reads) · ${report.confidence || "derived"}`;

  contextSizeValue.textContent = `${(report.tokens.latestTurnContext / 1000).toFixed(1)}k tok`; // the context size is read from the log's usage numbers (the label is on the burn card)
  lastReport = report;
  showNextTurn();

  depthValue.textContent = `${report.turnCount} turns`;
  const totalWrites = (report.touchedFiles || []).reduce((acc, f) => acc + (f.writes || 0), 0);
  churnSub.textContent = `${report.modelStepsCount} steps · ${totalWrites} file writes`;

  // Status Tag
  flowStatusTag.textContent = report.flowStatus;
  flowStatusTag.className = `tag-badge ${report.statusLevel}`;

  // File Churn Section
  fileChurnChips.innerHTML = "";
  const workspaceFiles = (report.touchedFiles || []).filter(
    (f) => !f.file.includes("/.gemini/") && !f.file.includes("/var/folders/")
  );

  if (workspaceFiles.length === 0) {
    fileChurnChips.innerHTML = '<span class="empty-chip">No workspace files modified yet</span>';
  } else {
    for (const f of workspaceFiles) {
      const chip = document.createElement("span");
      const isThrashed = f.writes >= 3;
      chip.className = `churn-chip ${isThrashed ? "high-churn" : ""}`;
      chip.textContent = `${f.basename} (${f.reads}r / ${f.writes}w)`;
      fileChurnChips.appendChild(chip);
    }
  }

  // Warning Signals List
  signalsList.innerHTML = "";
  if (report.signals && report.signals.length > 0) {
    for (const sig of report.signals) {
      const li = document.createElement("li");
      li.textContent = sig;
      signalsList.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent = "Clean surgical execution — low history drag and zero command failures.";
    signalsList.appendChild(li);
  }

  // Surgical Handoff Box
  handoffBox.textContent = report.handoffPrompt;

  // Update prompt tester context drag badge
  updatePromptTester();
}

// Pre-Action Prompt Tester Logic
function updatePromptTester() {
  const text = userDraftInput.value.trim();
  const activeContext = activeReport ? activeReport.tokens.latestTurnContext : 80000;
  const pricing = activeReport ? activeReport.pricing : { cacheRead: 0.3, output: 15 };

  const promptTokens = Math.round(text.length / 3.8);
  const totalDrag = activeContext + promptTokens;
  const turnCost = ((totalDrag / 1_000_000) * pricing.cacheRead + (1500 / 1_000_000) * pricing.output).toFixed(3);

  promptTaxBadge.textContent = `${(totalDrag / 1000).toFixed(1)}k tok drag (~$${turnCost})`;

  if (!text) {
    draftTrapsList.innerHTML = "<span>Type a message above to check it...</span>";
    cleanDraftOutput.textContent = "1-shot clean prompt will appear here...";
    return;
  }

  const traps = [];
  const lower = text.toLowerCase();

  if (/still broken|still not working|fix it|please fix/i.test(lower)) {
    traps.push("⚠️ Vague retry language ('fix it') detected without root-cause lock.");
  }
  if (/and also|while you're at it|also make/i.test(lower)) {
    traps.push("⚠️ Compound prompt: 2 tasks mixed in 1 turn (high cross-file breakage risk).");
  }
  if (activeContext > 65000) {
    traps.push(`🚨 Saturated context (${(activeContext / 1000).toFixed(1)}k tokens): reset chat before sending.`);
  }

  draftTrapsList.innerHTML = "";
  if (traps.length > 0) {
    for (const t of traps) {
      const div = document.createElement("div");
      div.className = "trap-pill";
      div.textContent = t;
      draftTrapsList.appendChild(div);
    }
  } else {
    draftTrapsList.innerHTML = '<span style="color: var(--green);">✓ Prompt is clean and focused.</span>';
  }

  // Build clean 1-shot prompt
  const cleanGoal = text
    .replace(/^(it's still broken!*|it's still not working!*|please fix|fix it)\s*/i, "")
    .replace(/,?\s*fix it\b/i, "")
    .trim();

  const targetDisplay =
    activeReport && activeReport.touchedFiles.length > 0
      ? activeReport.touchedFiles.slice(0, 3).map((f) => f.basename).join(", ")
      : "target file";

  cleanDraftOutput.textContent = `TASK (1-TURN SURGICAL STRIKE):
${cleanGoal || text}

SCOPE LOCK:
- In: ${targetDisplay}
- Return minimal unified diff only (no full-file rewrites).
- Verify with tests before finishing.`;
}

userDraftInput.addEventListener("input", updatePromptTester);

copyCleanDraftBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(cleanDraftOutput.textContent);
  copyCleanDraftBtn.textContent = "Copied!";
  setTimeout(() => {
    copyCleanDraftBtn.textContent = "Copy";
  }, 1500);
});

// Model rate picker change
modelSelect.addEventListener("change", () => {
  fetchLiveTelemetry(modelSelect.value);
});

// Fetch live telemetry from server or fallback to local embedded snapshot
async function fetchLiveTelemetry(modelKey = modelSelect.value) {
  try {
    const res = await fetch(`/api/live?model=${encodeURIComponent(modelKey)}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      renderDashboard(data);
      return;
    }
  } catch {
    if (window.__LIVE_SESSION__) {
      renderDashboard(window.__LIVE_SESSION__);
    }
  }
}

// The live report hides your last request (D2); the full prompt is fetched only when you click copy.
async function fullHandoff() {
  try {
    const res = await fetch("/api/action/handoff", { method: "POST" });
    if (res.ok) return (await res.json()).prompt;
  } catch {}
  return activeReport.handoffPrompt;
}

// Copy Handoff Button
copyHandoffBtn.addEventListener("click", async () => {
  if (!activeReport) return;
  await navigator.clipboard.writeText(await fullHandoff());
  copyBtnText.textContent = "Copied";
  setTimeout(() => {
    copyBtnText.textContent = "Copy handoff";
  }, 1800);
});

// Quick Reset Button
quickResetBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/action/reset", { method: "POST" });
    if (res.ok) {
      alert("✓ Handoff generated and copied! Paste it directly into your fresh chat.");
      fetchLiveTelemetry();
      return;
    }
  } catch {}

  if (activeReport) {
    await navigator.clipboard.writeText(await fullHandoff());
    alert("✓ 1-Shot handoff prompt copied to clipboard! Paste it into your fresh chat.");
  }
});

// Save .sparelimit-handoff.md button
createHandoffFileBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/action/reset", { method: "POST" });
    if (res.ok) {
      alert("✓ Successfully saved .sparelimit-handoff.md to current folder!");
      return;
    }
  } catch {}
  alert("Run 'sparelimit reset' in your terminal to save .sparelimit-handoff.md");
});

// Install Log Muzzle Button
installMuzzleBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/action/muzzle", { method: "POST" });
    if (res.ok) {
      alert("✓ Log muzzle script installed at .sparelimit-muzzle.sh!");
      return;
    }
  } catch {}
  alert("Run 'sparelimit muzzle' in your terminal to create the wrapper.");
});

// Freeze Scope Button
lockScopeBtn.addEventListener("click", () => {
  alert("Run 'sparelimit freeze' in your terminal to lock .sparelimit-freeze.json for this workspace.");
});

// Copy Token Shield Rule
copyRuleShieldBtn.addEventListener("click", async () => {
  const shield = `# SPARELIMIT TOKEN SHIELD
- Before doing broad edits, check .sparelimit-status.json. If should_stop: true, halt and ask user to reset.
- Minimal unified diffs only. Never echo full 400-line files.
- Never dump raw build/test logs. Summarize failures to < 15 lines.`;
  await navigator.clipboard.writeText(shield);
  alert("✓ Copied Token Shield to clipboard! Paste into .cursorrules or CLAUDE.md");
});

// Initial load & 2.5s polling
fetchLiveTelemetry();
setInterval(() => fetchLiveTelemetry(modelSelect.value), 2500);


// ---- "What to change" card (sparelimit coach). Built with textContent only: nothing from the data is parsed as HTML.
function coachRow(h) {
  const row = document.createElement("div");
  row.className = "coach-row";
  const head = document.createElement("div");
  head.className = "coach-head";
  const amount = document.createElement("strong");
  amount.textContent = `$${Math.round(h.usd).toLocaleString("en-US")}`;
  const title = document.createElement("span");
  title.textContent = h.title;
  const conf = document.createElement("span");
  conf.className = `tag-badge ${h.confidence === "derived" ? "good" : "warn"}`;
  conf.textContent = h.confidence;
  head.append(amount, title, conf);
  const facts = [`${h.shareOfSpend}% of spend`, h.weeklyLimitPct != null ? `≈${h.weeklyLimitPct}% of a weekly limit in an average week` : null, h.range ? `range $${Math.round(h.range[0])}–$${Math.round(h.range[1])}` : null].filter(Boolean).join(" · ");
  const sub = document.createElement("div");
  sub.className = "coach-sub";
  sub.textContent = facts;
  const how = document.createElement("div");
  how.className = "coach-how";
  how.textContent = `How: ${h.how}`;
  row.append(head, sub, how);
  if (h.caution) {
    const c = document.createElement("div");
    c.className = "coach-caution";
    c.textContent = `Caution: ${h.caution}`;
    row.append(c);
  }
  return row;
}

function coachSection(target, heading, rows) {
  target.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = heading;
  target.append(h, ...rows.map(coachRow));
}

async function loadCoachCard() {
  const tag = document.getElementById("coachTag");
  const intro = document.getElementById("coachIntro");
  try {
    const res = await fetch("/api/coach", { cache: "no-store" });
    const card = await res.json();
    if (!res.ok || card.error) throw new Error(card.error || "failed");
    tag.textContent = "READY";
    tag.className = "tag-badge good";
    intro.textContent = `${card.sessions} sessions over ${card.weeks} weeks · $${Math.round(card.totalUSD).toLocaleString("en-US")} at list price. Savings are estimates that assume you make the change.`;
    coachSection(document.getElementById("coachSavings"), "Modelled savings (they overlap: do not add them up)", card.savings);
    coachSection(document.getElementById("coachStake"), "Where else the spend is (spend in the area, not a saving)", card.atStake);
    document.getElementById("coachNote").textContent = card.note;
  } catch (e) {
    tag.textContent = "UNAVAILABLE";
    tag.className = "tag-badge critical";
    intro.textContent = "No Claude Code history found to build this from. Run `sparelimit coach` in a terminal for details.";
  }
}
loadCoachCard();


// ---- "Last 7 days" card (sparelimit digest). textContent only.
async function loadDigestCard() {
  const tag = document.getElementById("digestTag");
  const intro = document.getElementById("digestIntro");
  try {
    const res = await fetch("/api/digest", { cache: "no-store" });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || "failed");
    const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
    const s = d.spend;
    tag.textContent = "READY";
    tag.className = "tag-badge good";
    intro.textContent = `${usd(s.thisWeekUSD)} at list price${s.weeklyLimitPct != null ? ` (≈${s.weeklyLimitPct}% of a weekly plan limit)` : ""}; the 7 days before: ${usd(s.lastWeekUSD)}${s.changePct != null ? ` (${s.changePct >= 0 ? "+" : ""}${s.changePct}%)` : ""}. ${d.sessionsEnded} session${d.sessionsEnded === 1 ? "" : "s"} ended this week.`;
    const body = document.getElementById("digestBody");
    body.replaceChildren();
    const lines = [];
    if (d.focus) lines.push(["Focus for next week", `${d.focus.title} (about ${usd(d.focus.usd)}, ${d.focus.confidence}). How: ${d.focus.how}`]);
    if (d.swarms.length) lines.push(["Swarms", d.swarms.map((x) => `${x.agents} subagents (up to ${x.peakConcurrent} at once) cost ${usd(x.sideUSD)} of ${usd(x.totalUSD)}`).join("; ")]);
    if (d.breaks.times) lines.push(["Cold-cache returns", `${d.breaks.times} time${d.breaks.times === 1 ? "" : "s"}, ${usd(d.breaks.extraVsWarmUSD)} more than a warm cache`]);
    if (d.adoption?.length) lines.push(["Habits you are tracking", d.adoption.map((h) => `${h.title}: ${h.verdict}${h.reason ? ` (${h.reason})` : ""}`).join("; ")]);
    if (d.ledger?.interventions) lines.push(["Savings ledger (counted only when you acted and the cost was measured)", `counted ${usd(d.ledger.countedUSD)} from ${d.ledger.counted} of ${d.ledger.interventions} interventions; ${d.ledger.ignored} ignored, ${d.ledger.noData || 0} unsettled, ${d.ledger.pending || 0} pending, ${d.ledger.stopped || 0} work stopped${d.ledger.overlap ? `, ${d.ledger.overlap} overlapping` : ""} (they add up to ${d.ledger.interventions})`]);
    const n = Object.entries(d.nudges);
    lines.push(["Nudges shown by Sparelimit", n.length ? n.map(([k, v]) => `${k} ×${v}`).join(", ") : "none"]);
    for (const [label, text] of lines) {
      const row = document.createElement("div");
      row.className = "coach-row";
      const head = document.createElement("strong");
      head.textContent = label;
      const sub = document.createElement("div");
      sub.className = "coach-sub";
      sub.textContent = text;
      row.append(head, sub);
      body.append(row);
    }
    document.getElementById("digestNote").textContent = d.note;
  } catch (e) {
    tag.textContent = "UNAVAILABLE";
    tag.className = "tag-badge critical";
    intro.textContent = "No Claude Code history found to build this from. Run `sparelimit digest` in a terminal for details.";
  }
}
loadDigestCard();


// ---- Overview: plan limits (estimated), spend history (derived), what Sparelimit said and what came of it. textContent and SVG only.
const dur = (min) => (min == null ? "?" : min >= 1440 ? `${(min / 1440).toFixed(1)} days` : min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min} min`);
const usd = (n, d = 0) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

function renderGauge(prefix, g, emptyText) {
  const big = document.getElementById(`${prefix}pct`);
  const fill = document.getElementById(`${prefix}fill`);
  const text = document.getElementById(`${prefix}text`);
  if (!g) {
    big.textContent = "-";
    fill.style.width = "0%";
    text.textContent = emptyText;
    return;
  }
  big.textContent = `${Math.round(g.pct)}%`;
  fill.style.width = `${Math.min(100, g.pct)}%`;
  fill.className = `gauge-fill ${g.pct >= 90 ? "red" : g.pct >= 70 ? "yellow" : "green"}`;
  const parts = [`resets in ${dur(g.resetsInMin)}`];
  if (g.ratePctPerHour != null) parts.push(`burning ${g.ratePctPerHour}%/h`);
  let verdict = "";
  if (g.minutesToLimit != null) verdict = g.lastsUntilReset ? " It should last until the reset." : ` At this pace it runs out in about ${dur(g.minutesToLimit)}, before the reset.`;
  text.textContent = `${parts.join(" · ")}.${verdict}`;
}

function barChart(target, buckets, label, edgeLabels = false) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 560;
  const H = 150;
  const max = Math.max(1, ...buckets.map((b) => b.usd));
  const bw = W / buckets.length;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 22}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label}. Highest: ${usd(max, 2)}`);
  buckets.forEach((b, i) => {
    const h = Math.max(b.usd > 0 ? 2 : 0, (b.usd / max) * (H - 8));
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String(i * bw + bw * 0.12));
    r.setAttribute("y", String(H - h));
    r.setAttribute("width", String(bw * 0.76));
    r.setAttribute("height", String(h));
    r.setAttribute("rx", "2");
    r.setAttribute("class", b.partial ? "bar partial" : "bar");
    const t = document.createElementNS(NS, "title");
    t.textContent = `${b.label}: ${usd(b.usd, 2)}${b.partial ? " so far" : ""}`;
    r.append(t);
    svg.append(r);
    if (b.tick) {
      const x = document.createElementNS(NS, "text");
      const edge = edgeLabels && (i === 0 || i === buckets.length - 1);
      x.setAttribute("x", String(edge ? (i === 0 ? 0 : W) : i * bw + bw / 2));
      x.setAttribute("y", String(H + 16));
      x.setAttribute("text-anchor", edge ? (i === 0 ? "start" : "end") : "middle"); // on a sparse axis the end labels must not be clipped
      x.setAttribute("class", "axis");
      x.textContent = b.tick;
      svg.append(x);
    }
  });
  const m = document.createElementNS(NS, "text");
  m.setAttribute("x", "0");
  m.setAttribute("y", "11");
  m.setAttribute("class", "axis");
  m.textContent = usd(max, max < 10 ? 2 : 0);
  svg.append(m);
  target.replaceChildren(svg);
}

async function loadOverview() {
  try {
    const res = await fetch("/api/overview", { cache: "no-store" });
    const o = await res.json();
    if (!res.ok || o.error) throw new Error(o.error || "failed");
    const uncal = 'Not calibrated yet. Run `sparelimit calibrate --five=<percent> --weekly=<percent> --weekly-reset="fri 14:00"` with the numbers your app shows.';
    fiveHourLimitUSD = o.plan.fiveHourLimitUSD;
    showNextTurn();
    renderGauge("g5", o.plan.fiveHour, o.calibrated ? "No activity in the current 5-hour window." : uncal);
    renderGauge("gW", o.plan.weekly, o.calibrated ? "Give --weekly-reset when calibrating to see the weekly limit." : uncal);
    document.getElementById("planNote").textContent = o.calibrated ? `Plan percentages are estimated from your own logs, calibrated on ${o.plan.calibratedOn} screenshot${o.plan.calibratedOn === 1 ? "" : "s"}. They count Claude Code on this machine only; other uses of your plan are not included.` : "";
    document.getElementById("rateBig").textContent = `${usd(o.rate.perHourUSD, 2)}/h`;
    document.getElementById("rateText").textContent = `at list price, over the last 30 minutes. Busiest hour in the last 24: ${usd(o.rate.peakHourUSD, 2)}.`;
    const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric" });
    barChart(document.getElementById("chart24"), o.history.hourly.map((b, i, a) => ({ ...b, label: `${clock(b.start)}`, tick: i % 6 === 0 || i === a.length - 1 ? clock(b.start) : "" })), "Spend per hour, last 24 hours", true);
    barChart(document.getElementById("chart7"), o.history.daily.map((b) => ({ ...b, label: new Date(b.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }), tick: new Date(b.start).toLocaleDateString([], { weekday: "short" }) })), "Spend per day, last 7 days");
  } catch (e) {
    document.getElementById("g5text").textContent = "Could not read your session logs.";
    document.getElementById("gWtext").textContent = "";
  }
}

const OUTCOME = { counted: ["good", "counted"], ignored: ["critical", "ignored"], pending: ["warn", "too recent"], stopped: ["warn", "work stopped"], overlap: ["warn", "overlaps another"], "no-data": ["warn", "not enough data"] };

async function loadFeed() {
  const tag = document.getElementById("feedTag");
  const intro = document.getElementById("feedIntro");
  const list = document.getElementById("feedList");
  try {
    const res = await fetch("/api/feed", { cache: "no-store" });
    const f = await res.json();
    tag.textContent = f.items.length ? `${f.items.length} IN 7 DAYS` : "QUIET";
    tag.className = "tag-badge good";
    const t = f.ledger;
    document.getElementById("ledgerBig").textContent = t ? usd(t.countedUSD, 2) : "-";
    document.getElementById("ledgerText").textContent = t ? `from ${t.counted} of ${t.interventions} interventions${t.ignored ? `; ${t.ignored} ignored` : ""}. Counted only when an alert fired, you acted, and the cost afterwards was measured.` : "The ledger could not be read.";
    intro.textContent = f.items.length ? "Newest first. The verdict is the savings ledger's: it counts a saving only when you acted and the cost afterwards was measured." : "Nothing has been said in the last 7 days.";
    list.replaceChildren(
      ...f.items.map((i) => {
        const row = document.createElement("div");
        row.className = "coach-row feed-row";
        const head = document.createElement("div");
        head.className = "coach-head";
        const when = document.createElement("strong");
        when.textContent = new Date(i.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        const kind = document.createElement("span");
        kind.className = `tag-badge ${i.kind === "stop" ? "critical" : "warn"}`;
        kind.textContent = i.kind;
        const rule = document.createElement("span");
        rule.textContent = `${i.rule}${i.count > 1 ? ` ×${i.count}` : ""}`;
        head.append(when, kind, rule);
        if (i.outcome) {
          const o = OUTCOME[i.outcome.status] || ["warn", i.outcome.status];
          const pill = document.createElement("span");
          pill.className = `tag-badge ${o[0]}`;
          pill.textContent = i.outcome.status === "counted" ? `counted ${usd(i.outcome.savingUSD, 2)}` : o[1];
          head.append(pill);
        }
        const sub = document.createElement("div");
        sub.className = "coach-sub";
        sub.textContent = [i.message, i.outcome && i.outcome.note].filter(Boolean).join(" → ");
        row.append(head, sub);
        return row;
      })
    );
  } catch (e) {
    tag.textContent = "UNAVAILABLE";
    tag.className = "tag-badge critical";
    intro.textContent = "Could not read the alert log. Run `sparelimit ledger` in a terminal.";
  }
}

loadOverview();
loadFeed();
setInterval(loadOverview, 30000);
setInterval(loadFeed, 5 * 60000);


// ---- Session timeline (D6): the context as the conversation grew, with the moments that mattered. textContent and SVG only.
const KIND_LABEL = { threshold: "window level", shrank: "shrank", cold: "cold cache", loop: "loop", errors: "errors", swarm: "swarm", sparelimit: "Sparelimit said" };

function timelineChart(target, tl) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 760;
  const PAD = { l: 44, r: 10 };
  const H1 = 190;
  const H2 = 70;
  const plotW = W - PAD.l - PAD.r;
  const N = tl.points.length;
  const x = (n) => PAD.l + (N <= 1 ? 0 : ((n - 1) / (N - 1)) * plotW);
  const maxPct = Math.max(100, ...tl.points.map((p) => p.pct ?? 0));
  const y1 = (v) => 8 + (1 - Math.min(v, maxPct) / maxPct) * (H1 - 16);
  const maxCost = Math.max(1, tl.totalUSD);
  const y2 = (v) => H1 + 18 + (1 - v / maxCost) * (H2 - 8);
  const el = (name, attrs = {}, text) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H1 + H2 + 40}`, role: "img", "aria-label": `Context size across ${N} responses, with ${tl.moments.length} marked moments, and the cumulative cost` });
  // pauses of an hour or more
  for (const g of tl.gaps) {
    const band = el("rect", { x: x(g.afterN), y: 8, width: Math.max(1.5, (plotW / Math.max(N, 1)) * 3), height: H1 - 16, class: "gap" });
    band.append(el("title", {}, `Away ${g.minutes >= 120 ? `${(g.minutes / 60).toFixed(1)} hours` : `${g.minutes} minutes`}`));
    svg.append(band);
  }
  // reference lines
  for (const [v, cls, label] of [[tl.thresholds.warnPct, "warn", `${tl.thresholds.warnPct}%`], [tl.thresholds.stopPct, "stop", `${tl.thresholds.stopPct}%`], [0, "base", "0%"]]) {
    svg.append(el("line", { x1: PAD.l, x2: W - PAD.r, y1: y1(v), y2: y1(v), class: `ref ${cls}` }));
    svg.append(el("text", { x: PAD.l - 6, y: y1(v) + 4, "text-anchor": "end", class: "axis" }, label));
  }
  // the context line: the highest value in each stretch when there are many responses, so the peaks stay
  const step = Math.max(1, Math.ceil(N / 700));
  const pts = [];
  for (let i = 0; i < N; i += step) {
    const chunk = tl.points.slice(i, i + step);
    const top = chunk.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
    pts.push(`${x(top.n).toFixed(1)},${y1(top.pct ?? 0).toFixed(1)}`);
  }
  svg.append(el("polyline", { points: pts.join(" "), class: "ctx-line" }));
  // cumulative cost
  const cpts = [];
  for (let i = 0; i < N; i += step) cpts.push(`${x(tl.points[i].n).toFixed(1)},${y2(tl.points[i].cumUSD).toFixed(1)}`);
  svg.append(el("text", { x: PAD.l - 6, y: y2(maxCost) + 4, "text-anchor": "end", class: "axis" }, `$${Math.round(maxCost)}`));
  svg.append(el("text", { x: PAD.l - 6, y: y2(0) + 4, "text-anchor": "end", class: "axis" }, "$0"));
  svg.append(el("polyline", { points: cpts.join(" "), class: "cost-line" }));
  svg.append(el("text", { x: PAD.l, y: H1 + 12, class: "axis" }, "cumulative cost"));
  // moments
  for (const m of tl.moments) {
    const g = el("g", { class: `moment m-${m.kind}`, tabindex: "0" });
    g.append(el("title", {}, `${m.id}. ${m.label}`));
    g.append(el("circle", { cx: x(m.n), cy: y1(m.pct ?? 0), r: 7 }));
    g.append(el("text", { x: x(m.n), y: y1(m.pct ?? 0) + 3, "text-anchor": "middle" }, String(m.id)));
    svg.append(g);
  }
  const day = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  svg.append(el("text", { x: PAD.l, y: H1 + H2 + 34, class: "axis" }, `${day(tl.start)} · response 1`));
  svg.append(el("text", { x: W - PAD.r, y: H1 + H2 + 34, "text-anchor": "end", class: "axis" }, `${day(tl.end)} · response ${N}`));
  target.replaceChildren(svg);
}

function renderTimeline(tl) {
  const usd0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
  document.getElementById("tlIntro").textContent = `${tl.project || "session"} · ${tl.responses} responses · ${usd0(tl.totalUSD)} at list price · ${tl.summary.activeMinutes} active minutes over ${tl.summary.calendarDays} days. The horizontal axis is the response number, not the clock; shaded bars are pauses of an hour or more.`;
  const a = tl.summary.aboveWarn;
  const sum = document.getElementById("tlSummary");
  sum.replaceChildren();
  const line = (text, label) => {
    const p = document.createElement("p");
    p.className = "tl-line";
    p.textContent = text;
    const tag = document.createElement("span");
    tag.className = `tag-badge ${label === "estimated" ? "warn" : "good"}`;
    tag.textContent = label;
    p.append(" ", tag);
    sum.append(p);
  };
  line(`${a.shareOfResponses}% of the responses and ${usd0(a.usd)} (${a.shareOfSpend}% of the spend) happened at ${tl.thresholds.warnPct}% of the window or more.`, "derived");
  const er = tl.summary.earlierReset;
  if (er && er.savingUSD > 0) line(`Starting fresh at 60% instead of waiting for auto-compaction would have saved about ${usd0(er.savingUSD)} (range ${usd0(er.lowUSD)} to ${usd0(er.highUSD)}).`, "estimated");
  if (tl.why?.causes?.length) {
    const p = document.createElement("p");
    p.className = "tl-line";
    p.textContent = "Why it cost this much (the causes overlap, so they are not added up): " + tl.why.causes.slice(0, 4).map((c) => `${c.title}, ${usd0(c.usd)} (${c.sharePct}%, ${c.confidence})`).join("; ") + ". Run `sparelimit why` for what to try.";
    sum.append(p);
  }
  timelineChart(document.getElementById("tlChart"), tl);
  document.getElementById("tlMoments").replaceChildren(
    ...tl.moments.map((m) => {
      const li = document.createElement("li");
      li.className = `m-${m.kind}`;
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(m.id);
      const body = document.createElement("div");
      const head = document.createElement("div");
      head.className = "tl-when";
      head.textContent = `${new Date(m.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · response ${m.n} · ${Math.round(m.pct ?? 0)}% of the window · ${usd0(m.cumUSD)} spent so far · ${KIND_LABEL[m.kind] || m.kind}`;
      const text = document.createElement("div");
      text.textContent = m.label;
      body.append(head, text);
      if (m.compare) {
        const c = m.compare;
        const ba = document.createElement("div");
        ba.className = "tl-when";
        ba.textContent = `Before/after: $${c.before.costPerResponse.toFixed(2)} per response over the ${c.before.responses} before (about ${c.before.meanPct}% of the window), $${c.after.costPerResponse.toFixed(2)} over the ${c.after.responses} after (about ${c.after.meanPct}%)${c.changePct == null ? "" : `, ${c.changePct > 0 ? "+" : ""}${c.changePct}%`}. Measured; the work may differ.`;
        body.append(ba);
      }
      li.append(num, body);
      return li;
    })
  );
}

async function loadTimeline(id) {
  const intro = document.getElementById("tlIntro");
  intro.textContent = "Reading the session (a few seconds)...";
  try {
    const res = await fetch(`/api/timeline?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const tl = await res.json();
    if (!res.ok || tl.error) throw new Error(tl.error || "failed");
    renderTimeline(tl);
  } catch (e) {
    intro.textContent = "Could not build the timeline for that session. Run `sparelimit timeline` in a terminal.";
  }
}

async function initTimeline() {
  const select = document.getElementById("tlSelect");
  try {
    const list = await (await fetch("/api/sessions", { cache: "no-store" })).json();
    if (!list.length) throw new Error("none");
    select.replaceChildren(
      ...list.map((s, i) => {
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = `${i === 0 ? "Latest: " : ""}${s.project || "session"} · ${new Date(s.mtimeMs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${s.sizeMB} MB`;
        return o;
      })
    );
    select.addEventListener("change", () => loadTimeline(select.value));
    // the most recent session is usually still open and short; open the biggest of the recent ones instead is not our call: show the latest
    loadTimeline(list[0].id);
  } catch (e) {
    document.getElementById("tlIntro").textContent = "No Claude Code sessions found on this machine.";
  }
}
initTimeline();

// ---- Codex (A7): what the Codex sessions on this machine cost, beside the Claude Code views. Hidden when there are none. textContent only.
async function initCodex() {
  const card = document.getElementById("codexCard");
  try {
    const res = await fetch("/api/codex", { cache: "no-store" });
    const c = await res.json();
    if (!res.ok || c.error) throw new Error("none");
    const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
    const ago = (iso) => {
      const h = (Date.now() - Date.parse(iso)) / 3600e3;
      return h < 48 ? `${h.toFixed(1)} hours ago` : `${(h / 24).toFixed(1)} days ago`;
    };
    document.getElementById("codexIntro").textContent = `${c.conversations} conversations and ${c.fanOut.subagentSessions} subagent runs, ${usd(c.totalUSD)} at list price. Tokens are as Codex logged them; dollars are at list price. The coaching views are Claude's rules, so they are not applied here.`;
    const lines = [];
    if (c.fanOut.subagentSessions) lines.push([`Subagents cost ${usd(c.fanOut.subagentUSD)} (${c.fanOut.shareOfSpend}% of the spend), a median of $${c.fanOut.medianSubagentUSD.toFixed(2)} each${c.fanOut.widest ? `; the widest fan-out was ${c.fanOut.widest.subagents} subagents` : ""}.`, "derived"]);
    if (c.planLimits && (c.planLimits.fiveHourPct != null || c.planLimits.weeklyPct != null)) lines.push([`Plan limits as Codex last reported them, ${ago(c.planLimits.at)}: 5-hour ${c.planLimits.fiveHourPct ?? "?"}%, weekly ${c.planLimits.weeklyPct ?? "?"}%. Not live.`, "exact"]);
    const fc = c.planLimits && c.planLimits.forecast;
    if (fc && fc.windowResetSinceReading) lines.push(["A limit window has reset since that reading, so there is no current figure to forecast from.", "estimated"]);
    else if (fc && fc.fiveHour && fc.fiveHour.minutesToLimit != null) {
      const m = fc.fiveHour.minutesToLimit;
      const dur = m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
      lines.push([`5-hour: at ${fc.fiveHour.ratePctPerHour}% an hour it ${fc.fiveHour.lastsUntilReset ? "lasts until the reset" : `runs out in about ${dur}, before the reset`}.${fc.ageMin > 30 ? ` The reading is ${fc.ageMin} minutes old, so this is the window average.` : ""}`, "estimated"]);
    }
    lines.push([`${c.tokens.cacheReadShare}% of the tokens were cache re-reads.`, "exact"]);
    if (c.byModel.length) lines.push([`By model: ${c.byModel.slice(0, 3).map((m) => `${m.model} ${usd(m.usd)}${m.priced ? "" : " (not in the price list: estimated)"}`).join(", ")}.`, "derived"]);
    const last7 = c.last14Days.slice(-7);
    if (last7.length) lines.push([`Last ${last7.length} days with activity: ${last7.map((d) => usd(d.usd)).join(", ")}.`, "derived"]);
    document.getElementById("codexLines").replaceChildren(
      ...lines.map(([text, label]) => {
        const p = document.createElement("p");
        p.className = "tl-line";
        p.textContent = text;
        const tag = document.createElement("span");
        tag.className = "tag-badge good";
        tag.textContent = label;
        p.append(" ", tag);
        return p;
      })
    );
    card.hidden = false;
  } catch {
    card.hidden = true;
  }
}
initCodex();

// ---- Accounts (I4): each Claude account's plan usage from its own folder and its own calibration, and which has headroom. Text only.
async function initPlanner() {
  const card = document.getElementById("plannerCard");
  try {
    const res = await fetch("/api/planner", { cache: "no-store" });
    const p = await res.json();
    if (!res.ok || p.error || !Array.isArray(p.accounts) || !p.accounts.length) throw new Error("none");
    const dur = (m) => (m == null ? "?" : m >= 1440 ? `${(m / 1440).toFixed(1)}d` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`);
    const win = (name, w) => {
      if (!w) return `${name}: no estimate yet`;
      const verdict = w.minutesToLimit == null ? "" : w.lastsUntilReset ? ", lasts until the reset" : `, runs out in about ${dur(w.minutesToLimit)}, before the reset`;
      return `${name} ${w.pct}% used, resets in ${dur(w.resetsInMin)}${w.ratePctPerHour != null ? `, burning ${w.ratePctPerHour}% an hour` : ""}${verdict}`;
    };
    document.getElementById("plannerIntro").textContent = p.accounts.length === 1
      ? "One Claude account on this machine, so there is nothing to choose between. Each account has its own limits and its own calibration."
      : `${p.accounts.length} Claude accounts on this machine. Each has its own limits and its own calibration (sparelimit calibrate --account=...).`;
    const lines = p.accounts.map((a) => [`${a.label}${a.plan ? ` (${a.plan})` : ""}: ${a.calibratedPoints ? `${win("5-hour", a.fiveHour)}; ${win("weekly", a.weekly)}.` : "not calibrated yet, so no estimate."}`, a.calibratedPoints ? "estimated" : "not calibrated"]);
    if (p.mostHeadroom) lines.push([`Most headroom now: ${p.mostHeadroom}.${p.nearLimit && p.nearLimit.length ? ` Do not switch into ${p.nearLimit.join(", ")}: its 5-hour window is 80% used or more.` : ""}`, "estimated"]);
    document.getElementById("plannerLines").replaceChildren(
      ...lines.map(([text, label]) => {
        const el = document.createElement("p");
        el.className = "tl-line";
        el.textContent = text;
        const tag = document.createElement("span");
        tag.className = `tag-badge ${label === "estimated" ? "warn" : ""}`;
        tag.textContent = label;
        el.append(" ", tag);
        return el;
      })
    );
    card.hidden = false;
  } catch {
    card.hidden = true;
  }
}
initPlanner();

// ---- History card (sparelimit history, sparelimit drains, sparelimit files). textContent only; every figure is derived or estimated and says which.
async function loadHistoryCard() {
  const tag = document.getElementById("historyTag");
  const intro = document.getElementById("historyIntro");
  try {
    const res = await fetch("/api/history", { cache: "no-store" });
    const h = await res.json();
    if (!res.ok || h.error) throw new Error(h.error || "failed");
    const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
    tag.textContent = "DERIVED";
    tag.className = "tag-badge good";
    intro.textContent = `${usd(h.totalUSD)} at list price over ${h.sessions} sessions.`;
    const lines = [];
    lines.push(["By week (from Monday)", h.weekly.map((w) => `${w.weekStart} ${usd(w.usd)}`).join(" · ") || "no spend"]);
    lines.push(["Costliest projects", h.projects.slice(0, 5).map((p) => `${p.project} ${usd(p.usd)}`).join(" · ") || "none"]);
    lines.push(["Top causes (each on its own; they overlap and are not added up)", h.causes.slice(0, 5).map((c) => `${c.title} ${usd(c.usd)} [${c.confidence}]`).join("; ") || "none stand out"]);
    const extra = async (path) => {
      try {
        const r = await fetch(path, { cache: "no-store" });
        const j = await r.json();
        return r.ok && !j.error ? j : null;
      } catch {
        return null;
      }
    };
    const [dr, fl] = await Promise.all([extra("/api/drains"), extra("/api/files")]);
    if (dr?.rows?.length) lines.push(["Spend on turns you did not type, all logs (where it came from, not a verdict)", `${usd(dr.unpromptedUSD)}: ${dr.rows.map((r) => `${r.label} ${usd(r.usd)}`).join("; ")} [derived]`]);
    if (fl?.files?.length) lines.push(["Files that cost the most to read, all logs", `${fl.files.slice(0, 5).map((f) => `${f.name} ${usd(f.carryUSD)}${f.flag ? " (read whole, often)" : ""}`).join("; ")} [estimated]`]);
    const body = document.getElementById("historyBody");
    body.replaceChildren();
    for (const [label, text] of lines) {
      const row = document.createElement("div");
      row.className = "coach-row";
      const head = document.createElement("strong");
      head.textContent = label;
      const sub = document.createElement("div");
      sub.className = "coach-sub";
      sub.textContent = text;
      row.append(head, sub);
      body.append(row);
    }
    document.getElementById("historyNote").textContent = h.note;
  } catch (e) {
    tag.textContent = "UNAVAILABLE";
    tag.className = "tag-badge critical";
    intro.textContent = "No Claude Code history found to build this from. Run `sparelimit history` in a terminal for details.";
  }
}
loadHistoryCard();
