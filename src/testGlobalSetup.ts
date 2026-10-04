/**
 * Point every test process at a throwaway data directory.
 *
 * `mockData.ts` resolves its state store at import time, and opening a SQLite
 * store creates `state.db` the moment it does. So a suite that imports the
 * provider *in process* — `mockData.test.ts` does, with a static import — used
 * to open the developer's real `~/.project-tango/state.db` and write a catalog
 * into it. The suites that launch server processes (`testHelpers.connectServer`)
 * already override the directory for their children; this covers the rest,
 * including any future file that imports the provider directly.
 *
 * `PROJECT_TANGO_PERSIST` is deliberately left alone: the lifecycle suite needs
 * persistence on, and only the directory is being redirected.
 *
 * Node runs this once in the runner process before it spawns the test files,
 * and children inherit the environment, so one assignment covers the whole run.
 * The directory is removed on exit; `maxRetries` absorbs the brief moment a
 * just-closed SQLite handle still holds its `-wal`/`-shm` sidecars on Windows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "project-tango-suite-"));
process.env.PROJECT_TANGO_DATA_DIR = dir;

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // A directory left in the OS temp folder is not worth failing a green run.
  }
});
