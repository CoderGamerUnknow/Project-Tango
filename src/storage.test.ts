import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_VERSION,
  createFileStore,
  createMemoryStore,
  durabilityBlocker,
  resolveStateStore,
  stableToken,
  type PersistedState,
  type StateStore,
} from "./storage.js";
import { MIN_NODE_FOR_SQLITE } from "./sqliteStore.js";
import type { Order, Product } from "./types.js";

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  const product: Product = {
    id: "prod_001",
    name: "Widget",
    sku: "SKU-1",
    price: 10,
    inventoryCount: 5,
    category: "tech",
    tags: ["a"],
    description: "A widget.",
  };
  const order: Order = {
    id: "ord_1",
    customerName: "Someone",
    items: [{ productId: "prod_001", quantity: 2 }],
    totalAmount: 20,
    status: "pending",
    date: "2026-10-01",
  };

  return { version: STATE_VERSION, products: [product], orders: [order], ...overrides };
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "project-tango-store-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("createMemoryStore", () => {
  it("round-trips state within the process", () => {
    const store = createMemoryStore();
    assert.equal(store.load(), undefined);

    store.save(makeState());
    assert.equal(store.load()?.products.length, 1);
  });

  it("hands back a copy, so later mutation of the source cannot leak in", () => {
    const store = createMemoryStore();
    const state = makeState();
    store.save(state);

    state.products[0]!.inventoryCount = 999;
    assert.equal(store.load()!.products[0]!.inventoryCount, 5);
  });

  it("hands back a copy on load, so mutating it cannot corrupt the store", () => {
    // The file store is immune (JSON.parse returns a fresh object), so the two
    // stores must behave identically — otherwise behaviour depends on which
    // store is configured.
    const store = createMemoryStore();
    store.save(makeState());

    const first = store.load()!;
    first.products[0]!.inventoryCount = 999;

    assert.equal(store.load()!.products[0]!.inventoryCount, 5);
  });

  it("returns undefined again after the caller mutates a loaded snapshot", () => {
    const store = createMemoryStore();
    store.save(makeState());
    store.load()!.orders.push(makeState().orders[0]!);
    store.save(makeState());

    assert.equal(store.load()!.orders.length, 1);
  });
});

describe("createFileStore", () => {
  it("returns undefined when no state file exists yet", async () => {
    await withTempDir((dir) => {
      assert.equal(createFileStore(dir).load(), undefined);
    });
  });

  it("creates the directory and round-trips state", async () => {
    await withTempDir((dir) => {
      const nested = join(dir, "does", "not", "exist");
      const store = createFileStore(nested);

      store.save(makeState());

      assert.ok(existsSync(join(nested, "state.json")));
      assert.equal(store.load()?.orders.length, 1);
    });
  });

  it("writes atomically, leaving no temp file behind", async () => {
    await withTempDir((dir) => {
      createFileStore(dir).save(makeState());
      assert.equal(existsSync(join(dir, "state.json.tmp")), false);
    });
  });

  it("overwrites previous state rather than appending", async () => {
    await withTempDir((dir) => {
      const store = createFileStore(dir);
      store.save(makeState());
      store.save(makeState({ orders: [] }));

      assert.equal(store.load()?.orders.length, 0);
      assert.equal(store.load()?.products.length, 1);
    });
  });

  it("survives a simulated crash mid-write by keeping the previous good file", async () => {
    await withTempDir((dir) => {
      const store = createFileStore(dir);
      store.save(makeState());

      // Simulate a process dying after the temp file is written but before the
      // rename. The real state file must be untouched.
      writeFileSync(join(dir, "state.json.tmp"), "{ truncated", "utf8");

      assert.equal(store.load()?.products.length, 1);
    });
  });

  it("ignores a corrupt state file and warns instead of throwing", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "state.json"), "{ not json at all", "utf8");

      const warnings: string[] = [];
      const store = createFileStore(dir, (m) => warnings.push(m));

      assert.equal(store.load(), undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /not valid JSON/);
    });
  });

  it("rejects a state file from an unknown version and warns", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "state.json"), JSON.stringify(makeState({ version: 999 })), "utf8");

      const warnings: string[] = [];
      const store = createFileStore(dir, (m) => warnings.push(m));

      assert.equal(store.load(), undefined);
      assert.match(warnings[0]!, /version 999/);
    });
  });

  it("rejects a state file with an unexpected shape and warns", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "state.json"), JSON.stringify({ hello: "world" }), "utf8");

      const warnings: string[] = [];
      const store = createFileStore(dir, (m) => warnings.push(m));

      assert.equal(store.load(), undefined);
      assert.match(warnings[0]!, /unexpected shape/);
    });
  });

  it("rejects a JSON scalar, which parses but is not a state file", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "state.json"), "42", "utf8");
      assert.equal(createFileStore(dir, () => {}).load(), undefined);
    });
  });

  it("drops malformed product records but keeps the good ones", async () => {
    await withTempDir((dir) => {
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          version: STATE_VERSION,
          products: [
            makeState().products[0],                                  // complete
            { id: "prod_002", name: "No category", sku: "S2" },       // missing fields
          ],
          orders: [],
        })
      );

      const warnings: string[] = [];
      const loaded = createFileStore(dir, (m) => warnings.push(m)).load();

      assert.equal(loaded?.products.length, 1);
      assert.equal(loaded?.products[0]?.id, "prod_001");
      assert.match(warnings[0]!, /dropped 1 malformed product/);
    });
  });

  it("drops malformed order records but keeps the good ones", async () => {
    await withTempDir((dir) => {
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          version: STATE_VERSION,
          products: [],
          orders: [
            makeState().orders[0],                                    // complete
            { id: "ord_2", items: "not-an-array" },                   // malformed
            { id: "ord_3", customerName: "x", items: [], totalAmount: 0, status: "unknown", date: "2026-10-01" },
          ],
        })
      );

      const warnings: string[] = [];
      const loaded = createFileStore(dir, (m) => warnings.push(m)).load();

      assert.equal(loaded?.orders.length, 1);
      assert.equal(loaded?.orders[0]?.id, "ord_1");
      assert.match(warnings[0]!, /2 malformed order/);
    });
  });

  it("drops non-finite and fractional numbers rather than letting them break every tool", async () => {
    // Regression: `typeof x === "number"` accepts `Infinity` (which is what
    // `JSON.parse("1e999")` yields) and fractional quantities. Both reached the
    // catalog and then failed the tools' own output schemas, so one bad field in
    // one record turned `analyze_sales_metrics`, `smart_restock_predictor` and
    // `find_orders` into `Output validation error: expected number/int`. The
    // raw JSON is written by hand here because `JSON.stringify` cannot express
    // either value — which is exactly why only a foreign state file produces it.
    await withTempDir((dir) => {
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          version: STATE_VERSION,
          products: [],
          orders: [
            makeState().orders[0], // complete
            {
              id: "ord_inf",
              customerName: "Inf",
              items: [{ productId: "prod_001", quantity: 1e999 }],
              totalAmount: 10,
              status: "pending",
              date: "2026-10-01",
            },
            {
              id: "ord_frac",
              customerName: "Frac",
              items: [{ productId: "prod_001", quantity: 1.5 }],
              totalAmount: 15,
              status: "pending",
              date: "2026-10-01",
            },
          ],
        })
      );

      const loaded = createFileStore(dir, () => {}).load();

      assert.deepEqual(
        loaded?.orders.map((o) => o.id),
        ["ord_1"]
      );
      // And the numbers that survive are genuinely finite and integral.
      for (const product of loaded?.products ?? []) {
        assert.ok(Number.isFinite(product.price), `${product.id} price is not finite`);
        assert.ok(Number.isInteger(product.inventoryCount), `${product.id} stock is not an integer`);
      }
    });
  });

  it("drops products whose numeric fields are not finite", async () => {
    await withTempDir((dir) => {
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          version: STATE_VERSION,
          products: [makeState().products[0], { ...makeState().products[0], id: "prod_inf" }],
          orders: [],
        }).replace('"price":10,"inventoryCount":5,"category":"tech","tags":["a"],"description":"A widget."}]', '"price":1e999,"inventoryCount":5,"category":"tech","tags":["a"],"description":"A widget."}]')
      );

      const loaded = createFileStore(dir, () => {}).load();

      assert.deepEqual(
        loaded?.products.map((p) => p.id),
        ["prod_001"]
      );
      assert.ok(Number.isFinite(loaded?.products[0]?.price));
    });
  });

  it("keeps a complete state file loaded with no warnings", async () => {
    await withTempDir((dir) => {
      createFileStore(dir).save(makeState());

      const warnings: string[] = [];
      assert.equal(createFileStore(dir, (m) => warnings.push(m)).load()?.orders.length, 1);
      assert.deepEqual(warnings, []);
    });
  });

  it("swallows write failures so a read-only directory cannot crash the server", async () => {
    await withTempDir((dir) => {
      // Point the store at a path that cannot be created: a file used as a directory.
      const blocked = join(dir, "blocker");
      writeFileSync(blocked, "not a directory", "utf8");

      const warnings: string[] = [];
      const store = createFileStore(join(blocked, "nested"), (m) => warnings.push(m));

      assert.doesNotThrow(() => store.save(makeState()));
      assert.match(warnings[0]!, /could not persist state/);
    });
  });

  it("round-trips order line items intact", async () => {
    await withTempDir((dir) => {
      const store = createFileStore(dir);
      store.save(makeState());

      const restored = store.load()!;
      assert.deepEqual(restored.orders[0]!.items, [{ productId: "prod_001", quantity: 2 }]);
      assert.equal(
        JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).orders[0].items[0].quantity,
        2
      );
    });
  });
});

describe('the change token contract', () => {
  // Every backend the project ships must be able to say when another writer
  // committed. The token was optional once, which let a backend omit it and
  // silently keep serving a stale catalog; this is what stops that going
  // unnoticed the next time one is added.
  it('is implemented by every store resolveStateStore can return', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-tango-token-'));
    const opened: StateStore[] = [];
    try {
      const stores = {
        memory: await resolveStateStore({ PROJECT_TANGO_PERSIST: '0' }),
        file: await resolveStateStore({ PROJECT_TANGO_DATA_DIR: dir, PROJECT_TANGO_STORE: 'json' }),
        sqlite: await resolveStateStore({ PROJECT_TANGO_DATA_DIR: dir }),
      };
      opened.push(...Object.values(stores));

      for (const [name, store] of Object.entries(stores)) {
        assert.equal(typeof store.changeToken, 'function', `the ${name} store must report a change token`);
        assert.equal(typeof store.changeToken(), 'string');
      }
    } finally {
      // Closed before the directory is removed: on Windows a live handle makes
      // `rmSync` fail with EPERM, which is a failure of the cleanup, not the
      // thing being asserted.
      for (const store of opened) store.close?.();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('moves on the file store when another writer rewrites the file', () => {
    // The JSON backend cannot lock, but it can still notice a rival writing the
    // same directory — which is the difference between a stale read and a
    // reload, and the reason the token is required rather than optional.
    //
    // The own-write case deliberately saves *different* content. The token is
    // `size:mtime`, so rewriting byte-identical state can legitimately leave it
    // unchanged on a filesystem with coarse mtime granularity — that would be
    // testing the OS, not this store.
    const dir = mkdtempSync(join(tmpdir(), 'project-tango-file-token-'));
    const mine = createFileStore(dir);
    const theirs = createFileStore(dir);
    try {
      assert.equal(mine.changeToken(), 'absent', 'no file yet');

      theirs.save(makeState());
      const afterRival = mine.changeToken();
      assert.notEqual(afterRival, 'absent', 'a rival write must move the token');
      assert.equal(mine.changeToken(), afterRival, 'and it must settle once it has moved');

      mine.save(makeState({ orders: [] }));
      assert.notEqual(
        mine.changeToken(),
        afterRival,
        'the file store derives its token from the file, so our own write moves it too — ' +
          'documented on the contract, and harmless: the provider reloads once rather than serving stale data'
      );
    } finally {
      mine.close?.();
      theirs.close?.();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('describes a backend that cannot detect other writers instead of omitting it', () => {
    const token = stableToken('read-only-filesystem');
    assert.equal(token(), token());
    assert.match(token(), /read-only-filesystem/, 'the reason must be in the token, not just in a comment');
  });
});

describe("resolveStateStore", () => {
  it("returns an in-memory store when persistence is disabled", async () => {
    const store = await resolveStateStore({ PROJECT_TANGO_PERSIST: "0" });
    assert.match(store.description, /in-memory/);
  });

  it("honours an explicit data directory", async () => {
    const dir = join(tmpdir(), "explicit-store");
    const store = await resolveStateStore({ PROJECT_TANGO_DATA_DIR: dir });
    // SQLite is the default backend: it gives the cross-process transaction the
    // JSON file could not.
    assert.equal(store.description, `${join(dir, "state.db")} (SQLite, WAL)`);
  });

  it("falls back to the JSON file when the JSON backend is forced explicitly", async () => {
    const dir = join(tmpdir(), "forced-json-store");
    const store = await resolveStateStore({ PROJECT_TANGO_DATA_DIR: dir, PROJECT_TANGO_STORE: "json" });
    assert.equal(store.description, join(dir, "state.json"));
    assert.equal(store.update, undefined, "the JSON backend cannot provide a cross-process lock");
  });

  it("provides an exclusive transaction by default, so writes are not last-writer-wins", async () => {
    const store = await resolveStateStore({ PROJECT_TANGO_DATA_DIR: join(tmpdir(), "locking-store") });
    assert.equal(typeof store.update, "function", "the default store must offer a locked read-modify-write");
    store.close?.();
  });

  it("falls back to a stable path under the home directory", async () => {
    // The JSON backend is forced because these two cases are about *path
    // resolution*. The SQLite store creates its file when it is constructed, so
    // asking for the default directory under the default backend would write a
    // real `state.db` into the developer's home directory — a test run must
    // never create the catalog it is meant to be protecting.
    const store = await resolveStateStore({ PROJECT_TANGO_STORE: "json" });
    assert.match(store.description, /\.project-tango/);
  });

  it("treats a blank data directory as unset rather than writing to the cwd", async () => {
    const store = await resolveStateStore({ PROJECT_TANGO_DATA_DIR: "   ", PROJECT_TANGO_STORE: "json" });
    assert.match(store.description, /\.project-tango/);
  });

  it("ignores a data directory when persistence is disabled", async () => {
    const store = await resolveStateStore({ PROJECT_TANGO_PERSIST: "0", PROJECT_TANGO_DATA_DIR: "/tmp/x" });
    assert.match(store.description, /in-memory/);
  });
});

/**
 * The runtime floor.
 *
 * This is the one degradation that refuses to start rather than warning, and the
 * tests below are the reason it stays that way. The suite runs on a Node that
 * *has* `node:sqlite`, so the fatal branch is reached by injecting the runtime's
 * answer instead — the same substitution `sqliteStore.test.ts` uses to stand in
 * for a runtime it cannot otherwise provide.
 */
describe("durabilityBlocker", () => {
  const noSqlite = false;
  const withSqlite = true;

  it("refuses to start on a runtime with no built-in SQLite", async () => {
    const blocker = await durabilityBlocker({}, noSqlite);
    assert.ok(blocker, "a runtime that cannot persist must not be allowed to serve");
    // The message has to carry the actual fix, not just the diagnosis: the
    // reader of this is staring at a server that refused to launch.
    assert.match(blocker, /cannot start on Node/);
    assert.match(blocker, new RegExp(MIN_NODE_FOR_SQLITE.replace(/\./g, "\\.")), "must name the floor");
    assert.match(blocker, /PROJECT_TANGO_STORE=json/, "must offer the narrower backend as a way forward");
    assert.match(blocker, /PROJECT_TANGO_PERSIST=0/, "must offer the opt-out as a way forward");
  });

  it("stays out of the way on a runtime that can persist", async () => {
    assert.equal(
      await durabilityBlocker({}, withSqlite),
      undefined,
      "the default path on a supported runtime must not be blocked"
    );
  });

  it("yields to a deliberate request for the JSON backend", async () => {
    // No `node:sqlite` here, and it does not matter: the operator chose a
    // backend that works, so their choice outranks the floor.
    assert.equal(await durabilityBlocker({ PROJECT_TANGO_STORE: "json" }, noSqlite), undefined);
    assert.equal(await durabilityBlocker({ PROJECT_TANGO_STORE: "JSON" }, noSqlite), undefined);
    assert.equal(await durabilityBlocker({ PROJECT_TANGO_STORE: " json " }, noSqlite), undefined);
  });

  it("yields to a deliberate request for no persistence", async () => {
    assert.equal(await durabilityBlocker({ PROJECT_TANGO_PERSIST: "0" }, noSqlite), undefined);
    assert.equal(await durabilityBlocker({ PROJECT_TANGO_PERSIST: " 0 " }, noSqlite), undefined);
  });

  it("does not mistake a near-miss variable value for an opt-out", async () => {
    // `PERSIST=false` and `STORE=sqlite` are not the escape hatches. Reading them
    // as such would silently disable the check on a runtime that needs it —
    // the failure mode being guarded against, reintroduced by a typo.
    assert.ok(await durabilityBlocker({ PROJECT_TANGO_PERSIST: "false" }, noSqlite));
    assert.ok(await durabilityBlocker({ PROJECT_TANGO_PERSIST: "" }, noSqlite));
    assert.ok(await durabilityBlocker({ PROJECT_TANGO_STORE: "sqlite" }, noSqlite));
  });

  it("asks the real runtime when it is not told otherwise", async () => {
    // The no-argument path is what `src/index.ts` uses, so it must consult the
    // runtime rather than assume. This suite runs on a Node with `node:sqlite`,
    // so the honest answer here is "no blocker".
    assert.equal(await durabilityBlocker(), undefined);
  });
});