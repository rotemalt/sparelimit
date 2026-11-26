// @ts-check
/**
 * The only two addresses the optional count ever requests. They are fixed here, written out in full, and a test pins them: each is a
 * one-byte file attached to the release on GitHub, and GitHub keeps a download count for it. A new release means new addresses.
 */
export const COUNT_ADDRESSES = Object.freeze({
  "opted-in": "https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/count-opted-in",
  saving: "https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/count-saving"
});
