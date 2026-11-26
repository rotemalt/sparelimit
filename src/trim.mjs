/**
 * Output trimming (X14): the pure part. A Bash tool's response is { stdout, stderr, interrupted, isImage, ... }; when stdout is longer
 * than `maxChars`, it becomes its first `keepHead` characters, a line saying how much was cut, and its last `keepTail` characters (the
 * start usually holds what was run and the end holds the result or the error). Everything else in the response is kept as it was, because
 * Claude Code ignores a replacement that does not match the tool's output shape. An interrupted command, an image, and a response
 * whose stdout is not text are left alone.
 * @param {{ tool_name?: string, tool_response?: any }} input
 * @param {{ maxChars: number, keepHead: number, keepTail: number }} cfg
 * @returns {{ output: any, charsBefore: number, charsAfter: number } | null}
 */
export function trimBashOutput(input, cfg) {
  if (input.tool_name !== "Bash") return null;
  const r = input.tool_response;
  if (!r || typeof r !== "object" || typeof r.stdout !== "string" || r.interrupted === true || r.isImage === true) return null;
  const out = r.stdout;
  if (out.length <= cfg.maxChars) return null;
  const cut = out.length - cfg.keepHead - cfg.keepTail;
  if (cut <= 0) return null;
  const note = `\n… [sparelimit trimmed ${cut.toLocaleString("en-US")} characters from the middle of this output; the command ran in full] …\n`;
  const stdout = out.slice(0, cfg.keepHead) + note + out.slice(out.length - cfg.keepTail);
  return { output: { ...r, stdout }, charsBefore: out.length, charsAfter: stdout.length };
}
