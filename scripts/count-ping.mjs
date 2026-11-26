// The one request the optional count makes: an ordinary download of a one-byte file from the release, like a person downloading it.
// No request body, no custom headers, no identifier. It takes a word ("opted-in" or "saving"), never an address, so nothing else can be
// requested through it. Started detached by `sparelimit` after you said yes, it never reports back: a failed request is dropped, with no retry.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNT_ADDRESSES } from "../src/countaddresses.mjs";

export const TIMEOUT_MS = 5000;

/** @returns {Promise<boolean>} whether the file was downloaded; never throws */
export async function ping(kind, fetchImpl = fetch) {
  const url = Object.hasOwn(COUNT_ADDRESSES, kind) ? COUNT_ADDRESSES[kind] : null;
  if (!url) return false;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await ping(process.argv[2]);
