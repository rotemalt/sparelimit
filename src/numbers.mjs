// @ts-check
/**
 * The author's published numbers: one snapshot of the ledger on one machine (`site/numbers.json`), and the block of the product page that
 * shows it. What a person reads on the page and what is in the file cannot differ: the block is made from the file and a test compares
 * them. `npm run snapshot` refreshes both.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addsUp, breakdownEquation } from "./breakdown.mjs";
import { LEDGER_RULES_VERSION } from "./ledger.mjs";

export const NUMBERS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "numbers.json");
export const NUMBERS_FORMAT = "sparelimit-numbers/1";
/** Every public figure says what it is a sample of. */
export const SCOPE = "one machine, one person, first weeks of use";

/**
 * @param {ReturnType<import("./week.mjs").buildWeek>} w a summary built with days = 0
 * @param {string} date YYYY-MM-DD
 */
export function buildNumbers(w, date) {
  const rate = w.actedOn.value + w.ignored.value ? Math.round((w.actedOn.value / (w.actedOn.value + w.ignored.value)) * 100) : null;
  const ig = w.notCounted.find((x) => x.reason === "ignored");
  const items = [
    { id: "alerts", text: "Alerts that fired", value: w.alerts.value, unit: "alerts", label: w.alerts.label },
    { id: "acted-on", text: "Alerts acted on", value: w.actedOn.value, unit: "alerts", label: w.actedOn.label },
    { id: "ignored", text: "Alerts ignored", value: w.ignored.value, unit: "alerts", label: w.ignored.label },
    { id: "acted-on-rate", text: "Acted on, out of the alerts where acting or not could be told", value: rate, unit: "percent", label: "derived" },
    { id: "counted-saving", text: "Counted saving", value: w.counted.savingUSD, unit: "USD at list price", label: w.counted.label },
    { id: "ignored-predicted", text: "What the ignored alerts predicted, which was not saved", value: ig?.predictedUSD ?? 0, unit: "USD at list price", label: "estimated" }
  ];
  return { format: NUMBERS_FORMAT, as_of: date, scope: SCOPE, rules_version: w.rulesVersion, period: "everything on that machine up to", items, breakdown: { total: w.breakdown.total, parts: w.breakdown.parts, label: "derived" }, notCounted: w.notCounted.map((x) => ({ id: x.reason, n: x.n, text: x.why })) };
}

/** Everything wrong with a snapshot; empty when it is sound. */
export function validateNumbers(/** @type {any} */ n) {
  /** @type {string[]} */
  const bad = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ what) => { if (!ok) bad.push(what); };
  need(n?.format === NUMBERS_FORMAT, `format must be ${NUMBERS_FORMAT}`);
  need(/^\d{4}-\d{2}-\d{2}$/.test(n?.as_of || ""), "as_of must be a date");
  need(/one machine, one person/.test(n?.scope || ""), "scope must say one machine, one person");
  need(n?.rules_version === LEDGER_RULES_VERSION, `rules_version must be the ledger's current rules version (${LEDGER_RULES_VERSION}); refresh the numbers if the rules changed`);
  for (const i of n?.items || []) need(["exact", "derived", "estimated"].includes(i.label) && !!i.id && "value" in i, `number ${i.id || "?"} needs id, value and a label`);
  need(addsUp(n?.breakdown) && n.breakdown.total === n.items?.find((/** @type {any} */ i) => i.id === "alerts")?.value, "breakdown must add up to the alerts that fired");
  need(!!n?.complaints && "value" in n.complaints && !!n.complaints.text, "complaints needs a value and a text");
  return bad;
}

const esc = (/** @type {unknown} */ s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The block of `site/index.html` between the two markers. */
export function renderNumbersHtml(/** @type {any} */ n) {
  const rows = n.items.map((/** @type {any} */ i) => {
    const v = i.unit.startsWith("USD") ? money(i.value) : i.value == null ? "not known" : `${i.value}${i.unit === "percent" ? "%" : ""}`;
    return `        <tr><th scope="row">${esc(i.text)}</th><td class="num" data-n="${esc(i.id)}">${esc(v)}</td><td><span class="chip ${esc(i.label)}">${esc(i.label)}</span></td></tr>`;
  });
  const not = n.notCounted.map((/** @type {any} */ f) => `        <li><b data-n="not-${esc(f.id)}">${esc(f.n)}</b> ${esc(f.id)}: ${esc(f.text)}</li>`);
  return [
    `      <p class="asof">The author's own numbers, with Claude Code: ${esc(n.scope)}. ${esc(n.period[0].toUpperCase() + n.period.slice(1))} ${esc(n.as_of)}. Not a forecast, and not from other people.</p>`,
    `      <table class="figures">`,
    `        <thead><tr><th scope="col">What</th><th scope="col">Number</th><th scope="col">How sure</th></tr></thead>`,
    `        <tbody>`,
    ...rows,
    `        </tbody>`,
    `      </table>`,
    `      <p class="asof">Rules version <b data-n="rules-version">${esc(n.rules_version)}</b>: every rule and threshold the ledger uses is in <a href="https://github.com/rotemalt/sparelimit/blob/main/docs/RULES.md">docs/RULES.md</a>.</p>`,
    `      <p class="equation">Where the ${esc(n.breakdown.total)} alerts went: <b data-n="breakdown">${esc(breakdownEquation(n.breakdown))}</b> <span class="chip ${esc(n.breakdown.label)}">${esc(n.breakdown.label)}</span></p>`,
    `      <h3>Not counted, and why</h3>`,
    `      <ul class="fails">`,
    ...not,
    `      </ul>`,
    `      <p class="asof">Complaints received: <b data-n="complaints">${esc(n.complaints.value)}</b> (${esc(n.complaints.text)}), as of ${esc(n.complaints.as_of)}.</p>`
  ].join("\n");
}
