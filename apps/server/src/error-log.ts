import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactString } from "./orchestration/control/redaction.js";

const errorLogPath = path.resolve(process.env.APP_DATA_DIR ?? ".data", "error.log");
let directoryEnsured = false;

/** Appends a timestamped line to <APP_DATA_DIR>/error.log, in addition to console.error. */
export async function logError(scope: string, message: string): Promise<void> {
  const safeMessage = redactString(message);
  console.error(`[${scope}]`, safeMessage);
  try {
    if (!directoryEnsured) {
      await mkdir(path.dirname(errorLogPath), { recursive: true });
      directoryEnsured = true;
    }
    await appendFile(errorLogPath, `${new Date().toISOString()} [${scope}] ${safeMessage}\n`);
  } catch {
    // Best-effort: the console.error above already surfaced this.
  }
}

export { errorLogPath };
