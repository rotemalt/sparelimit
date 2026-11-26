import os from "node:os";
import path from "node:path";

export const VERSION = "1.1.0";

// Runtime state (live snapshots read by the dashboard) lives here, never in the install dir or git.
export const STATE_DIR = process.env.SPARELIMIT_HOME || path.join(os.homedir(), ".sparelimit");

export const METHOD_FOOTER = "How every number here is computed, and what exact / derived / estimated mean: `sparelimit method`.";
