/**
 * `sparelimit count`: the optional count (src/count.mjs). Off unless you say yes.
 *   sparelimit count [status]   on or off, and what has been requested
 *   sparelimit count show       exactly what would be requested (two file addresses); requests nothing
 *   sparelimit count on         say yes
 *   sparelimit count off        say off: nothing more is requested
 */
import { COUNT_ADDRESSES } from "../countaddresses.mjs";
import { countFile, due, isInteractive, readCount, sayYes, saveCount, send } from "../count.mjs";

const WHAT = "Nothing about you or your work is sent to the author, and no identifier exists. GitHub sees your address, as it does for any\ndownload. The totals are public and approximate. Sparelimit works the same either way.";

/** @type {Record<string, (args: string[]) => Promise<void>>} */
export const commands = {
  "count": async (args) => {
    const sub = args[1] && !args[1].startsWith("-") ? args[1] : "status";
    const s = readCount();
    if (sub === "show") {
      console.log(`When counting is on, these two addresses are the only things requested, as ordinary downloads of a one-byte file:\n  once, after you say yes:                        ${COUNT_ADDRESSES["opted-in"]}\n  at most once a day, when a saving was counted:  ${COUNT_ADDRESSES.saving}\n${WHAT}\nThis command requests nothing.`);
      return;
    }
    if (sub === "status") {
      console.log(s.answer === "yes" ? "The optional count is ON." : "The optional count is OFF.");
      if (s.answer === "yes") console.log(`Said yes: ${s.yesAt?.slice(0, 10)}. Opt-in file requested: ${s.optInRequested ? "yes" : "not yet"}. Last saving request: ${s.savingDay || "none"}.`);
      else console.log(s.answer === "never" ? "You said never: you will not be asked again." : s.answer === "off" ? "You turned it off: you will not be asked." : s.answer === "later" ? "You said not now." : "You have not been asked.");
      console.log(`${WHAT}\nChange it with \`sparelimit count on\` or \`sparelimit count off\`. Your answer is kept in ${countFile()}.`);
      return;
    }
    if (sub === "on") {
      const yes = sayYes(s);
      if (!isInteractive()) {
        saveCount(yes);
        console.log("Counting is on. Nothing was requested now, because this is not an interactive terminal: it happens the next time you run `sparelimit week` or `sparelimit ledger` in one.");
        return;
      }
      const { kinds, state } = due(yes);
      saveCount(state);
      for (const k of kinds) send(k);
      console.log(`Counting is on. ${WHAT}\n\`sparelimit count show\` prints the addresses; \`sparelimit count off\` turns it off.`);
      return;
    }
    if (sub === "off") {
      saveCount({ ...s, answer: "off" });
      console.log("Counting is off. Nothing more will be requested, and you will not be asked.");
      return;
    }
    console.error(`sparelimit count: "${sub}" is not a command. Use: sparelimit count status | show | on | off`);
    process.exit(1);
  }
};
