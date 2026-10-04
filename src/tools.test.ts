import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { connectServer, type ToolResult } from "./testHelpers.js";

/**
 * End-to-end tests that drive the real MCP server over stdio.
 *
 * These complement the per-module unit tests (catalog, orderAnalytics, restock,
 * productCopy): unit tests pin the
 * business logic, while these pin the wiring — tool registration, Zod schemas,
 * the text/JSON envelope, and the write-path guarantees that only exist once the
 * tools are reachable through the protocol.
 */

let client: Client;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "project-tango-tests-"));
  client = await connectServer(dataDir);
});

after(async () => {
  await client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  assert.ok(first?.text, "tool result carried no text content");
  return first.text;
}function payloadOf(result: ToolResult): any {
  return JSON.parse(textOf(result));
}



function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

/** The text of the weekly review prompt, optionally with a category argument. */
async function promptText(args?: Record<string, string>): Promise<string> {
  const result = await client.getPrompt({ name: "weekly_inventory_review", arguments: args });
  return result.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");
}

/** Inventory level for a product id, as the tools currently report it. */
async function stockOf(productId: string): Promise<number> {
  const result = await call("list_all_products", {});
  const product = payloadOf(result).products.find((p: { id: string }) => p.id === productId);
  assert.ok(product, `product ${productId} not found`);
  return product.inventoryCount;
}


// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("exposes exactly the documented tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      "analyze_sales_metrics",
      "draft_product_copy",
      "find_orders",
      "get_low_stock_alerts",
      "list_all_products",
      "reset_demo_state",
      "simulate_order_placement",
      "smart_restock_predictor",
    ]);
  });

  it("advertises an outputSchema for every tool", async () => {
    // A typed outputSchema lets clients validate responses instead of parsing
    // JSON, and tells the model the shape before it calls.
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} declares no outputSchema`);
      assert.ok(
        Object.keys((tool.outputSchema as { properties?: object }).properties ?? {}).length > 0,
        `${tool.name} has an empty outputSchema`
      );
    }
  });
});

describe("structured responses", () => {
  it("returns structuredContent matching the text rendering", async () => {
    const result = await call("list_all_products");
    const structured = result.structuredContent as { count: number; products: unknown[] };

    assert.equal(structured.count, 13);
    assert.equal(structured.products.length, 13);
    assert.deepEqual(JSON.parse(textOf(result)), structured);
  });

  it("sends unindented JSON to keep the response small", async () => {
    const text = textOf(await call("list_all_products"));
    assert.ok(!text.includes("\n"), "response text should not be pretty-printed");
    assert.ok(!text.includes(": "), "response text should not contain indent padding");
  });

  it("reports the data period so stale history is visible", async () => {
    const payload = payloadOf(await call("analyze_sales_metrics"));

    assert.match(payload.period.firstOrderDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(payload.period.lastOrderDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(payload.period.firstOrderDate <= payload.period.lastOrderDate);
  });
});

describe("list_all_products", () => {
  it("returns the full catalog with no filters", async () => {
    const payload = payloadOf(await call("list_all_products"));
    assert.equal(payload.count, 13);
    assert.equal(payload.products.length, 13);
  });

  it("filters by category case-insensitively", async () => {
    const payload = payloadOf(await call("list_all_products", { category: "TECH" }));
    assert.ok(payload.products.length > 0);
    assert.ok(payload.products.every((p: { category: string }) => p.category.toLowerCase() === "tech"));
  });

  it("applies an inclusive price range", async () => {
    const payload = payloadOf(await call("list_all_products", { min_price: 100, max_price: 150 }));
    assert.ok(payload.products.every((p: { price: number }) => p.price >= 100 && p.price <= 150));
  });

  it("finds a product by free-text search", async () => {
    const payload = payloadOf(await call("list_all_products", { search: "merino" }));

    assert.equal(payload.count, 1);
    assert.equal(payload.products[0].name, "Highland Merino Wool Sweater");
    assert.equal(payload.filters.search, "merino");
  });

  it("searches tags and descriptions, not just names", async () => {
    const byTag = payloadOf(await call("list_all_products", { search: "usb-c" }));
    assert.ok(byTag.products.some((p: { sku: string }) => p.sku === "TCH-DV-1TB"));

    const byCategory = payloadOf(await call("list_all_products", { search: "kitchen" }));
    assert.ok(byTag.count > 0 && byCategory.count > 0);
    assert.ok(byCategory.products.every((p: { category: string }) => p.category === "home"));
  });

  it("echoes the filters it applied", async () => {
    const payload = payloadOf(await call("list_all_products", { category: "home" }));
    assert.equal(payload.filters.category, "home");
    assert.equal(payload.filters.min_price, null);
    assert.equal(payload.filters.search, null);
  });

  it("echoes a blank filter as absent rather than as applied", async () => {
    // `search: "   "` trimmed away and returned the whole catalog, yet was
    // echoed as `"   "`; `category: "   "` matched nothing and was echoed the
    // same way. Both now read as "no filter ran", which is what happened.
    const blankSearch = payloadOf(await call("list_all_products", { search: "   " }));
    assert.equal(blankSearch.count, 13);
    assert.equal(blankSearch.filters.search, null);

    const blankCategory = payloadOf(await call("list_all_products", { category: "   " }));
    assert.equal(blankCategory.count, 13);
    assert.equal(blankCategory.filters.category, null);
  });

  it("trims the filters it echoes", async () => {
    const payload = payloadOf(await call("list_all_products", { search: "  merino  " }));

    assert.equal(payload.count, 1);
    assert.equal(payload.filters.search, "merino");
  });

  it("answers an empty result the same way find_orders does", async () => {
    const products = await call("list_all_products", { search: "zzz-nothing-matches" });
    const orders = await call("find_orders", { customer_name: "zzz-nobody" });

    assert.notEqual(products.isError, true);
    assert.notEqual(orders.isError, true);
    assert.equal(payloadOf(products).count, 0);
    assert.equal(payloadOf(orders).count, 0);
  });
});

describe("get_low_stock_alerts", () => {
  it("uses the default threshold of 5 and sorts most urgent first", async () => {
    const payload = payloadOf(await call("get_low_stock_alerts"));

    assert.equal(payload.thresholdUsed, 5);
    assert.equal(payload.alertCount, 6);
    assert.equal(payload.criticalCount, 4);

    const stocks = payload.alerts.map((a: { currentStock: number }) => a.currentStock);
    assert.deepEqual(stocks, [...stocks].sort((a: number, b: number) => a - b));
  });

  it("honours a caller-supplied threshold", async () => {
    const payload = payloadOf(await call("get_low_stock_alerts", { threshold: 1 }));
    assert.equal(payload.thresholdUsed, 1);
    assert.ok(payload.alerts.every((a: { currentStock: number }) => a.currentStock <= 1));
  });

  it("rejects a non-positive threshold at the schema boundary", async () => {
    const result = await call("get_low_stock_alerts", { threshold: 0 });
    assert.equal(result.isError, true);
  });

  it("scopes the scan to one category and echoes the filter that ran", async () => {
    const payload = payloadOf(await call("get_low_stock_alerts", { category: "tech" }));
    assert.deepEqual(payload.filters, { category: "tech" });

    // Seed data: the only low-stock tech products are prod_002 (2) and
    // prod_004 (0) — both critical. The catalog-wide scan returns six.
    assert.equal(payload.alertCount, 2);
    assert.equal(payload.criticalCount, 2);
    // Sorted by stock ascending: prod_004 (0) before prod_002 (2).
    assert.deepEqual(
      payload.alerts.map((a: { productId: string }) => a.productId),
      ["prod_004", "prod_002"]
    );

    const all = payloadOf(await call("get_low_stock_alerts"));
    assert.equal(all.alertCount, 6);
    assert.equal(all.filters.category, null);
  });

  it("treats a blank category as no category", async () => {
    const payload = payloadOf(await call("get_low_stock_alerts", { category: "  " }));
    assert.deepEqual(payload.filters, { category: null });
    assert.equal(payload.alertCount, 6, "a blank category must not filter anything");
  });
});

describe("analyze_sales_metrics", () => {
  it("reports revenue, AOV, top sellers and fulfillment split", async () => {
    const payload = payloadOf(await call("analyze_sales_metrics"));

    assert.ok(payload.orderCount > 0);
    assert.ok(payload.grossRevenue > 0);
    assert.ok(payload.averageOrderValue > 0);
    assert.equal(
      payload.averageOrderValue,
      Math.round((payload.grossRevenue / payload.orderCount) * 100) / 100
    );

    const breakdown = payload.orderFulfillmentBreakdown;
    assert.equal(
      breakdown.pending + breakdown.shipped + breakdown.delivered,
      payload.orderCount
    );

    // Top sellers are ordered by units sold, descending.
    const units = payload.topSellingProducts.map((p: { unitsSold: number }) => p.unitsSold);
    assert.deepEqual(units, [...units].sort((a: number, b: number) => b - a));
  });

  it("reports a daily trend whose buckets reconcile with the totals", async () => {
    const payload = payloadOf(await call("analyze_sales_metrics"));
    const trend = payload.trend;

    assert.equal(trend.granularity, "day"); // 30 days of seed history
    assert.ok(trend.points.length > 0);
    assert.equal(trend.points[0].bucketStart, payload.period.firstOrderDate);
    assert.equal(
      trend.points[trend.points.length - 1].bucketStart,
      payload.period.lastOrderDate
    );

    // Every bucket in order, no gaps or duplicates in the series itself.
    const starts = trend.points.map((p: { bucketStart: string }) => p.bucketStart);
    assert.deepEqual(starts, [...starts].sort());
    assert.equal(new Set(starts).size, starts.length);

    // The series accounts for the whole dataset, so it can be trusted as a
    // view of the same numbers the headline reports.
    const revenueSum = Math.round(
      trend.points.reduce((sum: number, p: { revenue: number }) => sum + p.revenue, 0) * 100
    ) / 100;
    assert.equal(revenueSum, payload.grossRevenue);
    assert.equal(
      trend.points.reduce((sum: number, p: { orders: number }) => sum + p.orders, 0),
      payload.orderCount
    );

    assert.equal(
      trend.recent.orders + trend.previous.orders <= payload.orderCount,
      true
    );
    assert.ok(trend.revenueChangePercent === null || Number.isFinite(trend.revenueChangePercent));
  });

  it("scopes every figure to one category, not just the product list", async () => {
    const scoped = payloadOf(await call("analyze_sales_metrics", { category: "tech" }));
    const all = payloadOf(await call("analyze_sales_metrics"));

    assert.deepEqual(scoped.filters, { category: "tech" });
    assert.equal(all.filters.category, null);

    // Strictly smaller than the whole catalog's numbers: tech is one of three
    // categories, and mixed-category orders contribute only their tech lines.
    assert.ok(scoped.orderCount > 0 && scoped.orderCount <= all.orderCount);
    assert.ok(scoped.grossRevenue < all.grossRevenue);
    assert.equal(
      scoped.averageOrderValue,
      Math.round((scoped.grossRevenue / scoped.orderCount) * 100) / 100
    );

    // Top sellers are tech products — joined against the scoped catalog.
    const techIds = new Set(
      payloadOf(await call("list_all_products", { category: "tech" }))
        .products.map((p: { id: string }) => p.id)
    );
    assert.ok(scoped.topSellingProducts.length > 0);
    assert.ok(scoped.topSellingProducts.every((p: { productId: string }) => techIds.has(p.productId)));

    // The scoped trend still reconciles with the scoped headline totals.
    const trendRevenue = Math.round(
      scoped.trend.points.reduce((sum: number, p: { revenue: number }) => sum + p.revenue, 0) * 100
    ) / 100;
    assert.equal(trendRevenue, scoped.grossRevenue);
    assert.equal(
      scoped.trend.points.reduce((sum: number, p: { orders: number }) => sum + p.orders, 0),
      scoped.orderCount
    );
  });

  it("answers honestly when the category matches no product", async () => {
    const payload = payloadOf(await call("analyze_sales_metrics", { category: "aircraft" }));
    assert.deepEqual(payload.filters, { category: "aircraft" });
    assert.equal(payload.orderCount, 0);
    assert.equal(payload.grossRevenue, 0);
    assert.deepEqual(payload.topSellingProducts, []);
    assert.equal(payload.period.firstOrderDate, null);
  });
});

describe("smart_restock_predictor", () => {
  it("produces actionable recommendations from real demand velocity", async () => {
    const payload = payloadOf(await call("smart_restock_predictor"));

    assert.equal(payload.thresholdUsed, 5);
    assert.equal(payload.window.ordersInWindow, payload.window.totalOrders);
    assert.ok(payload.window.ordersInWindow > 0);

    // The seed data exists so the velocity math yields a real number; a
    // recommendation of 0 or 1 would mean the dataset is too thin again.
    assert.ok(payload.recommendations.length > 0);
    for (const rec of payload.recommendations) {
      assert.equal(rec.basis, "demand_velocity");
      assert.ok(rec.dailyVelocity > 0, `${rec.sku} had no velocity`);
      assert.ok(
        rec.recommendedReorderQuantity > 1,
        `${rec.sku} recommended only ${rec.recommendedReorderQuantity}`
      );
    }
  });

  it("orders recommendations by days of cover ascending, soonest stockout first", async () => {
    const payload = payloadOf(await call("smart_restock_predictor"));
    const covers: (number | null)[] = payload.recommendations.map(
      (r: { daysOfCover: number | null }) => r.daysOfCover
    );

    // Every value must survive JSON: a zero-velocity item would otherwise
    // carry Infinity, which serialises to null and fails outputSchema.
    for (const cover of covers) {
      assert.ok(
        cover === null || Number.isFinite(cover),
        `daysOfCover must be finite or null, got ${cover}`
      );
    }

    const firstNull = covers.findIndex((c) => c === null);
    if (firstNull !== -1) {
      assert.ok(
        covers.slice(firstNull).every((c) => c === null),
        "items with no measurable demand sort last"
      );
    }
    const finite = covers.filter((c): c is number => c !== null);
    assert.deepEqual(finite, [...finite].sort((a, b) => a - b));
  });

  it("only recommends for products at or below the threshold", async () => {
    const payload = payloadOf(await call("smart_restock_predictor", { threshold: 1 }));
    assert.ok(
      payload.recommendations.every((r: { currentStock: number }) => r.currentStock <= 1)
    );
  });

  it("restricts the plan to one category and echoes the filter that ran", async () => {
    const scoped = payloadOf(await call("smart_restock_predictor", { category: "apparel" }));
    assert.deepEqual(scoped.filters, { category: "apparel" });

    // Every recommendation is an apparel product, and the window still
    // describes the whole order history the velocity was measured against.
    const apparelIds = new Set(
      payloadOf(await call("list_all_products", { category: "apparel" }))
        .products.map((p: { id: string }) => p.id)
    );
    assert.ok(scoped.recommendations.length > 0);
    assert.ok(
      scoped.recommendations.every((r: { productId: string }) => apparelIds.has(r.productId))
    );

    const all = payloadOf(await call("smart_restock_predictor"));
    assert.ok(scoped.recommendations.length < all.recommendations.length);
    assert.equal(all.filters.category, null);
  });
});

describe("find_orders", () => {
  it("requires at least one filter", async () => {
    const result = await call("find_orders", {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /at least one filter/);
  });

  it("bounds a broad query on request without pretending the match ended", async () => {
    const full = payloadOf(await call("find_orders", { customer_name: "a" }));
    const capped = payloadOf(await call("find_orders", { customer_name: "a", limit: 5 }));

    // Uncapped: count equals totalMatches equals what was delivered — the
    // invariant that made truncation dishonest in the first place.
    assert.equal(full.limit, null);
    assert.equal(full.count, full.totalMatches);
    assert.equal(full.count, full.orders.length);
    assert.ok(full.totalMatches > 5, "fixture expectation: the broad query must exceed the cap");

    // Capped: exactly limit delivered, newest first — a prefix of the full
    // run — while totalMatches keeps the withheld count visible.
    assert.equal(capped.limit, 5);
    assert.equal(capped.count, 5);
    assert.equal(capped.totalMatches, full.totalMatches);
    assert.deepEqual(
      capped.orders.map((o: { id: string }) => o.id),
      full.orders.slice(0, 5).map((o: { id: string }) => o.id)
    );
  });

  it("returns a customer's orders with lines enriched by product name and price", async () => {
    const payload = payloadOf(await call("find_orders", { customer_name: "maya" }));

    assert.ok(payload.count > 0, "seed data includes Maya Chen orders");
    assert.equal(payload.filters.customer_name, "maya");
    assert.equal(payload.filters.order_id, null);

    for (const order of payload.orders) {
      assert.match(order.customerName, /maya/i);
      assert.ok(order.lines.length > 0);
      for (const line of order.lines) {
        assert.ok(line.productName, "every seed product is catalogued");
        assert.ok(line.quantity > 0);
        // Lines price from the catalog, so they must sum to the stored total.
        assert.equal(
          Math.round(
            order.lines.reduce((sum: number, l: { lineTotal: number }) => sum + l.lineTotal, 0) * 100
          ) / 100,
          order.totalAmount
        );
      }
    }
  });

  it("orders results newest first", async () => {
    const payload = payloadOf(await call("find_orders", { customer_name: "a" }));
    const dates = payload.orders.map((o: { date: string }) => o.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  it("fetches one order by its exact id", async () => {
    const first = payloadOf(await call("find_orders", { customer_name: "maya" })).orders[0];
    const payload = payloadOf(await call("find_orders", { order_id: first.id.toUpperCase() }));

    assert.equal(payload.count, 1);
    assert.equal(payload.orders[0].id, first.id);
    assert.equal(payload.orders[0].customerName, first.customerName);
    assert.deepEqual(payload.orders[0].lines, first.lines);
  });

  it("reports a filter that matched nothing as a success, not an error", async () => {
    // list_all_products already answered "no match" with count 0, and
    // orderLookupSchema declares that shape. Returning an error here made two
    // adjacent read tools disagree about what "nothing matched" means.
    const result = await call("find_orders", { customer_name: "nobody-here" });

    assert.notEqual(result.isError, true);
    const payload = payloadOf(result);
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.orders, []);
    assert.equal(payload.filters.customer_name, "nobody-here");
  });

  it("rejects a request whose only filter is blank", async () => {
    // Guarded on the normalised filters, so a whitespace argument is reported
    // as no filter given rather than as a lookup that matched nothing.
    const result = await call("find_orders", { order_id: "   " });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /at least one filter/);
  });

  it("applies both filters together and echoes only what it applied", async () => {
    const maya = payloadOf(await call("find_orders", { customer_name: "maya" })).orders[0];

    // Same id, someone else's name: the order must not come back.
    const mismatch = payloadOf(
      await call("find_orders", { order_id: maya.id, customer_name: "zzz-not-a-customer" })
    );
    assert.equal(mismatch.count, 0);
    assert.deepEqual(mismatch.orders, []);

    // Both filters satisfied, so the order does — and both are reported as used.
    const agree = payloadOf(
      await call("find_orders", { order_id: maya.id, customer_name: maya.customerName })
    );
    assert.equal(agree.count, 1);
    assert.equal(agree.orders[0].id, maya.id);
    assert.equal(agree.filters.order_id, maya.id);
    assert.equal(agree.filters.customer_name, maya.customerName);
  });

  it("returns every match uncapped, and says so", async () => {
    // A deliberate decision, pinned so it cannot become an accident. The
    // invariant is "nothing is dropped", not any particular number: the seed
    // dataset is 130 orders and "a" happens to match all of them, but against a
    // live provider both figures move. So nothing here is hardcoded to 130.
    const broad = payloadOf(await call("find_orders", { customer_name: "a" }));
    const total = payloadOf(await call("analyze_sales_metrics")).orderCount;

    assert.ok(broad.count > 1, `sanity: a broad query should match several orders, got ${broad.count}`);
    // Whatever `count` claims is actually delivered. A silent cap breaks this.
    assert.equal(broad.orders.length, broad.count, "count must equal what was delivered");
    assert.ok(broad.count <= total, "cannot return more orders than the dataset holds");

    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "find_orders")?.description ?? "";
    assert.match(description, /uncapped/i, "the tool description must disclose it");
    assert.match(description, /no pagination/i);
  });
});

describe("draft_product_copy", () => {
  it("generates copy and SEO tags for a known SKU", async () => {
    const payload = payloadOf(await call("draft_product_copy", { sku: "TCH-AB-001" }));

    assert.equal(payload.sku, "TCH-AB-001");
    assert.ok(payload.copy.headline.length > 0);
    assert.equal(payload.copy.bulletPoints.length, 4);
    assert.equal(new Set(payload.seoTags).size, payload.seoTags.length);
  });

  it("resolves SKUs case-insensitively", async () => {
    const payload = payloadOf(await call("draft_product_copy", { sku: "tch-ab-001" }));
    assert.equal(payload.sku, "TCH-AB-001");
  });

  it("returns a tool error for an unknown SKU", async () => {
    const result = await call("draft_product_copy", { sku: "NOPE-999" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No product found with SKU "NOPE-999"/);
  });
});

describe("prompt and resource", () => {
  it("advertises the weekly inventory review prompt with its argument", async () => {
    const { prompts } = await client.listPrompts();
    const prompt = prompts.find((p) => p.name === "weekly_inventory_review");

    assert.ok(prompt, "prompt not listed");
    assert.match(prompt.description ?? "", /restock/i);
    assert.deepEqual(
      (prompt.arguments ?? []).map((a) => ({ name: a.name, required: a.required })),
      [{ name: "category", required: false }]
    );
  });

  it("returns a message that sequences the tools and names the review sections", async () => {
    const result = await client.getPrompt({ name: "weekly_inventory_review" });
    const text = result.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");

    // Tool calls in the order an operator needs them...
    const positions = ["get_low_stock_alerts", "smart_restock_predictor", "analyze_sales_metrics"].map((t) =>
      text.indexOf(t)
    );
    assert.ok(positions.every((p) => p >= 0), `missing tool in prompt: ${text}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));

    // ...plus the reporting contract that makes it a review rather than a dump.
    assert.match(text, /days of cover/);
    assert.match(text, /reorder/i);
    assert.match(text, /stated plainly rather than guessed/);
  });

  it("scopes the prompt to one category when asked", async () => {
    const result = await client.getPrompt({
      name: "weekly_inventory_review",
      arguments: { category: "tech" },
    });
    const text = result.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");

    assert.match(text, /"tech" category/);
    assert.match(text, /list_all_products/);
  });

  it("gives every step the arguments to call it with", async () => {
    // Bare tool names read as "call these, somehow". Each step carries the
    // arguments it needs — and in a scoped run, that includes the category on
    // every step, because every tool now accepts one.
    const text = await promptText({ category: "tech" });

    assert.match(text, /`list_all_products` \{"category":"tech"\}/);
    assert.match(text, /`get_low_stock_alerts` \{"category":"tech"\}/);
    assert.match(text, /`smart_restock_predictor` \{"category":"tech"\}/);
    assert.match(text, /`analyze_sales_metrics` \{"category":"tech"\}/);
  });

  it("scopes every step it sequences, and says so", async () => {
    const scoped = await promptText({ category: "tech" });

    // The scope is enforced by the arguments themselves — every step receives
    // the category — and the note reports that truthfully.
    assert.match(scoped, /every step below is filtered to the "tech" category/i);
    // The old disclaimer — "only step 1 is category-scoped" — is gone with the
    // gap it apologized for.
    assert.doesNotMatch(scoped, /only step 1 is category-scoped/i);
    assert.doesNotMatch(scoped, /whole catalog/i);

    // Unscoped, there is nothing to claim — and nothing to disclaim.
    const unscoped = await promptText();
    assert.doesNotMatch(unscoped, /Scope:/);
    assert.match(unscoped, /`get_low_stock_alerts` \{\}/);
  });

  it("treats a blank category as no category", async () => {
    const text = await promptText({ category: "   " });

    assert.doesNotMatch(text, /category/);
    assert.match(text, /`get_low_stock_alerts` \{\}/);
  });

  it("exposes the catalog as a readable resource", async () => {
    const { resources } = await client.listResources();
    const catalog = resources.find((r) => r.uri === "tango://catalog");

    assert.ok(catalog, "resource not listed");
    assert.equal(catalog.mimeType, "application/json");

    const { contents } = await client.readResource({ uri: "tango://catalog" });
    const first = contents[0]!;
    assert.ok("text" in first, "catalog resource is served as text, not a blob");
    const parsed = JSON.parse(first.text);
    assert.equal(parsed.length, 13);
    assert.ok(parsed.every((p: { id: string }) => typeof p.id === "string"));
  });
});

describe("simulate_order_placement", () => {
  it("places an order, decrements stock, and computes the total from live prices", async () => {
    const before = await stockOf("prod_003"); // 15, healthy — absent from alert/restock output
    const price = 89.5;

    const result = await call("simulate_order_placement", {
      customer_name: "Integration Test",
      items: [{ product_id: "prod_003", quantity: 2 }],
    });
    const payload = payloadOf(result);

    assert.equal(payload.success, true);
    assert.equal(payload.receipt.customerName, "Integration Test");
    assert.equal(payload.receipt.status, "pending");
    assert.equal(payload.receipt.totalAmount, price * 2);
    assert.equal(payload.receipt.items.length, 1);

    assert.equal(await stockOf("prod_003"), before - 2);
    assert.equal(payload.updatedStockLevels[0].newStock, before - 2);
  });

  it("rejects the whole order without writing when one line is under-stocked", async () => {
    // prod_004 is seeded at 0 stock; prod_007 is healthy.
    const healthyBefore = await stockOf("prod_007");

    const result = await call("simulate_order_placement", {
      customer_name: "Partial Write Test",
      items: [
        { product_id: "prod_007", quantity: 1 },
        { product_id: "prod_004", quantity: 1 },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Order rejected/);
    // The valid line must not have been applied.
    assert.equal(await stockOf("prod_007"), healthyBefore);
  });

  it("rejects duplicate lines that together exceed stock, leaving stock untouched", async () => {
    // Regression: per-line validation drove inventory negative here.
    const before = await stockOf("prod_002"); // seeded at 2

    const result = await call("simulate_order_placement", {
      customer_name: "Duplicate Line Test",
      items: [
        { product_id: "prod_002", quantity: 1 },
        { product_id: "prod_002", quantity: 1 },
        { product_id: "prod_002", quantity: 1 },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /only 2 unit\(s\) in stock, but 3 were requested/);
    assert.equal(await stockOf("prod_002"), before);
  });

  it("never drives inventory below zero", async () => {
    const catalog = payloadOf(await call("list_all_products"));
    for (const product of catalog.products) {
      assert.ok(product.inventoryCount >= 0, `${product.sku} went negative`);
    }
  });

  it("issues unique order ids", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const payload = payloadOf(
        await call("simulate_order_placement", {
          customer_name: `Id Test ${i}`,
          items: [{ product_id: "prod_009", quantity: 1 }],
        })
      );
      ids.push(payload.receipt.id);
    }

    assert.equal(new Set(ids).size, ids.length);
  });

  it("rejects an order for an unknown product id", async () => {
    const result = await call("simulate_order_placement", {
      customer_name: "Ghost Test",
      items: [{ product_id: "prod_999", quantity: 1 }],
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /no product found with id "prod_999"/);
  });

  it("rejects an empty item list at the schema boundary", async () => {
    const result = await call("simulate_order_placement", { customer_name: "Empty", items: [] });
    assert.equal(result.isError, true);
  });

  it("rejects a zero quantity at the schema boundary", async () => {
    const result = await call("simulate_order_placement", {
      customer_name: "Zero",
      items: [{ product_id: "prod_001", quantity: 0 }],
    });
    assert.equal(result.isError, true);
  });

  it("rejects an empty customer name at the schema boundary", async () => {
    const result = await call("simulate_order_placement", {
      customer_name: "",
      items: [{ product_id: "prod_001", quantity: 1 }],
    });
    assert.equal(result.isError, true);
  });

  it("serialises concurrent orders so stock cannot be oversold", async () => {
    // Regression: with no mutual exclusion, ten concurrent two-line orders all
    // validated against the same pre-write snapshot and drove stock to -7. The
    // await between validating and writing is what let them interleave. This now
    // also proves the provider honours DataProvider.transact(), not just the
    // server wiring.
    const SCARCE = "prod_013"; // seeded at 3
    const BULK = "prod_007"; // ample stock, used as the first line
    const starting = await stockOf(SCARCE);

    const attempts = starting + 7;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        call("simulate_order_placement", {
          customer_name: `Concurrent ${i}`,
          items: [
            { product_id: BULK, quantity: 1 },
            { product_id: SCARCE, quantity: 1 },
          ],
        })
      )
    );

    const succeeded = results.filter((r) => !r.isError).length;
    assert.equal(succeeded, starting, "accepted more orders than there was stock for");
    assert.equal(await stockOf(SCARCE), 0);
  });
});

