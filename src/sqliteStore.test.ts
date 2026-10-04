import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";

import { ProductIndex } from "./productIndex.js";
import { createSqliteStore, MIN_NODE_FOR_SQLITE, sqliteAvailable } from "./sqliteStore.js";
import { STATE_VERSION, type PersistedState, type StateStore } from "./storage.js";
import { makeProduct } from "./testHelpers.js";

/** Block the current thread. Startup code is synchronous, so this is the wait. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A temp directory, removed afterwards.
 *
 * `maxRetries`/`retryDelay` exist because SQLite in WAL mode keeps the
 * `-wal`/`-shm` sidecars briefly after `close()`, and on Windows a handle still
 * held on them makes the directory removal fail with `EPERM`. Retrying is the
 * difference between a flake and a real failure — without it these tests fail
 * intermittently for a reason that has nothing to do with what they assert.
 */
async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "project-tango-sqlite-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

/**
 * The store's locked read-modify-write, or a loud failure.
 *
 * `update` is optional on the `StateStore` contract because not every backend
 * can provide one. Asserting it exists here keeps the test honest — if the
 * SQLite store ever stopped offering cross-process locking, these tests would
 * say so rather than quietly passing.
 */
function requireUpdate(store: StateStore): NonNullable<StateStore["update"]> {
  assert.ok(typeof store.update === "function", "the SQLite store must offer a locked read-modify-write");
  return store.update;
}

/**
 * The store's change token, or a loud failure.
 *
 * Freshness is a guarantee rather than an optimisation here: without a token the
 * provider silently keeps serving its own copy, which is exactly the behaviour
 * these tests exist to prevent, so it is asserted rather than assumed.
 */
function requireChangeToken(store: StateStore): string {
  assert.equal(
    typeof store.changeToken,
    "function",
    "the SQLite store must report when another process committed"
  );
  return store.changeToken!();
}

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STATE_VERSION,
    products: [
      {
        id: "prod_001",
        name: "Widget",
        sku: "TCH-AB-001",
        price: 129.99,
        inventoryCount: 5,
        category: "tech",
        tags: ["wireless", "audio"],
        description: "A widget.",
      },
    ],
    orders: [
      {
        id: "ord_1",
        customerName: "Someone",
        items: [{ productId: "prod_001", quantity: 2 }],
        totalAmount: 259.98,
        status: "pending",
        date: "2026-10-01",
      },
    ],
    ...overrides,
  };
}

describe("sqliteAvailable", () => {
  it("agrees with the runtime it is running on", () => {
    assert.equal(sqliteAvailable(), true, "the suite runs on a Node with node:sqlite");
    assert.match(MIN_NODE_FOR_SQLITE, /^\d+\.\d+\.\d+$/);
  });
});

describe("createSqliteStore", () => {
  it("reports no state for a database nobody has written to", async () => {
    // The schema is created on open, so a fresh database has tables. Reporting
    // it as "restored, zero products" made the provider skip the seed dataset
    // and serve an empty catalog.
    await withTempDir((dir) => {
      const store = createSqliteStore(dir);
      assert.ok(store, "store should be available");
      assert.equal(store.load(), undefined, "an untouched database must report no state");
      store.close?.();
    });
  });

  it("reports another process's commit through changeToken, and not its own", async () => {
    // The contract the provider's read-freshness check depends on. `PRAGMA
    // data_version` moves for every *other* connection's commit and not for this
    // one — verified here rather than assumed, because both halves matter: a
    // token that also moved on our own writes would make every provider re-read
    // the whole catalog after each order it placed, and one that stayed still
    // for other writers would leave a server serving a replaced catalog for the
    // rest of the conversation.
    await withTempDir((dir) => {
      const mine = createSqliteStore(dir);
      const theirs = createSqliteStore(dir);
      assert.ok(mine && theirs, "both stores should open");
      try {
        const own = requireChangeToken(mine);
        const before = requireChangeToken(theirs);

        mine.save(makeState());
        assert.equal(
          requireChangeToken(mine),
          own,
          "our own commit is already in this process's memory, so it must not ask for a reload"
        );
        assert.notEqual(
          requireChangeToken(theirs),
          before,
          "a second server watching the same database must see the commit"
        );

        const afterMine = requireChangeToken(mine);
        theirs.save(makeState({ products: [] }));
        assert.notEqual(
          requireChangeToken(mine),
          afterMine,
          "another process's commit must be visible, or reads go stale for the life of the server"
        );
      } finally {
        mine.close?.();
        theirs.close?.();
      }
    });
  });

  it("waits out a lock held by another server instead of falling back", () => {
    // The regression that motivated the retry: `PRAGMA journal_mode = WAL`
    // needs a brief exclusive lock and returns SQLITE_BUSY immediately,
    // ignoring busy_timeout. Two servers starting together raced, and the loser
    // silently dropped to a weaker backend — which brought the overselling back.
    // A child process holds the lock here for longer than one attempt, so a
    // store that opens at all proves the retry ran.
    const dir = mkdtempSync(join(tmpdir(), "project-tango-locked-"));
    const holder = join(dir, "state.db");
    try {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const {DatabaseSync}=require('node:sqlite');
           const db=new DatabaseSync(process.argv[1]);
           db.exec('PRAGMA journal_mode = WAL');
           db.exec('CREATE TABLE IF NOT EXISTS t(x)');
           db.exec('BEGIN EXCLUSIVE');
           setTimeout(()=>{ try{db.exec('COMMIT')}catch{} db.close(); }, 1500);`,
          holder,
        ],
        { stdio: "ignore" }
      );

      // Give the child time to take the lock, then open while it holds it.
      sleepSync(700);

      const warnings: string[] = [];
      const store = createSqliteStore(dir, (m) => warnings.push(m));

      assert.ok(store, "a locked database must be waited out, not abandoned");
      assert.equal(
        warnings.length,
        0,
        `waiting is not a failure, so it must not warn: ${JSON.stringify(warnings)}`
      );
      assert.equal(typeof store?.update, "function", "the store must keep its cross-process lock");
      store?.close?.();
      child.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("reports itself unavailable when the data directory cannot be created", () => {
    const base = mkdtempSync(join(tmpdir(), "project-tango-nodir-"));
    try {
      // A file where a parent directory would have to be.
      const blocker = join(base, "blocker");
      writeFileSync(blocker, "not a directory", "utf8");

      const warnings: string[] = [];
      const store = createSqliteStore(join(blocker, "nested"), (m) => warnings.push(m));

      assert.equal(store, undefined, "an uncreatable directory must be reported, not thrown");
      assert.ok(
        warnings.some((w) => /could not create/i.test(w)),
        `expected a directory warning, got ${JSON.stringify(warnings)}`
      );
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("declines to open a store on a runtime without built-in SQLite", () => {
    // The version gate cannot be exercised for real on this machine, so the
    // runtime version is swapped for the check. Without this the branch that
    // keeps an older Node from crashing at the first write would be untested —
    // and it is precisely the branch a user on Node 18 would hit.
    const real = process.versions.node;
    Object.defineProperty(process.versions, "node", { value: "20.11.0", configurable: true });
    try {
      assert.equal(sqliteAvailable(), false, "Node 20 has no node:sqlite");

      const warnings: string[] = [];
      const store = createSqliteStore(join(tmpdir(), "too-old-node"), (m) => warnings.push(m));
      assert.equal(store, undefined, "an unsupported runtime must fall back, not throw");
      assert.match(warnings[0]!, /built-in SQLite/, "the reason must be explained");
      assert.match(warnings[0]!, new RegExp(MIN_NODE_FOR_SQLITE.replace(/\./g, "\\.")));
    } finally {
      Object.defineProperty(process.versions, "node", { value: real, configurable: true });
    }
    assert.equal(sqliteAvailable(), true, "the gate must open again once the real version is restored");
  });

  it("warns instead of throwing when state cannot be persisted", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());
      store.close?.();

      // Saving through a closed handle must degrade, not take the tools down:
      // this process is a background child of someone else's app, and a
      // read-only or full disk cannot be allowed to crash the server.
      const warnings: string[] = [];
      const reopened = createSqliteStore(dir, (m) => warnings.push(m))!;
      reopened.close?.();
      reopened.save(makeState());

      assert.ok(
        warnings.some((w) => /could not persist/i.test(w)),
        `expected a persistence warning, got ${JSON.stringify(warnings)}`
      );
      reopened.close?.();
    });
  });

  it("round-trips products, orders and line items", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      const state = makeState();
      store.save(state);

      const loaded = store.load();
      assert.deepEqual(loaded?.products, state.products, "products must survive verbatim, tags included");
      assert.deepEqual(loaded?.orders, state.orders);
      store.close?.();
    });
  });

  it("preserves order-line order and empty line lists", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(
        makeState({
          orders: [
            {
              id: "ord_multi",
              customerName: "Someone",
              items: [
                { productId: "prod_001", quantity: 1 },
                { productId: "prod_002", quantity: 3 },
                { productId: "prod_001", quantity: 2 },
              ],
              totalAmount: 10,
              status: "delivered",
              date: "2026-10-02",
            },
            {
              id: "ord_empty",
              customerName: "Someone",
              items: [],
              totalAmount: 0,
              status: "pending",
              date: "2026-10-02",
            },
          ],
        })
      );

      const orders = store.load()?.orders ?? [];
      assert.deepEqual(orders[0]?.items, [
        { productId: "prod_001", quantity: 1 },
        { productId: "prod_002", quantity: 3 },
        { productId: "prod_001", quantity: 2 },
      ]);
      assert.deepEqual(orders[1]?.items, [], "an order with no lines must not gain one");
      store.close?.();
    });
  });

  it("overwrites rather than accumulating across saves", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());
      store.save(makeState({ products: [], orders: [] }));

      const loaded = store.load();
      assert.deepEqual(loaded?.products, []);
      assert.deepEqual(loaded?.orders, []);
      store.close?.();
    });
  });

  it("runs a locked read-modify-write and commits only what the caller returns", async () => {
    await withTempDir(async (dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());

      const update = requireUpdate(store);
      const committed = await update((current) => {
        assert.ok(current, "the caller sees committed state, not a blank slate");
        assert.equal(current.products.length, 1);
        const next = structuredClone(current);
        next.products[0]!.inventoryCount = 3;
        return Promise.resolve({ commit: next, result: "ok" });
      });
      assert.equal(committed, "ok");
      assert.equal(store.load()?.products[0]?.inventoryCount, 3);

      // Returning no commit must leave the store exactly as it was.
      const discarded = await store.update!(() => Promise.resolve({ result: "nothing" }));
      assert.equal(discarded, "nothing");
      assert.equal(store.load()?.products[0]?.inventoryCount, 3, "an uncommitted update must not persist");
      store.close?.();
    });
  });

  it("rolls back and rethrows when the read-modify-write fails", async () => {
    await withTempDir(async (dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());

      await assert.rejects(
        requireUpdate(store)((current) => {
          const next = structuredClone(current!);
          next.products[0]!.inventoryCount = 99;
          // Reported as a commit, then throws before it can be written.
          void next;
          return Promise.reject(new Error("boom"));
        }),
        /boom/
      );

      assert.equal(
        store.load()?.products[0]?.inventoryCount,
        5,
        "a failed transaction must leave the previous state intact"
      );
      store.close?.();
    });
  });

  it("stays usable after a rolled-back transaction", async () => {
    await withTempDir(async (dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());

      const update = requireUpdate(store);
      await assert.rejects(update(() => Promise.reject(new Error("first fails"))));
      // The lock must have been released, or every later write would fail too.
      const after = await update((current) =>
        Promise.resolve({ commit: current as PersistedState, result: "second" })
      );
      assert.equal(after, "second");
      store.close?.();
    });
  });

  it("survives a corrupt database without throwing", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());
      store.close?.();

      // Not a database at all. Reopening must warn and return no state rather
      // than take the tools down.
      const path = join(dir, "state.db");
      writeFileSync(path, "this is not a sqlite file", "utf8");

      const warnings: string[] = [];
      const reopened = createSqliteStore(dir, (m) => warnings.push(m));
      assert.equal(reopened, undefined, "an unusable database must report itself unavailable");
      assert.ok(
        warnings.some((w) => /could not/i.test(w)),
        `expected a warning, got ${JSON.stringify(warnings)}`
      );
    });
  });

  it("costs a product its tags, not the catalog, when the stored blob is corrupt", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());
      store.close?.();

      // Written behind the store's back, the way a partially-written or
      // hand-edited database would look. Reading it must not throw: one bad
      // field costs that product its tags.
      const raw = new DatabaseSync(join(dir, "state.db"));
      raw.exec("UPDATE products SET tags = '{not json' WHERE id = 'prod_001'");
      raw.close();

      const reopened = createSqliteStore(dir)!;
      const products = reopened.load()?.products ?? [];
      assert.equal(products.length, 1, "the catalog must survive one unreadable field");
      assert.deepEqual(products[0]?.tags, [], "an unparseable tags blob reads as no tags");
      assert.equal(products[0]?.name, "Widget", "every other field must still be readable");
      reopened.close?.();
    });
  });

  it("reports a version written by a different build rather than assuming this one", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState());
      store.close?.();

      const raw = new DatabaseSync(join(dir, "state.db"));
      raw.exec("UPDATE meta SET value = '99' WHERE key = 'version'");
      raw.close();

      const reopened = createSqliteStore(dir)!;
      const loaded = reopened.load();
      assert.equal(loaded?.version, 99, "the stored version must be reported, not silently rewritten");
      assert.equal(loaded?.products.length, 1, "the data itself must still load");
      reopened.close?.();
    });
  });

  it("reports itself unavailable when the database path cannot be opened", async () => {
    await withTempDir(async (dir) => {
      // A directory where the database file should be: opening it must fail
      // cleanly and warn, because a background child process cannot exit.
      const mkdirSync = (await import("node:fs")).mkdirSync;
      mkdirSync(join(dir, "state.db"));

      const warnings: string[] = [];
      const store = createSqliteStore(dir, (m) => warnings.push(m));

      assert.equal(store, undefined, "an unopenable store must be reported, not thrown");
      assert.ok(warnings.length > 0, "the failure must be explained on stderr");
      assert.match(warnings[0]!, /could not open/i);
    });
  });

  it("imports a legacy state.json once, validating records and keeping the old file", async () => {
    await withTempDir((dir) => {
      const legacy = {
        version: STATE_VERSION,
        products: [
          {
            id: "prod_001",
            name: "Legacy",
            sku: "L-1",
            price: 10,
            inventoryCount: 7,
            category: "tech",
            tags: ["old"],
            description: "From the JSON store.",
          },
          { id: "prod_bad", name: "No category" },
        ],
        orders: [
          {
            id: "ord_1",
            customerName: "Someone",
            items: [{ productId: "prod_001", quantity: 1 }],
            totalAmount: 10,
            status: "pending",
            date: "2026-10-01",
          },
        ],
      };
      writeFileSync(join(dir, "state.json"), JSON.stringify(legacy), "utf8");

      const warnings: string[] = [];
      const store = createSqliteStore(dir, (m) => warnings.push(m))!;
      const loaded = store.load();

      assert.deepEqual(
        loaded?.products.map((p) => p.id),
        ["prod_001"],
        "a malformed record must be dropped, not imported"
      );
      assert.equal(loaded?.orders.length, 1);
      assert.equal(loaded?.products[0]?.inventoryCount, 7, "real state must survive the upgrade");
      assert.ok(
        warnings.some((w) => /malformed/i.test(w)),
        "dropping records must be reported, not silent"
      );
      assert.ok(
        !readdirSync(dir).includes("state.json"),
        "the old file should be renamed, not left to be re-imported"
      );
      assert.ok(readdirSync(dir).includes("state.json.migrated"), "the old file must be kept, not deleted");
      store.close?.();

      // Reopening must not import a second time.
      const again = createSqliteStore(dir)!;
      assert.equal(again.load()?.products.length, 1);
      again.close?.();
    });
  });

  it("does not re-import a legacy file over existing state", async () => {
    await withTempDir((dir) => {
      const store = createSqliteStore(dir)!;
      store.save(makeState({ products: [makeProduct({ id: "prod_current", inventoryCount: 1 })] }));
      store.close?.();

      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({ version: STATE_VERSION, products: [], orders: [] }),
        "utf8"
      );

      const reopened = createSqliteStore(dir)!;
      assert.equal(
        reopened.load()?.products[0]?.id,
        "prod_current",
        "an existing database must win over a legacy file"
      );
      reopened.close?.();
    });
  });
});

describe("ProductIndex", () => {
  const catalog = [
    { id: "p1", name: "AeroBuds Pro", sku: "TCH-AB-001", category: "tech", tags: ["wireless", "audio"] },
    { id: "p2", name: "Merino Sweater", sku: "APP-MS-002", category: "apparel", tags: ["wool"] },
    { id: "p3", name: "Dutch Oven", sku: "HOM-DO-003", category: "home", tags: ["cast-iron", "cookware"] },
  ];

  it("finds a product by a prefix of one of its own tokens", () => {
    const index = new ProductIndex(catalog);
    assert.deepEqual(index.search("aero").map((m) => m.productId), ["p1"]);
    assert.deepEqual(index.search("merino").map((m) => m.productId), ["p2"]);
    assert.deepEqual(index.search("cast").map((m) => m.productId), ["p3"]);
  });

  it("finds a product by its SKU segments", () => {
    const index = new ProductIndex(catalog);
    assert.ok(index.search("tch").some((m) => m.productId === "p1"));
    assert.ok(index.search("002").some((m) => m.productId === "p2"));
  });

  it("returns nothing for a query no token starts with", () => {
    const index = new ProductIndex(catalog);
    assert.deepEqual(index.search("zzz"), []);
    assert.deepEqual(index.search("   "), [], "a blank query matches nothing rather than everything");
  });

  it("scores an exact token above a prefix of a longer one", () => {
    const index = new ProductIndex([
      { id: "exact", name: "Cable", sku: "X", category: "tech", tags: [] },
      { id: "longer", name: "Cable Management Tray", sku: "Y", category: "home", tags: [] },
    ]);
    assert.deepEqual(
      index.search("cable").map((m) => m.productId),
      ["exact", "longer"],
      "an exact token match must outrank a product that merely starts with it"
    );
  });

  it("is deterministic when two products score the same", () => {
    const index = new ProductIndex([
      { id: "b", name: "Same", sku: "B", category: "tech", tags: [] },
      { id: "a", name: "Same", sku: "A", category: "tech", tags: [] },
    ]);
    assert.deepEqual(index.search("same").map((m) => m.productId), ["a", "b"]);
    assert.deepEqual(index.search("same").map((m) => m.productId), ["a", "b"], "repeated runs must agree");
  });

  it("forgets a product that is removed", () => {
    const index = new ProductIndex(catalog);
    index.remove("p1");
    assert.deepEqual(index.search("aero"), []);
    assert.equal(index.size, 2);
  });

  it("ignores a removal for a product it never indexed", () => {
    const index = new ProductIndex(catalog);
    index.remove("never-indexed");
    assert.equal(index.size, 3, "removing an unknown id must be a no-op, not a corruption");
    assert.deepEqual(index.search("aero").map((m) => m.productId), ["p1"]);
  });

  it("indexes a product whose fields include blanks without inventing tokens", () => {
    const index = new ProductIndex([
      { id: "blank", name: "", sku: "   ", category: "tech", tags: ["", "  ", "audio"] },
    ]);
    assert.deepEqual(index.search("audio").map((m) => m.productId), ["blank"]);
    assert.deepEqual(index.search("tech").map((m) => m.productId), ["blank"]);
    // A blank field must not become an empty token that matches everything.
    assert.deepEqual(index.search(" "), [], "blank fields must not become searchable tokens");
  });

  it("replaces a product's tokens when it is re-indexed", () => {
    const index = new ProductIndex(catalog);
    index.index({ id: "p1", name: "Renamed Thing", sku: "NEW-1", category: "home", tags: [] });

    assert.deepEqual(index.search("aero"), [], "the old name must no longer match");
    assert.deepEqual(index.search("renamed").map((m) => m.productId), ["p1"]);
    const afterRename = index.search("tch");
    assert.ok(afterRename.every((m) => m.productId !== "p1"), "the old SKU must no longer match");
  });

  it("is indexable straight from the stored state, tags and all", () => {
    const store = createSqliteStore(mkdtempSync(join(tmpdir(), "project-tango-idx-")))!;
    try {
      store.save(makeState());
      const index = new ProductIndex(store.load()!.products);
      assert.ok(index.search("wireless").some((m) => m.productId === "prod_001"));
    } finally {
      store.close?.();
      // The temp dir is left to the OS; the test's own data is not read again.
    }
  });
});

describe("rankProducts", () => {
  // Imported lazily so the module graph under test is the built one.
  it("keeps every substring match while ordering by match quality", async () => {
    const { filterProducts, rankProducts } = await import("./catalog.js");
    const catalog = [
      { ...makeProduct({ id: "p_desc", name: "Unrelated", tags: ["misc"] }), description: "A cable for everything." },
      { ...makeProduct({ id: "p_tag", name: "Unrelated Two", tags: ["cable"] }), description: "Nothing here." },
    ];

    const matches = filterProducts(catalog, { search: "cable" });
    assert.equal(matches.length, 2, "substring search must still find both");

    const ranked = rankProducts(catalog, "cable").map((p) => p.id);
    assert.equal(ranked.length, 2, "ranking must never drop a match");
    assert.equal(ranked[0], "p_tag", "a product whose own tag is the query ranks first");
  });

  it("leaves order untouched for a blank query", async () => {
    const { rankProducts } = await import("./catalog.js");
    const catalog = [makeProduct({ id: "p1" }), makeProduct({ id: "p2" })];
    assert.deepEqual(
      rankProducts(catalog, "   ").map((p) => p.id),
      ["p1", "p2"]
    );
  });

  it("sorts substring-only matches after indexed ones rather than dropping them", async () => {
    const { rankProducts } = await import("./catalog.js");
    const catalog = [
      makeProduct({ id: "p_late", description: "Has a cable in the prose only." }),
      makeProduct({ id: "p_early", tags: ["cable"] }),
      makeProduct({ id: "p_also_late", description: "Also mentions a cable." }),
    ];

    // `cable` is a prefix of no token in `p_late`/`p_also_late`, so the trie
    // scores neither; the comparator still has to place them rather than treat
    // a missing score as a reason to lose the product. They compare equal, so
    // the stable sort leaves them in the order they arrived in.
    assert.deepEqual(
      rankProducts(catalog, "cable").map((p) => p.id),
      ["p_early", "p_late", "p_also_late"],
      "unscored matches keep their input order, after every scored match"
    );
  });

  it("breaks a scoring tie on product id so the order never depends on input order", async () => {
    const { rankProducts } = await import("./catalog.js");
    const catalog = [
      makeProduct({ id: "p_second", tags: ["cable"] }),
      makeProduct({ id: "p_first", tags: ["cable"] }),
    ];

    assert.deepEqual(rankProducts(catalog, "cable").map((p) => p.id), ["p_first", "p_second"]);
    assert.deepEqual(
      rankProducts([...catalog].reverse(), "cable").map((p) => p.id),
      ["p_first", "p_second"],
      "reversing the input must not reverse the output"
    );
  });
});

describe("state file compatibility", () => {
  it("keeps writing a state.json the old store can read", async () => {
    // Only a guard against the migration test above rotting: the fixture must
    // stay a shape the JSON store would have written.
    await withTempDir((dir) => {
      const dir2 = mkdtempSync(join(tmpdir(), "project-tango-json-"));
      try {
        writeFileSync(join(dir, "state.json"), JSON.stringify(makeState()), "utf8");
        const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
        assert.equal(raw.version, STATE_VERSION);
        assert.ok(Array.isArray(raw.products) && Array.isArray(raw.orders));
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });
  });
});