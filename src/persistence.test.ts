import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { connectServer, parse } from "./testHelpers.js";

/**
 * Lifecycle tests: state that outlives a single server process.
 *
 * These drive real restarts because that is the only way to prove the durable
 * store, the seed-reconcile step and `reset_demo_state` actually work across
 * process boundaries — in-memory assertions would pass regardless.
 */

/** Read one product through an explicitly supplied client. */
async function readProduct(c: Client, id: string): Promise<any> {
  return parse(await c.callTool({ name: "list_all_products", arguments: {} })).products.find(
    (p: { id: string }) => p.id === id
  );
}

describe("suite hygiene", () => {
  it("runs against a throwaway data directory, never the real catalog", () => {
    // `mockData.ts` opens its store — and so creates `state.db` — at import
    // time, so a suite that imports the provider in-process writes to whatever
    // `PROJECT_TANGO_DATA_DIR` says. Left unset, that is `~/.project-tango`, and
    // a test run would overwrite a real catalog. `src/testGlobalSetup.ts` pins
    // the directory for every test process; this fails if the npm scripts ever
    // stop passing it.
    const dir = process.env.PROJECT_TANGO_DATA_DIR;
    assert.ok(dir, "the suite must pin PROJECT_TANGO_DATA_DIR (see src/testGlobalSetup.ts)");
    assert.notEqual(
      resolve(dir),
      join(homedir(), ".project-tango"),
      "the suite must not run against the real ~/.project-tango catalog"
    );
  });
});

/**
 * Run `fn` against a server pinned to a throwaway data directory, optionally
 * pre-seeded with a state file, and able to boot extra sessions to simulate a
 * restart.
 *
 * Cleanup is in `finally` and is not optional: a client left open keeps its child
 * process alive, so a test failing mid-body would hang the whole runner instead
 * of reporting the failure.
 */
async function withSession(
  fn: (boot: (env?: Record<string, string>) => Promise<Client>, dir: string) => Promise<void>,
  seedFile?: string
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "project-tango-e2e-"));
  const opened: Client[] = [];

  try {
    if (seedFile !== undefined) {
      writeFileSync(join(dir, "state.json"), seedFile, "utf8");
    }
    const boot = async (env: Record<string, string> = {}) => {
      const c = await connectServer(dir, env);
      opened.push(c);
      return c;
    };
    await fn(boot, dir);
  } finally {
    for (const c of opened.reverse()) {
      await c.close().catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

describe("reset_demo_state", () => {
  it("discards simulated orders and restores seed inventory", async () => {
    // Without a reset, an agent that places exploratory orders has permanently
    // mutated the catalog and no tool can undo it.
    await withSession(async (boot) => {
      const c = await boot();
      const seeded = (await readProduct(c, "prod_003")).inventoryCount;
      const before = parse(await c.callTool({ name: "analyze_sales_metrics", arguments: {} }));

      await c.callTool({
        name: "simulate_order_placement",
        arguments: {
          customer_name: "Exploratory",
          items: [{ product_id: "prod_003", quantity: 5 }],
        },
      });
      assert.equal((await readProduct(c, "prod_003")).inventoryCount, seeded - 5);

      const reset = parse(await c.callTool({ name: "reset_demo_state", arguments: {} }));
      assert.equal(reset.reset, true);

      assert.equal((await readProduct(c, "prod_003")).inventoryCount, seeded);
      const after = parse(await c.callTool({ name: "analyze_sales_metrics", arguments: {} }));
      assert.equal(after.orderCount, before.orderCount);
    });
  });

  it("survives a restart, so the reset is not merely in memory", async () => {
    await withSession(async (boot) => {
      const first = await boot();
      const seeded = (await readProduct(first, "prod_003")).inventoryCount;

      await first.callTool({
        name: "simulate_order_placement",
        arguments: {
          customer_name: "Before Reset",
          items: [{ product_id: "prod_003", quantity: 3 }],
        },
      });
      await first.callTool({ name: "reset_demo_state", arguments: {} });

      const second = await boot();
      assert.equal((await readProduct(second, "prod_003")).inventoryCount, seeded);
    });
  });

  it("reports what it discarded via structuredContent", async () => {
    await withSession(async (boot) => {
      const c = await boot();
      const result = await c.callTool({ name: "reset_demo_state", arguments: {} });

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.reset, true);
      assert.equal(typeof structured.products, "number");
      assert.equal(typeof structured.orders, "number");
    });
  });

  it("leaves the transaction queue usable after a rejected order", async () => {
    // A rejected order resolves its transaction without writing. If that path
    // rejected the transaction promise, `transact()` would hand the next caller
    // the previous failure and every subsequent write would fail — a single
    // rejected order permanently breaking the write path.
    await withSession(async (boot) => {
      const c = await boot();
      const seeded = (await readProduct(c, "prod_003")).inventoryCount;

      const rejected = await c.callTool({
        name: "simulate_order_placement",
        arguments: { customer_name: "Doomed", items: [{ product_id: "prod_004", quantity: 5 }] },
      });
      assert.equal(rejected.isError, true);

      // Interleave rejections with real writes, then prove the queue still runs.
      const results = await Promise.all([
        c.callTool({ name: "simulate_order_placement", arguments: { customer_name: "Bad", items: [{ product_id: "prod_004", quantity: 1 }] } }),
        c.callTool({ name: "simulate_order_placement", arguments: { customer_name: "Good", items: [{ product_id: "prod_003", quantity: 1 }] } }),
        c.callTool({ name: "simulate_order_placement", arguments: { customer_name: "Also Bad", items: [{ product_id: "prod_004", quantity: 9 }] } }),
        c.callTool({ name: "simulate_order_placement", arguments: { customer_name: "Also Good", items: [{ product_id: "prod_003", quantity: 2 }] } }),
      ]);

      assert.equal(results[0].isError, true, "first order should be rejected");
      assert.equal(results[2].isError, true, "third order should be rejected");
      assert.equal(results[1].isError, undefined, "queue was poisoned by the rejection");
      assert.equal(results[3].isError, undefined, "queue was poisoned by the rejection");

      const final = (await readProduct(c, "prod_003")).inventoryCount;
      assert.equal(final, seeded - 3, "both accepted orders should have applied");
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence across restarts
// ---------------------------------------------------------------------------

describe("persistence", () => {
  const RESTORED_SSD = {
    id: "prod_003",
    name: "DataVault Portable SSD 1TB",
    sku: "TCH-DV-1TB",
    price: 89.5,
    inventoryCount: 4,
    category: "tech",
    tags: ["storage"],
    description: "Restored row, stock already decremented.",
  };

  it("restores inventory decrements and simulated orders after a restart", async () => {
    await withSession(async (boot) => {
      const first = await boot();
      const seeded = await readProduct(first, "prod_003"); // seeded at 15

      const receipt = parse(
        await first.callTool({
          name: "simulate_order_placement",
          arguments: {
            customer_name: "Persisted Customer",
            items: [{ product_id: "prod_003", quantity: 4 }],
          },
        })
      ).receipt;
      assert.equal(receipt.items[0].productId, "prod_003");

      // A fresh process against the same data dir.
      const second = await boot();
      assert.equal((await readProduct(second, "prod_003")).inventoryCount, seeded.inventoryCount - 4);

      const metrics = parse(await second.callTool({ name: "analyze_sales_metrics", arguments: {} }));
      assert.ok(metrics.orderCount > 0, "simulated order did not survive the restart");
    });
  });

  it("keeps state in memory only when persistence is disabled", async () => {
    const volatile = { PROJECT_TANGO_PERSIST: "0" };

    await withSession(async (boot) => {
      const first = await boot(volatile);
      const seeded = await readProduct(first, "prod_003");

      await first.callTool({
        name: "simulate_order_placement",
        arguments: {
          customer_name: "Volatile",
          items: [{ product_id: "prod_003", quantity: 4 }],
        },
      });

      const second = await boot(volatile);
      assert.equal((await readProduct(second, "prod_003")).inventoryCount, seeded.inventoryCount);
    });
  });

  it("re-adds seed products missing from saved state instead of dropping them", async () => {
    // Regression: restored state used to replace the catalog wholesale, so once
    // a state file existed, seed products silently vanished from every tool.
    await withSession(
      async (boot) => {
        const listed = parse(
          await (await boot()).callTool({ name: "list_all_products", arguments: {} })
        );

        // Saved state wins for the product it has...
        assert.equal(
          listed.products.find((p: { id: string }) => p.id === "prod_003").inventoryCount,
          4
        );
        // ...and the other 12 seed products come back rather than disappearing.
        assert.equal(listed.count, 13);
        assert.ok(listed.products.some((p: { id: string }) => p.id === "prod_013"));
      },
      JSON.stringify({ version: 1, products: [RESTORED_SSD], orders: [] })
    );
  });

  it("keeps serving a complete catalog when saved state has a malformed record", async () => {
    // Regression: restored rows were injected into the catalog unchecked, so a
    // product missing `category` made list_all_products and draft_product_copy
    // throw TypeError. Bad records are now dropped and fall back to seed rows.
    await withSession(
      async (boot) => {
        const c = await boot();

        const listed = parse(await c.callTool({ name: "list_all_products", arguments: {} }));
        assert.equal(listed.count, 13);
        assert.equal(
          listed.products.find((p: { id: string }) => p.id === "prod_003").inventoryCount,
          4
        );

        // Every tool still answers rather than erroring on a malformed row.
        for (const [name, args] of [
          ["get_low_stock_alerts", {}],
          ["analyze_sales_metrics", {}],
          ["smart_restock_predictor", {}],
          ["draft_product_copy", { sku: "TCH-DV-1TB" }],
          ["list_all_products", { category: "tech" }],
        ] as const) {
          const result = await c.callTool({ name, arguments: args });
          assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result.content)}`);
        }
      },
      JSON.stringify({
        version: 1,
        products: [RESTORED_SSD, { id: "prod_004", name: "Half a product", sku: "TCH-TC-KB2" }],
        orders: [{ id: "ord_x", items: "not-an-array" }],
      })
    );
  });

  it("keeps the whole catalog when the first write re-reads a partial imported state", async () => {
    // Regression, found by chasing a cross-process read bug. A legacy state file
    // holding one product is imported into `state.db` as one row, and the startup
    // reconcile puts the other twelve seed products back in memory — but a
    // transaction re-reads the store under its lock and adopted that row set
    // verbatim. The server therefore listed thirteen products and then refused an
    // order for one of them with `no product found with id "prod_001"`, and the
    // commit that followed persisted the loss for good.
    await withSession(
      async (boot) => {
        const c = await boot();
        const listed = parse(await c.callTool({ name: "list_all_products", arguments: {} }));
        assert.equal(listed.count, 13);

        // Order a product that only ever existed in the seed catalog.
        const seeded = (await readProduct(c, "prod_001")).inventoryCount;
        const placed = await c.callTool({
          name: "simulate_order_placement",
          arguments: { customer_name: "Seed Only", items: [{ product_id: "prod_001", quantity: 1 }] },
        });
        assert.equal(
          placed.isError,
          undefined,
          `ordering a listed product failed: ${JSON.stringify(placed.content)}`
        );
        assert.equal((await readProduct(c, "prod_001")).inventoryCount, seeded - 1);

        // And the repair is durable: the commit writes the reconciled catalog, so
        // the stored state is healed rather than eroded. A restart reads the
        // database directly, so it is the only thing that can prove that.
        const restarted = await boot();
        const after = parse(await restarted.callTool({ name: "list_all_products", arguments: {} }));
        assert.equal(after.count, 13, "the stored catalog must not have kept the erosion");
        assert.equal(
          after.products.find((p: { id: string }) => p.id === "prod_001").inventoryCount,
          seeded - 1
        );
      },
      JSON.stringify({ version: 1, products: [RESTORED_SSD], orders: [] })
    );
  });

  it("shows one running server another's order without a restart", async () => {
    // MCP clients keep a server process alive for a whole conversation, and a
    // second window (or a second tool) can be writing at the same time. Reads
    // used to be served from the process's own copy, which only caught up when
    // this process wrote something itself.
    await withSession(async (boot) => {
      const [reader, writer] = await Promise.all([boot(), boot()]);
      const seeded = (await readProduct(reader, "prod_001")).inventoryCount;

      const placed = await writer.callTool({
        name: "simulate_order_placement",
        arguments: { customer_name: "Other Process", items: [{ product_id: "prod_001", quantity: 3 }] },
      });
      assert.equal(placed.isError, undefined);

      assert.equal(
        (await readProduct(reader, "prod_001")).inventoryCount,
        seeded - 3,
        "the idle server must serve the committed stock, not its own stale copy"
      );

      const found = parse(
        await reader.callTool({ name: "find_orders", arguments: { customer_name: "Other Process" } })
      );
      assert.equal(found.count, 1, "the other process's order must be visible here too");
    });
  });

  it("stays current and consistent under a sustained read loop", async () => {
    // The single-rival test proves the mechanism once. This is the shape it
    // actually runs in: a server answering a stream of reads for a whole
    // conversation while another one writes repeatedly underneath it. What
    // matters is not the first stale read — it is a reader whose position drifts
    // further and further behind, that never converges, or that is handed a
    // catalog mid-write and takes a tool down with it. None of that shows up in a
    // single interleaving; it needs the two processes running long enough for the
    // drift to accumulate.
    await withSession(async (boot) => {
      const [reader, writer] = await Promise.all([boot(), boot()]);

      // Demand is spread across the four best-stocked products (42/60/27/23) so a
      // long soak cannot simply run one line to zero and then fail for a reason
      // that has nothing to do with freshness.
      const POOL = ["prod_001", "prod_009", "prod_012", "prod_005"];
      const QTY = 2;
      const WRITES = 40;
      const TOTAL_REMOVED = WRITES * QTY;
      // How far behind the last commit a read may be, in commits. Measured
      // across this soak the healthy reader never lags at all; one commit of
      // slack is the one race that cannot be closed — a write landing between
      // the token check and the reload is legitimately not in the snapshot the
      // read is serving. Two means the token check has stopped working and the
      // reader is coasting on an old catalog.
      const MAX_LAG_COMMITS = 1;
      // How many reads the reader may need, after the writer goes quiet, before
      // it must be current.
      const CONVERGENCE_BOUND = 3;
      // Enough headroom that the reader is never what ends the run.
      const READ_CAP = WRITES * 40;
      // Pause between reads, so the writer can get ahead between two of them.
      //
      // Without this the bound below is decorative. Measured on this project, a
      // committed order costs ~4.3x a `list_all_products` read, so with both
      // loops running flat out the writer commits only ~0.17 times per read and
      // *at most one* commit ever lands between two consecutive reads. Lag can
      // therefore never accumulate, `worstLag` is structurally pinned at 0, and
      // the test would pass just as happily against a server that refreshed its
      // catalog once every ten reads — which is the precise defect the bound
      // exists to catch. (Raising the writer's concurrency did not help: eight
      // orders in flight still only put two commits in a single read gap.)
      //
      // A pause is not a fudge — an MCP client is never zero-latency. There is a
      // process hop and a model deciding what to ask next between two calls, so
      // a few milliseconds per read is if anything generous. At 4ms roughly
      // three quarters of read gaps carry two or more commits, which is the
      // regime where the bound can actually distinguish a fresh reader from a
      // lazy one. `pressure` below asserts we really are in that regime.
      const READ_THINK_MS = 4;

      // What the writer has committed, per product. The reader's job is to match
      // it; this map is the truth it is measured against.
      const committed = new Map<string, number>();
      for (const id of POOL) committed.set(id, (await readProduct(reader, id)).inventoryCount);

      let removed = 0;
      const stockOf = (listed: any, id: string) =>
        listed.products.find((p: { id: string }) => p.id === id).inventoryCount;

      const lastSeen = new Map<string, number>();
      const distinct = new Map<string, Set<number>>();
      for (const id of POOL) distinct.set(id, new Set<number>());
      let readCount = 0;
      let worstLag = 0;
      let failedRead: Error | undefined;
      // Commits that landed between one read and the next. This is the
      // quantity that decides whether the lag bound means anything: if it never
      // exceeds 1, no reader could ever violate `MAX_LAG_COMMITS`, and the test
      // is measuring its own timing rather than the server.
      const commitGaps: number[] = [];

      // Read continuously while the writer commits underneath. Nothing waits for
      // the other side, which is the whole point.
      const reading = (async () => {
        let commitsAtLastRead = 0;
        while (removed < TOTAL_REMOVED && readCount < READ_CAP) {
          try {
            const listed = parse(await reader.callTool({ name: "list_all_products", arguments: {} }));
            assert.equal(listed.count, 13, "a read mid-write must still return a whole catalog");
            // `removed` only moves on a *committed* order, so this is exactly the
            // number of commits the writer finished while this read was in
            // flight — the lag the reader had to absorb before serving.
            commitGaps.push(removed / QTY - commitsAtLastRead);
            commitsAtLastRead = removed / QTY;
            for (const id of POOL) {
              const stock = stockOf(listed, id);
              assert.ok(stock >= 0, `stock must never be observed negative (${id})`);
              // Monotonic per product: committed stock only ever goes down, so a
              // value above the last one would mean this read served something
              // older than a read that had already seen a later commit.
              const previous = lastSeen.get(id);
              if (previous !== undefined) {
                assert.ok(
                  stock <= previous,
                  `${id} went backwards across reads: ${previous} then ${stock}`
                );
              }
              lastSeen.set(id, stock);
              distinct.get(id)!.add(stock);
              worstLag = Math.max(worstLag, (committed.get(id)! - stock) / QTY);
            }
            readCount += 1;
          } catch (error) {
            failedRead = error instanceof Error ? error : new Error(String(error));
            return;
          }
          if (READ_THINK_MS > 0) await delay(READ_THINK_MS);
        }
      })();

      const writing = (async () => {
        for (let i = 0; i < WRITES; i++) {
          const id = POOL[i % POOL.length]!;
          const placed = await writer.callTool({
            name: "simulate_order_placement",
            arguments: { customer_name: `Stream ${i}`, items: [{ product_id: id, quantity: QTY }] },
          });
          assert.equal(placed.isError, undefined, `write ${i} against ${id} failed`);
          committed.set(id, committed.get(id)! - QTY);
          removed += QTY;
        }
      })();

      await writing;
      await reading;

      if (failedRead) throw failedRead;
      for (const [id, want] of committed) {
        assert.equal(
          (await readProduct(reader, id)).inventoryCount,
          want,
          `the reader must end on the committed value for ${id}, not somewhere behind it`
        );
      }
      // It followed the stream instead of jumping once at the end. A reader that
      // only refreshed on its own writes would see each product's starting value
      // and its final one and nothing in between — precisely the defect pinned
      // here — so every product must have been seen moving.
      for (const [id, seen] of distinct) {
        assert.ok(
          seen.size >= 3,
          `the reader saw ${seen.size} distinct stock levels for ${id} across the soak — it is not following the stream`
        );
      }
      assert.ok(
        worstLag <= MAX_LAG_COMMITS,
        `a read was ${worstLag} commits behind the writer; the bound is ${MAX_LAG_COMMITS}`
      );

      // The bound above is only worth anything if the run ever presented the
      // reader with a real gap to absorb. This is the assertion that keeps the
      // soak honest: it fails when the two sides are so badly paced that lag
      // cannot accumulate at all, which is the state in which the test would
      // report a healthy server while proving nothing about it.
      //
      // Without this, slowing the writer or speeding the reader turns the whole
      // case into a tautology — and nothing about the *code* would have
      // changed. A guard is a promise about what was exercised, not only about
      // what came out.
      const pressured = commitGaps.filter((gap) => gap >= 2).length;
      assert.ok(
        pressured > 0,
        `no read ever had to absorb two or more commits (${commitGaps.length} gaps, ` +
          `max ${Math.max(0, ...commitGaps)}) — the reader was never actually behind, so ` +
          `this run cannot distinguish a fresh reader from a lazy one. Raise READ_THINK_MS ` +
          `or make the writes cheaper.`
      );

      // The property that actually matters, stated as a bound: once the writer
      // goes quiet, how many reads does the reader need to become current?
      // "Eventually" is not a guarantee anyone can build on; "within a few reads
      // of the last commit" is.
      let readsToConverge = 0;
      let stale = POOL.filter((id) => (lastSeen.get(id) ?? NaN) !== committed.get(id));
      while (stale.length > 0 && readsToConverge < CONVERGENCE_BOUND) {
        readsToConverge += 1;
        const listed = parse(await reader.callTool({ name: "list_all_products", arguments: {} }));
        stale = POOL.filter((id) => stockOf(listed, id) !== committed.get(id));
      }
      assert.equal(
        stale.length,
        0,
        `the reader was still behind on ${stale.join(", ")} after ${readsToConverge} reads past the last commit`
      );
    });
  });

  it("starts from the seed dataset when the state file is corrupt, without crashing", async () => {
    await withSession(async (boot) => {
      const c = await boot();
      assert.equal(
        (await readProduct(c, "prod_003")).inventoryCount,
        15,
        "should have fallen back to the seed catalog"
      );

      // The server is still fully usable after the bad read.
      const result = await c.callTool({
        name: "simulate_order_placement",
        arguments: {
          customer_name: "After Corruption",
          items: [{ product_id: "prod_003", quantity: 1 }],
        },
      });
      assert.notEqual(result.isError, true);
    }, "{ this is not json");
  });

  it("starts from the seed dataset when the state file version is unknown", async () => {
    await withSession(async (boot) => {
      assert.equal((await readProduct(await boot(), "prod_003")).inventoryCount, 15);
    }, JSON.stringify({ version: 999, products: [], orders: [] }));
  });

  it("starts from the seed dataset when the state file has an unexpected shape", async () => {
    await withSession(async (boot) => {
      assert.equal((await readProduct(await boot(), "prod_003")).inventoryCount, 15);
    }, JSON.stringify({ hello: "world" }));
  });
});

// ---------------------------------------------------------------------------

describe("concurrent server processes", () => {
  it("loses no writes when two server processes race on one data directory", async () => {
    // This is the test the SQLite store exists for. Under the old whole-snapshot
    // JSON store both processes loaded the seed before either saved, so the
    // second save silently discarded the first process's order — the documented
    // "last-writer-wins" caveat. `BEGIN IMMEDIATE` makes each transaction read
    // the state as of the moment it took the lock, so both orders must survive.
    await withSession(async (boot) => {
      const first = await boot();
      const second = await boot();

      const place = async (c: Client) =>
        parse(
          await c.callTool({
            name: "simulate_order_placement",
            arguments: {
              customer_name: "Race Writer",
              items: [{ product_id: "prod_001", quantity: 5 }],
            },
          })
        );

      let placed: any[] = [];
      try {
        placed = await Promise.all([place(first), place(second)]);
      } finally {
        await first.close();
        await second.close();
      }

      for (const receipt of placed) {
        assert.equal(receipt.success, true, "both orders had stock available and must succeed");
      }

      // A fresh process must see both orders and the stock both of them removed.
      // Under last-writer-wins this was 143 orders and 37 units; the guarantee
      // now is 144 orders and 32.
      const third = await boot();
      try {
        const list = parse(await third.callTool({ name: "list_all_products", arguments: {} }));
        assert.equal(list.count, 13, "the catalog must still be complete");
        const stock = list.products.find((p: { id: string }) => p.id === "prod_001");
        assert.equal(
          stock.inventoryCount,
          42 - 10,
          `both orders must be reflected in stock; saw ${stock.inventoryCount}, expected 32`
        );

        const orders = parse(
          await third.callTool({ name: "find_orders", arguments: { customer_name: "Race Writer" } })
        );
        assert.equal(orders.count, 2, "neither process's order may be lost to the other");
        const ids = new Set(orders.orders.map((o: { id: string }) => o.id));
        assert.equal(ids.size, 2, "the two orders must have distinct ids");
      } finally {
        await third.close();
      }
    });
  });

  it("never oversells when more orders race than there is stock for", async () => {
    // The same lock, exercised against genuinely contested stock: 10 attempts at
    // 5 units against a seed of 42 can only fill 8 orders, and the store must
    // refuse the rest rather than drive inventory negative.
    await withSession(async (boot) => {
      const clients = await Promise.all(Array.from({ length: 4 }, () => boot()));
      const stockBefore = parse(
        await clients[0]!.callTool({ name: "list_all_products", arguments: {} })
      ).products.find((p: { id: string }) => p.id === "prod_001").inventoryCount;

      const place = async (c: Client) =>
        c.callTool({
          name: "simulate_order_placement",
          arguments: {
            customer_name: "Contested",
            items: [{ product_id: "prod_001", quantity: 5 }],
          },
        });

      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => place(clients[i % clients.length]!))
        );
        // A refusal carries a plain-sentence error, not JSON, so results are
        // classified by `isError` before anything tries to parse them.
        const accepted = results.filter((r) => r.isError !== true);
        const refused = results.filter((r) => r.isError === true);
        const capacity = Math.floor(stockBefore / 5);

        assert.equal(
          accepted.length,
          capacity,
          `exactly ${capacity} orders of 5 should fit in ${stockBefore} units, got ${accepted.length}`
        );
        for (const receipt of accepted) {
          assert.equal(parse(receipt).success, true);
        }
        for (const loser of refused) {
          assert.match(
            (loser.content as Array<{ text: string }>)[0]!.text,
            /Order rejected/,
            "every refused order must say why"
          );
        }

        const verifier = await boot();
        try {
          const list = parse(await verifier.callTool({ name: "list_all_products", arguments: {} }));
          const stock = list.products.find((p: { id: string }) => p.id === "prod_001");
          assert.equal(stock.inventoryCount, stockBefore - accepted.length * 5);
          assert.ok(stock.inventoryCount >= 0, "inventory must never go negative");
        } finally {
          await verifier.close();
        }
      } finally {
        await Promise.all(clients.map((c) => c.close()));
      }
    });
  });

  it("still publishes a complete, untorn snapshot when the JSON store is forced", async () => {
    // `PROJECT_TANGO_STORE=json` keeps the old whole-snapshot backend available,
    // and its guarantee is narrower by design: never a torn file, but still
    // last-writer-wins. Pinning that here documents exactly what the fallback
    // does and does not promise.
    await withSession(async (boot, dir) => {
      const first = await boot({ PROJECT_TANGO_STORE: "json" });
      const second = await boot({ PROJECT_TANGO_STORE: "json" });

      const place = async (c: Client) =>
        c.callTool({
          name: "simulate_order_placement",
          arguments: {
            customer_name: "Json Writer",
            items: [{ product_id: "prod_001", quantity: 1 }],
          },
        });

      try {
        await Promise.all([place(first), place(second)]);
      } finally {
        await first.close();
        await second.close();
      }

      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      assert.equal(state.version, 1);
      assert.equal(state.products.length, 13);
      assert.ok(
        state.orders.length === 143 || state.orders.length === 144,
        `JSON store should hold seed + at most one race order, saw ${state.orders.length}`
      );
      assert.ok(state.products.every((p: { inventoryCount: number }) => p.inventoryCount >= 0));
      assert.ok(
        !readdirSync(dir).some((f) => f.includes(".tmp")),
        "temp files must not be left behind"
      );
    });
  });
});