import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The bootstrap, exercised as the process a user actually launches.
 *
 * `src/index.ts` is the one module no test can import: it connects a stdio
 * transport to `process.stdout` and calls `process.exit` on failure, so bringing
 * it in-process would tear down the runner. Every other suite reaches the server
 * through `connectServer`, which spawns this file as a child — so its branches
 * are only covered by whatever a child happens to do, which is the kind of
 * coverage that reports green while proving nothing.
 *
 * So these drive the real entry point and read its exit code and stderr. The one
 * that matters most is the refusal: a runtime that cannot persist must not answer
 * `initialize` at all, because a server that starts and then discards every write
 * is worse than one that declines to launch.
 */

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  dataDir: string;
}

function runServer(opts: { env?: Record<string, string>; pretendNode?: string } = {}): Promise<Run> {
  const scratch = mkdtempSync(join(tmpdir(), "tango-boot-"));
  const dataDir = join(scratch, "catalog");
  const preload: string[] = ["--import", "tsx"];

  // To exercise the runtime floor on a machine that *has* built-in SQLite, the
  // version has to be faked before the entry point reads it — the same
  // substitution `sqliteStore.test.ts` and `storage.test.ts` make in-process,
  // hoisted here into a real child.
  if (opts.pretendNode) {
    const shim = join(scratch, "shim.mjs");
    writeFileSync(
      shim,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(
        opts.pretendNode
      )}, configurable: true });\n`
    );
    // `--import` takes a specifier, and on Windows a bare `C:\...` path is read
    // as a URL with an unknown `c:` scheme — so it has to be a file:// URL.
    preload.push("--import", pathToFileURL(shim).href);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload, ENTRY], {
      env: { ...process.env, PROJECT_TANGO_DATA_DIR: dataDir, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, dataDir });
    };

    child.stdout.on("data", (d) => {
      stdout += d;
      // A healthy server answers initialize; a refusing one never does, and exits
      // by itself. Waiting for the *answer* rather than a fixed delay keeps this
      // from adding fifteen idle seconds per passing case to the suite.
      if (stdout.includes('"protocolVersion"')) {
        child.kill();
        finish(null);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => finish(code));

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 20000);

    // An initialize request that a healthy server answers and a refusing one
    // never does.
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bootstrap-test", version: "1.0.0" },
        },
      }) + "\n"
    );
  });
}

describe("the server entry point", () => {
  it("starts on a supported runtime, reports its store and answers initialize", async () => {
    const run = await runServer();
    assert.match(run.stderr, /MCP server running on stdio/, "a supported runtime must start");
    assert.match(run.stderr, /SQLite/, "the default backend is SQLite");
    assert.ok(
      run.stdout.includes('"protocolVersion"'),
      "the server must answer initialize on stdout — that is the whole protocol"
    );
    assert.ok(existsSync(run.dataDir), "a started server keeps its state where it said it would");
  });

  it("refuses to start on a runtime with no built-in SQLite", async () => {
    const run = await runServer({ pretendNode: "18.20.4" });

    assert.equal(run.code, 1, "the refusal must be a non-zero exit, not a running server");
    assert.equal(
      run.stdout.trim(),
      "",
      "a server that refuses must not answer any part of the protocol"
    );
    assert.match(run.stderr, /cannot start on Node 18\.20\.4/, "the message must name the runtime");
    assert.match(
      run.stderr,
      /PROJECT_TANGO_STORE=json/,
      "the message must offer a way forward, not just a diagnosis"
    );
  });

  it("does not create a data directory for a runtime it is going to refuse", async () => {
    // The check has to come *before* the provider loads, because loading it is
    // what opens — and therefore creates — the store. A refusal that left a
    // stray `state.db` behind would be littering a directory it never used, on
    // the one machine whose runtime is too old to open it.
    const run = await runServer({ pretendNode: "20.11.0" });
    assert.equal(run.code, 1);
    assert.equal(existsSync(run.dataDir), false, "a refused server must not create its data directory");
  });

  it("starts anyway when the operator asks for the JSON backend on an old runtime", async () => {
    // The escape hatch is the whole reason the refusal is safe: someone who
    // knowingly trades the stronger guarantee for a working server must get a
    // working server, not the same refusal.
    const run = await runServer({ pretendNode: "18.20.4", env: { PROJECT_TANGO_STORE: "json" } });
    assert.match(run.stderr, /MCP server running on stdio/, "an explicit opt-out must be honoured");
    assert.match(run.stderr, /state\.json/, "and it must actually use the backend that was chosen");
    assert.ok(run.stdout.includes('"protocolVersion"'), "and it must speak MCP");
  });

  it("starts with no persistence when that was asked for", async () => {
    const run = await runServer({ pretendNode: "18.20.4", env: { PROJECT_TANGO_PERSIST: "0" } });
    assert.match(run.stderr, /MCP server running on stdio/);
    assert.match(run.stderr, /in-memory/, "PROJECT_TANGO_PERSIST=0 must mean in-memory, not a refusal");
  });
});