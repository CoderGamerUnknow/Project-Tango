import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_VERSION,
  createFileStore,
  createMemoryStore,
  resolveStateStore,
  type PersistedState,
} from "./storage.js";
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

describe("resolveStateStore", () => {
  it("returns an in-memory store when persistence is disabled", () => {
    const store = resolveStateStore({ PROJECT_TANGO_PERSIST: "0" });
    assert.match(store.description, /in-memory/);
  });

  it("honours an explicit data directory", () => {
    const dir = join(tmpdir(), "explicit-store");
    const store = resolveStateStore({ PROJECT_TANGO_DATA_DIR: dir });
    assert.equal(store.description, join(dir, "state.json"));
  });

  it("falls back to a stable path under the home directory", () => {
    const store = resolveStateStore({});
    assert.match(store.description, /\.project-tango/);
  });

  it("treats a blank data directory as unset rather than writing to the cwd", () => {
    const store = resolveStateStore({ PROJECT_TANGO_DATA_DIR: "   " });
    assert.match(store.description, /\.project-tango/);
  });

  it("ignores a data directory when persistence is disabled", () => {
    const store = resolveStateStore({ PROJECT_TANGO_PERSIST: "0", PROJECT_TANGO_DATA_DIR: "/tmp/x" });
    assert.match(store.description, /in-memory/);
  });
});