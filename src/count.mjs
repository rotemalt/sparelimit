// @ts-check
/**
 * The optional count. Off unless you say yes. After a yes, `sparelimit` downloads one tiny file from the release on GitHub: once when you opt
 * in, and at most once a day when a saving has been counted. GitHub keeps a download count for each file; that total is all the author
 * ever sees. This file decides when; it opens no connection itself (scripts/count-ping.mjs does, with two fixed addresses).
 *
 * Rules: nothing is asked or requested unless both the keyboard and the screen are a terminal and this is not CI. The offer is made once,
 * after the first `sparelimit replay` or `sparelimit week` that ran to the end (or when `sparelimit ledger` shows a counted saving); "not now" is asked once
 * more after 30 days; "never" (or "no") is never asked again. Nothing here may ever break or slow a command.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { readJson, stateDir, writeJsonAtomic } from "./state.mjs";
import { LEDGER } from "./ledger.mjs";

export const LATER_DAYS = 30;
const DAY = 86400e3;
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "count-ping.mjs");

/** The words of the offer. The README section and the privacy page say the same things. */
export const OFFER_TEXT = [
  "",
  "One question, asked once: may Sparelimit be counted?",
  "If you say yes, Sparelimit downloads one tiny file from GitHub once now, and at most once a day when it counts a saving, so the author can",
  "see from GitHub's own download counter that people use it. Nothing about you or your work is sent to the author: no name, no path, no",
  "project, no time of work, and no identifier exists. GitHub sees your address, as it does for any download. The totals are public and",
  "approximate. Sparelimit works the same either way. Off unless you say yes. (`sparelimit count show` prints the two addresses.)",
  ""
].join("\n");
export const QUESTION = "Count it? Type yes, not now, or never: ";

/** @typedef {{ answer: null | "yes" | "later" | "never" | "off", askedAt: string | null, asked: number, yesAt: string | null, optInRequested: boolean, savingDay: string | null, seen: string[] }} CountState */

export const countFile = () => path.join(stateDir(), "count.json");

/** @returns {CountState} anything unreadable or unknown reads as "no answer", which requests nothing */
export function readCount() {
  const c = readJson(countFile(), null) || {};
  return {
    answer: ["yes", "later", "never", "off"].includes(c.answer) ? c.answer : null,
    askedAt: typeof c.askedAt === "string" ? c.askedAt : null,
    asked: Number.isInteger(c.asked) && c.asked > 0 ? c.asked : 0,
    yesAt: typeof c.yesAt === "string" ? c.yesAt : null,
    optInRequested: c.optInRequested === true,
    savingDay: typeof c.savingDay === "string" ? c.savingDay : null,
    seen: Array.isArray(c.seen) ? c.seen.filter((/** @type {any} */ s) => typeof s === "string") : []
  };
}

export const saveCount = (/** @type {CountState} */ s) => writeJsonAtomic(countFile(), s);

/** A person at a terminal: not piped, not CI, not a hook (a hook's input is a pipe). */
export function isInteractive({ stdin = process.stdin, stdout = process.stdout, env = process.env } = /** @type {any} */ ({})) {
  return !!stdin.isTTY && !!stdout.isTTY && !env.CI && !env.GITHUB_ACTIONS;
}

/** Whether to make the offer now. `moment` is true when something worth asking after has just happened. @param {CountState} s */
export function shouldOffer(s, { now = Date.now(), moment = false } = {}) {
  if (!moment) return false;
  if (s.answer === null) return s.asked === 0;
  if (s.answer !== "later" || s.asked !== 1 || !s.askedAt) return false;
  return now - Date.parse(s.askedAt) >= LATER_DAYS * DAY;
}

/** What the person typed. Only a clear yes is a yes; "no" is taken as never; anything else, and nothing, is "not now". */
export function parseAnswer(/** @type {unknown} */ typed) {
  const a = String(typed ?? "").trim().toLowerCase();
  if (a === "yes" || a === "y") return "yes";
  if (a === "never" || a === "no" || a === "n") return "never";
  return "later";
}

const savingId = (/** @type {any} */ e) => `${e.at}|${e.family}`;
const savingsIn = (/** @type {any[]} */ entries) => (entries || []).filter((e) => e.status === "counted" && e.savingUSD > 0);

/** A yes: remember when, and treat the savings that already exist as seen, so only new ones are counted afterwards. @param {CountState} s */
export function sayYes(s, { now = Date.now(), entries = /** @type {any[]} */ ([]) } = {}) {
  return { ...s, answer: /** @type {const} */ ("yes"), yesAt: new Date(now).toISOString(), seen: [...new Set([...s.seen, ...savingsIn(entries).map(savingId)])].slice(-1000) };
}

/**
 * What is due now, and the state afterwards. At most: the opt-in file once ever, and the saving file once a day, and only when a saving
 * that was not seen before has been counted since the yes.
 * @param {CountState} s
 * @returns {{ kinds: ("opted-in"|"saving")[], state: CountState }}
 */
export function due(s, { now = Date.now(), entries = /** @type {any[]} */ ([]) } = {}) {
  if (s.answer !== "yes") return { kinds: [], state: s };
  /** @type {("opted-in"|"saving")[]} */
  const kinds = [];
  const state = { ...s };
  if (!state.optInRequested) {
    kinds.push("opted-in");
    state.optInRequested = true;
  }
  // an alert can be counted some hours after it fired, so one that fired just before the yes still counts as new
  const since = Date.parse(state.yesAt || "") - LEDGER.pendingHours * 3600e3;
  const fresh = savingsIn(entries).filter((e) => !state.seen.includes(savingId(e)) && !(Date.parse(e.at) < since));
  if (fresh.length) {
    state.seen = [...state.seen, ...fresh.map(savingId)].slice(-1000);
    const today = new Date(now).toISOString().slice(0, 10);
    if (state.savingDay !== today) {
      kinds.push("saving");
      state.savingDay = today;
    }
  }
  return { kinds, state };
}

/** Starts the download and returns at once. Nothing waits for it and nothing it does is reported. */
export function send(/** @type {"opted-in"|"saving"} */ kind, spawnImpl = spawn) {
  try {
    const child = spawnImpl(process.execPath, [SCRIPT, kind], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
  } catch { /* a request that cannot start is dropped */ }
}

/** Asks at the terminal. End of input or Ctrl-D reads as nothing typed. @returns {Promise<string>} */
export function askTerminal(question = QUESTION) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (/** @type {string} */ a) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(a);
    };
    rl.on("close", () => finish(""));
    rl.question(question, finish);
  });
}

/**
 * Called after `sparelimit replay`, `sparelimit week` and `sparelimit ledger` have printed. Makes the offer if it is due, then requests what is due. Never
 * throws. `ran` is true when a replay or a weekly summary has just run to the end: that is enough to be asked. Otherwise a counted saving
 * is the moment. `mayAsk` is false for output meant for a machine or a screenshot (--json, --share): nothing is asked there.
 * @param {{ entries: any[], ran?: boolean, interactive?: boolean, mayAsk?: boolean, now?: number, ask?: () => Promise<string>, request?: (k: "opted-in"|"saving") => void, print?: (s: string) => void }} p
 */
export async function afterReport({ entries, ran = false, interactive = isInteractive(), mayAsk = true, now = Date.now(), ask = askTerminal, request = send, print = console.log }) {
  try {
    if (!interactive) return;
    let s = readCount();
    if (mayAsk && shouldOffer(s, { now, moment: ran || savingsIn(entries).length > 0 })) {
      // written down before the question, so that closing the terminal here does not mean being asked every time
      s = { ...s, answer: "later", asked: s.asked + 1, askedAt: new Date(now).toISOString() };
      saveCount(s);
      print(OFFER_TEXT);
      const answer = parseAnswer(await ask());
      if (answer === "yes") s = sayYes(s, { now, entries });
      else s = { ...s, answer };
      saveCount(s);
      print(answer === "yes" ? "Counting is on. `sparelimit count off` turns it off." : answer === "never" ? "Not counting, and you will not be asked again. `sparelimit count on` turns it on if you change your mind." : "Not counting. You can turn it on any time with `sparelimit count on`.");
    }
    const { kinds, state } = due(s, { now, entries });
    if (state !== s) saveCount(state);
    for (const k of kinds) request(k);
  } catch { /* the count must never break a command */ }
}
