import test from "node:test";
import assert from "node:assert/strict";
import { buildFileHygiene } from "../src/files.mjs";

const f = (file, o = {}) => ({ file, reads: 1, wholeReads: 1, tokens: 1000, largestReadTokens: 1000, carryUSD: 0.5, ...o });

test("files are summed across sessions, ranked by what carrying them cost, and the big whole-file reads are flagged", () => {
  const r = buildFileHygiene([
    { files: [f("/p/src/big.js", { reads: 3, wholeReads: 3, tokens: 30000, largestReadTokens: 10000, carryUSD: 4 }), f("/p/src/small.js", { carryUSD: 1 })] },
    { files: [f("/p/src/big.js", { reads: 1, wholeReads: 0, tokens: 2000, largestReadTokens: 2000, carryUSD: 1 })] },
    {}
  ]);
  assert.deepEqual(r.files.map((x) => [x.name, x.sessions, x.reads, x.carryUSD, x.flag]), [["src/big.js", 2, 4, 5, "read whole, often"], ["src/small.js", 1, 1, 1, null]]);
  assert.equal(r.flagged, 1);
  assert.equal(r.confidence, "estimated");
});

test("a big file read once whole, or often by range, is not flagged; no sessions is an empty list", () => {
  const r = buildFileHygiene([{ files: [f("/a/once.js", { largestReadTokens: 20000, wholeReads: 1 }), f("/a/ranged.js", { largestReadTokens: 20000, wholeReads: 0, reads: 9 })] }]);
  assert.equal(r.flagged, 0);
  assert.deepEqual(buildFileHygiene([]).files, []);
});
