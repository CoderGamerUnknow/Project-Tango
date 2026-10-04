import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";
import { makeProduct, parse } from "./testHelpers.js";
import type { DataProvider, Order, Product } from "./types.js";

/**
 * The DataProvider seam, exercised in-process.
 *
 * `index.ts` picks the provider and `server.ts` takes it as an argument — so
 * the whole MCP surface can be wired to any DataProvider without spawning a
 * process or touching the module-level mock. These tests are the proof: a
 * stub catalog of two products answers every tool, which is also what a live
 * Shopify/Stripe provider would plug into.
 */
function stubProvider(products: Product[]): DataProvider {
  const orders: Order[] = [];
  const provider: DataProvider = {
    getProducts: () => Promise.resolve(products.map((p) => ({ ...p, tags: [...p.tags] }))),
    getOrders: () =>
      Promise.resolve(orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }))),
    getProductBySku: (sku) => Promise.resolve(products.find((p) => p.sku === sku)),
    updateProductInventory: (id, newCount) => {
      const product = products.find((p) => p.id === id);
      if (product) product.inventoryCount = newCount;
      return Promise.resolve(product);
    },
    addOrder: (order) => {
      orders.push(order);
      return Promise.resolve(order);
    },
    transact: (fn) => fn(provider),
    // Deliberately no `reset`: this provider stands in for a live backend
    // where there is nothing to restore.
  };
  return provider;
}

async function connectInProcess(provider: DataProvider): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer(provider);
  const client = new Client({ name: "project-tango-in-process", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------

describe("createServer with an injected provider", () => {
  it("serves every read tool from the stub catalog, not the global mock", async () => {
    const products = [
      makeProduct({ id: "stub_1", sku: "STUB-1", inventoryCount: 2, category: "tech" }),
      makeProduct({ id: "stub_2", sku: "STUB-2", inventoryCount: 40, category: "home" }),
    ];
    const { client, close } = await connectInProcess(stubProvider(products));

    try {
      const list = parse(await client.callTool({ name: "list_all_products", arguments: {} }));
      assert.deepEqual(
        list.products.map((p: { id: string }) => p.id),
        ["stub_1", "stub_2"]
      );
      assert.equal(list.count, 2);

      const alerts = parse(
        await client.callTool({ name: "get_low_stock_alerts", arguments: {} })
      );
      assert.equal(alerts.alertCount, 1);
      assert.equal(alerts.alerts[0].productId, "stub_1");

      const metrics = parse(
        await client.callTool({ name: "analyze_sales_metrics", arguments: {} })
      );
      assert.equal(metrics.orderCount, 0);
      assert.equal(metrics.grossRevenue, 0);
      assert.deepEqual(metrics.filters, { category: null });
    } finally {
      await close();
    }
  });

  it("runs the write path end to end through the seam", async () => {
    const products = [makeProduct({ id: "stub_1", sku: "STUB-1", inventoryCount: 5 })];
    const { client, close } = await connectInProcess(stubProvider(products));

    try {
      const placed = parse(
        await client.callTool({
          name: "simulate_order_placement",
          arguments: {
            customer_name: "In Process",
            items: [{ product_id: "stub_1", quantity: 2 }],
          },
        })
      );
      assert.equal(placed.success, true);
      assert.equal(placed.updatedStockLevels[0].newStock, 3);

      // The same provider sees the write — the tools share one seam.
      const list = parse(await client.callTool({ name: "list_all_products", arguments: {} }));
      assert.equal(list.products[0].inventoryCount, 3);

      const found = parse(
        await client.callTool({ name: "find_orders", arguments: { customer_name: "In Process" } })
      );
      assert.equal(found.count, 1);
      assert.equal(found.totalMatches, 1);
    } finally {
      await close();
    }
  });

  it("reports a provider that cannot reset instead of pretending it did", async () => {
    const { client, close } = await connectInProcess(stubProvider([]));

    try {
      const result = await client.callTool({ name: "reset_demo_state", arguments: {} });
      assert.equal(result.isError, true);
      const text = ((result.content as Array<{ text?: string }>)[0] ?? {}).text ?? "";
      assert.match(text, /does not support resetting state/);
    } finally {
      await close();
    }
  });

  it("binds the prompt and the resource to the injected provider too", async () => {
    const products = [makeProduct({ id: "stub_1", sku: "STUB-1", inventoryCount: 5 })];
    const { client, close } = await connectInProcess(stubProvider(products));

    try {
      const { prompts } = await client.listPrompts();
      assert.ok(prompts.some((p) => p.name === "weekly_inventory_review"));

      const prompt = await client.getPrompt({
        name: "weekly_inventory_review",
        arguments: { category: "tech" },
      });
      const text = prompt.messages.map((m) => (m.content as { text?: string }).text ?? "").join();
      assert.match(text, /every step below is filtered to the "tech" category/);

      const { resources } = await client.listResources();
      assert.ok(resources.some((r) => r.uri === "tango://catalog"));

      const { contents } = await client.readResource({ uri: "tango://catalog" });
      const first = contents[0]!;
      assert.ok("text" in first);
      assert.deepEqual(JSON.parse(first.text).map((p: { id: string }) => p.id), ["stub_1"]);
    } finally {
      await close();
    }
  });

  it("accepts a scoped call on every tool the review prompt sequences", async () => {
    const products = [
      makeProduct({ id: "stub_1", sku: "STUB-1", inventoryCount: 2, category: "tech" }),
      makeProduct({ id: "stub_2", sku: "STUB-2", inventoryCount: 40, category: "home" }),
    ];
    const { client, close } = await connectInProcess(stubProvider(products));

    try {
      const alerts = parse(
        await client.callTool({ name: "get_low_stock_alerts", arguments: { category: "tech" } })
      );
      assert.deepEqual(alerts.filters, { category: "tech" });
      assert.equal(alerts.alertCount, 1);
      assert.equal(alerts.alerts[0].productId, "stub_1");

      const plan = parse(
        await client.callTool({
          name: "smart_restock_predictor",
          arguments: { category: "tech" },
        })
      );
      assert.deepEqual(plan.filters, { category: "tech" });
      assert.deepEqual(
        plan.recommendations.map((r: { productId: string }) => r.productId),
        ["stub_1"]
      );

      const metrics = parse(
        await client.callTool({ name: "analyze_sales_metrics", arguments: { category: "home" } })
      );
      assert.deepEqual(metrics.filters, { category: "home" });
      assert.equal(metrics.orderCount, 0);
    } finally {
      await close();
    }
  });
});
