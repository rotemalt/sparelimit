/**
 * Shareable report card (D8): one image (SVG, 1200 x 630, the size social sites show) and one self-contained HTML page, from the same
 * data as `sparelimit coach`. It carries no prompts, no project names and no paths: only totals, shares and the labels Sparelimit puts on every
 * number. `hideDollars` shows shares only (for a client or a post where the amounts are private).
 */
const esc = (/** @type {any} */ t) => String(t).replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd0 = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;

/** @param {{ habits: any, spend: any, date?: Date, hideDollars?: boolean }} p */
export function buildCard({ habits, spend, date = new Date(), hideDollars = false }) {
  const total = (spend.cacheReadUSD || 0) + (spend.cacheWriteUSD || 0) + (spend.outputUSD || 0) + (spend.inputUSD || 0);
  const share = (/** @type {any} */ x) => (total ? Math.round((x / total) * 100) : 0);
  const resend = share(spend.cacheReadUSD || 0);
  const output = share(spend.outputUSD || 0);
  const rows = [
    { key: "resend", label: "Re-sending the conversation", pct: resend },
    { key: "fresh", label: "Adding new content to it", pct: Math.max(0, 100 - resend - output) },
    { key: "write", label: "What the AI writes", pct: output }
  ];
  const changes = [...(habits.savings || []), ...(habits.atStake || [])]
    .filter((h) => h.shareOfSpend >= 1)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 3)
    .map((h) => ({ title: h.title.length > 74 ? h.title.slice(0, 74).replace(/\s+\S*$/, "") + "..." : h.title, sharePct: Math.round(h.shareOfSpend), usd: Math.round(h.usd), confidence: h.confidence, kind: h.kind === "saving" ? "could save" : "at stake" }));
  return {
    date: new Date(date).toISOString().slice(0, 10),
    sessions: habits.sessions,
    weeks: habits.weeks,
    totalUSD: hideDollars ? null : Math.round(habits.totalUSD),
    startContextPct: share(spend.startContextUSD || 0),
    split: rows,
    changes,
    hideDollars,
    note: "Dollars are API-equivalent at list price. 'Could save' rows are modelled and overlap; 'at stake' rows are spend in an area, not a saving."
  };
}

const COLORS = { bg: "#0a111c", fg: "#e8eef7", muted: "#93a3b8", blue: "#7b97ff", cyan: "#4cc9f0", green: "#6ee7a0", line: "#243247" };
const SPLIT_COLORS = [COLORS.blue, COLORS.cyan, COLORS.green];

export function renderCardSvg(/** @type {any} */ c) {
  const W = 1200;
  const barX = 60;
  const barW = 1080;
  let x = barX;
  const bars = c.split.map((/** @type {any} */ s, /** @type {any} */ i) => {
    const w = Math.round((s.pct / 100) * barW);
    const seg = `<rect x="${x}" y="196" width="${w}" height="34" fill="${SPLIT_COLORS[i]}"/>`;
    x += w;
    return seg;
  }).join("");
  const legend = c.split.map((/** @type {any} */ s, /** @type {any} */ i) => `<g transform="translate(${60 + i * 370} 262)"><rect width="16" height="16" y="-13" fill="${SPLIT_COLORS[i]}"/><text x="26" class="cap">${esc(s.pct)}% ${esc(s.label)}</text></g>`).join("");
  const changes = c.changes.map((/** @type {any} */ h, /** @type {any} */ i) => `<g transform="translate(60 ${388 + i * 60})"><text class="pc">${esc(h.sharePct)}%</text><text x="110" class="ch">${esc(h.title)}</text><text x="110" y="26" class="cap">${esc(h.kind)}${c.hideDollars ? "" : ` ${esc(usd0(h.usd))}`} · ${esc(h.confidence)}</text></g>`).join("");
  const head = c.hideDollars ? `${esc(c.sessions)} sessions over ${esc(c.weeks)} weeks` : `${esc(usd0(c.totalUSD))} over ${esc(c.sessions)} sessions and ${esc(c.weeks)} weeks`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 630" width="${W}" height="630" role="img" aria-label="Where my AI coding spend goes: ${c.split[0].pct} percent re-sending the conversation">
<style>text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;fill:${COLORS.fg}}.h{font-size:44px;font-weight:700}.sub{font-size:22px;fill:${COLORS.muted}}.cap{font-size:18px;fill:${COLORS.muted}}.pc{font-size:38px;font-weight:700;fill:${COLORS.blue}}.ch{font-size:22px}.sec{font-size:16px;letter-spacing:.12em;fill:${COLORS.muted}}</style>
<rect width="${W}" height="630" fill="${COLORS.bg}"/>
<text x="60" y="84" class="h">Where my AI coding spend goes</text>
<text x="60" y="124" class="sub">${head}</text>
<text x="60" y="180" class="sec">THE SPLIT</text>
${bars}${legend}
<text x="60" y="342" class="sec">WHAT TO CHANGE, LARGEST FIRST</text>
${changes}
<line x1="60" x2="1140" y1="552" y2="552" stroke="${COLORS.line}"/>
<text x="60" y="582" class="cap">Read from my own session logs by Sparelimit on ${esc(c.date)}.</text>
<text x="60" y="608" class="cap">${esc(c.note)}</text>
</svg>`;
}

export function renderCardHtml(/** @type {any} */ c) {
  const svg = renderCardSvg(c);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My AI coding spend: report card</title>
<style>body{margin:0;background:#0a111c;color:#e8eef7;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:1200px;width:100%}svg{width:100%;height:auto;display:block;border-radius:12px}p{color:#93a3b8;font-size:14px}</style></head>
<body><main>${svg}<p>Made with Sparelimit from local session logs. No prompts, project names or paths are in this page.</p></main></body></html>
`;
}
