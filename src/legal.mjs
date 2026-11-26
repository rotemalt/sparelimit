// @ts-check
/**
 * The privacy page and the terms of use, written once. `node scripts/build-legal.mjs` makes `site/privacy.html`, `site/terms.html`,
 * `docs/PRIVACY.md` and `docs/TERMS.md` from this file, and a test fails if any of them differs. Change the date when you change the words.
 */
export const LEGAL_DATE = "2026-11-26";
export const CONTACT = "rotem.alt.verarail@gmail.com";
export const OWNER = "Rotem Alt";
export const NOT_AFFILIATED = "Sparelimit is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google, Anysphere (Cursor) or the makers of any other tool it names. Claude, Claude Code, Codex, Gemini, Cursor and other names are trademarks of their owners, and are used only to say what Sparelimit reads or is compared with.";

/** @typedef {{ h: string, p?: string[], ul?: string[] }} Part */
/** @typedef {{ title: string, lead: string, parts: Part[] }} Doc */

/** @type {Doc} */
export const PRIVACY = {
  title: "Privacy",
  lead: "Sparelimit runs on your machine and sends nothing anywhere by itself. This page says what it reads, what it writes, what can leave your machine because of something you do, and what the website and the project see.",
  parts: [
    { h: "Who runs this", p: [`${OWNER} publishes Sparelimit. Write to ${CONTACT} about anything on this page.`] },
    { h: "What the tool reads", ul: [
      "The session logs your coding agent already writes on your disk (Claude Code, including the Desktop app's agent sessions; Codex CLI; Gemini CLI; Cursor's chat database; Antigravity in part). These logs can hold your prompts, your code, file paths and other people's information.",
      "Account details your agent keeps locally, when you use the account views: a one-way hash of the account or organisation id, the organisation name and the plan type. The email address is never read.",
      "The plan-usage record the Claude Desktop app keeps, when you ask for it."
    ] },
    { h: "What the tool writes, all on your machine", ul: [
      "A folder `~/.sparelimit`: your settings, the log of the warnings it showed, caches of numbers, session ids, project folder paths, tool names and warning messages. The caches hold no prompt text.",
      "In a project folder, when the feature is used: `.sparelimit-status.json`, `.sparelimit-handoff.md` (a note for a fresh conversation, which can contain your last request), `.sparelimit-muzzle.sh`, `.sparelimit-freeze.json`, and report or picture files you ask for.",
      "Entries in your agent's settings file, only if you run `sparelimit init --apply`. `sparelimit init` first shows them.",
      "Before a handoff, a status file or an export carries your text, well-known shapes of passwords and keys are hidden. A secret with no known shape is not found."
    ] },
    { h: "What can leave your machine", p: ["Sparelimit itself opens no connection to the internet. These things move information because you chose them:"], ul: [
      "Warnings that Sparelimit hands to your AI tool, answers it gives that tool through `sparelimit mcp`, and a handoff you paste: they become part of your conversation, and go to that tool's provider under its terms.",
      "`sparelimit sync` writes a file of daily totals into a folder you choose. If another service copies that folder, that service moves the file. It holds totals, model names, account keys and the device name, never prompts or paths.",
      "`npm run update-pricing`, a script you run by hand from the source, downloads a public price list from GitHub.",
      "Installing or updating downloads files from GitHub or npm, under their terms.",
      "Anything you post yourself, such as a weekly summary in an issue."
    ] },
    { h: "The local dashboard", p: ["`sparelimit serve` shows a page at 127.0.0.1, reachable from your own machine only. It refuses requests that another website starts. It can show prompt text and local paths, so do not share your screen or a screenshot of it."] },
    { h: "The website", ul: [
      "It has no forms, no cookies, no analytics and no third-party scripts or fonts.",
      "It keeps one thing in your browser's local storage: whether you chose the bright or the dark theme. Clearing your browser data removes it.",
      "It is served by a hosting company (GitHub Pages), which receives your IP address and request details as any web host does, under its own privacy statement."
    ] },
    { h: "The project on GitHub", p: ["Issues, discussions and pull requests are public. Do not put personal or private information in them. GitHub handles them under its own privacy statement. The author can see the repository's traffic totals, stars and watchers that GitHub shows to owners."] },
    { h: "If you write to the author", p: ["Your email address and what you write are used to answer you, are not sold or shared, and are deleted when you ask, unless the law requires keeping them."] },
    { h: "Your choices and rights", p: [`Everything the tool stores is on your machine: you can read it and delete it. \`sparelimit init --uninstall\` takes out what it added to your agent's settings, and saves a backup of the file first. For anything the author holds (emails you sent), write to ${CONTACT} to see, correct or delete it. Depending on where you live, you may also be able to complain to a data protection authority.`] },
    { h: "Changes", p: ["If this page changes, the date above changes, and the change is visible in the repository's history."] }
  ]
};

/** @type {Doc} */
export const TERMS = {
  title: "Terms of use",
  lead: "Sparelimit is free, open-source software. These terms say what you can expect from it. They add to the MIT licence and take away none of the rights it gives you.",
  parts: [
    { h: "Who offers it", p: [`${OWNER} publishes Sparelimit. Contact: ${CONTACT}. There is nothing to pay and there are no paid features.`] },
    { h: "The licence", p: ["The code is released under the MIT licence (the file LICENSE). You may use, copy, change and share it under that licence. Parts made by others keep their own licences (the file THIRD_PARTY_NOTICES.md)."] },
    { h: "No warranty", p: ["Sparelimit is provided as is, without warranty of any kind. It may contain errors, stop working, or read a log format wrongly when another tool changes it."] },
    { h: "The numbers are not advice or a bill", p: ["Figures are labelled exact, derived or estimated. Dollars are what the same usage would cost at public list prices, not what you were charged. A counted saving is not proof that a warning caused it. Nothing here is financial, legal or professional advice. Check anything you rely on against your provider's own records."] },
    { h: "It can act in your tools", p: ["If you install its hooks, Sparelimit can show warnings and can stop an action your AI tool is about to take, according to the thresholds in force. You decide whether to install it and which settings to use. Keep your own backups. Review any command or file it writes before you rely on it."] },
    { h: "Your responsibility for your data", p: ["The logs it reads can hold other people's information, a client's or an employer's. Use it only on data you are allowed to process, and read anything before you share it."] },
    { h: "Other companies", p: [NOT_AFFILIATED, "Your use of other companies' tools stays under their terms."] },
    { h: "Limit of liability", p: ["To the fullest extent the law allows, the author is not liable for any loss or damage arising from the use of Sparelimit or the inability to use it. Nothing here limits a liability or a right that the law does not allow to be limited."] },
    { h: "Changes", p: ["These terms may change. The date above shows when they last did. A version of the software you already have stays under the licence it came with."] }
  ]
};

const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (/** @type {string} */ s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").split(CONTACT).join(`<a href="mailto:${CONTACT}">${CONTACT}</a>`);

export function renderMarkdown(/** @type {Doc} */ d) {
  return [`<!-- Generated by \`node scripts/build-legal.mjs\` from src/legal.mjs. Do not edit by hand. -->`, `# ${d.title}`, "", `Last changed ${LEGAL_DATE}.`, "", d.lead, "",
    ...d.parts.flatMap((x) => [`## ${x.h}`, "", ...(x.p || []).flatMap((t) => [t, ""]), ...(x.ul ? [...x.ul.map((t) => `- ${t}`), ""] : [])])].join("\n");
}

export function renderHtml(/** @type {Doc} */ d) {
  return `<!doctype html>
<html lang="en" data-theme="light"><head><script>try{document.documentElement.dataset.theme=localStorage.getItem("sparelimit-theme")==="dark"?"dark":"light"}catch(e){}</script><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)} · sparelimit</title>
<style>
:root,[data-theme="light"]{color-scheme:light;--paper:#f4f7ff;--ink:#0a1230;--muted:#4a5878;--blue:#1f4bff;--line:#d5dcf2}
[data-theme="dark"]{color-scheme:dark;--paper:#0a111c;--ink:#e8eef7;--muted:#93a3b8;--blue:#7b97ff;--line:#243247}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:36px 24px 72px}
a{color:var(--blue);overflow-wrap:anywhere} .logo{font:700 26px ui-serif,"New York",Georgia,serif;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
h1{font:700 clamp(36px,7vw,54px)/1.05 ui-serif,"New York",Georgia,serif;letter-spacing:-.03em;margin:40px 0 8px}
h2{font:700 21px/1.3 ui-serif,"New York",Georgia,serif;margin:30px 0 6px}
p,li{color:var(--muted)} p{margin:0 0 12px} li{margin:0 0 6px} code{font:15px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
</style></head>
<body><main>
<a class="logo" href="./">sparelimit.</a>
<h1>${esc(d.title)}</h1>
<p>Last changed ${LEGAL_DATE}.</p>
<p>${inline(d.lead)}</p>
${d.parts.map((x) => `<h2>${esc(x.h)}</h2>\n${(x.p || []).map((t) => `<p>${inline(t)}</p>`).join("\n")}${x.ul ? `\n<ul>\n${x.ul.map((t) => `<li>${inline(t)}</li>`).join("\n")}\n</ul>` : ""}`).join("\n")}
<p style="margin-top:36px"><a href="./">Back to the site</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>
</main></body></html>
`;
}

/** The generated files, by path from the repository root. */
export const LEGAL_FILES = () => ({ "site/privacy.html": renderHtml(PRIVACY), "site/terms.html": renderHtml(TERMS), "docs/PRIVACY.md": renderMarkdown(PRIVACY), "docs/TERMS.md": renderMarkdown(TERMS) });
