import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  it("publishes one complete state file when two writers race, never a torn mix", async () => {
    await withSession(async (boot, dir) => {
      const first = await boot();
      const second = await boot();

      const place = async (c: Client) =>
        parse(
          await c.callTool({
            name: "simulate_order_placement",
            arguments: {
              customer_name: "Race Writer",
              items: [{ product_id: "prod_001", quantity: 1 }],
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
        assert.equal(receipt.success, true);
      }

      // Both processes loaded the seed before either saved (state is read at
      // startup), so the surviving file is one writer's complete snapshot:
      // seed (142 orders) plus at most one of the two — 143, or 144 if one
      // process saved before the other read. What must never appear is a torn
      // interleaving of both: that is what the per-write temp file prevents.
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      assert.equal(state.version, 1);
      assert.equal(state.products.length, 13);
      assert.ok(
        state.orders.length === 143 || state.orders.length === 144,
        `state should hold seed + at most one race order, saw ${state.orders.length}`
      );
      assert.ok(
        state.products.every((p: { inventoryCount: number }) => p.inventoryCount >= 0),
        "no product may go negative in a race"
      );
      assert.ok(
        !readdirSync(dir).some((f) => f.includes(".tmp")),
        "temp files must not be left behind"
      );

      // Last-writer-wins is a documented limitation; unusable state is not.
      // A fresh process must serve the surviving snapshot.
      const third = await boot();
      try {
        const list = parse(await third.callTool({ name: "list_all_products", arguments: {} }));
        assert.equal(list.count, 13);
      } finally {
        await third.close();
      }
    });
  });
});