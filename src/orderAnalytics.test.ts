import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  aggregateQuantitiesByProduct,
  buildOrder,
  computeSalesMetrics, findOrders, nextOrderId, normaliseOrderLookupFilters, ordersWithinWindow, parseOrderDate, resolveLookbackWindow, revenueByProduct, summarizeUnitsByProduct, unitsSoldForProduct, validateOrderLines } from "./orderAnalytics.js";
import { NOW, makeOrder, makeProduct } from "./testHelpers.js";

/**
 * Order-side analytics: windowing, sales figures, the trend series, order-line
 * validation and ids, and the order drill-down.
 */

describe("parseOrderDate", () => {
  it("pins calendar dates to UTC midnight", () => {
    assert.equal(parseOrderDate("2026-10-01"), Date.parse("2026-10-01T00:00:00.000Z"));
  });

  it("returns NaN for unparseable dates", () => {
    assert.ok(Number.isNaN(parseOrderDate("not-a-date")));
  });
});

describe("resolveLookbackWindow", () => {
  it("anchors the window to the most recent order, not wall-clock today", () => {
    const orders = [
      makeOrder("a", [], { date: "2026-09-10" }),
      makeOrder("b", [], { date: "2026-09-20" }),
      makeOrder("c", [], { date: "2026-09-15" }),
    ];
    const window = resolveLookbackWindow(orders, 30, NOW);

    assert.equal(window.endMs, Date.parse("2026-09-20T00:00:00.000Z"));
    // 30 calendar days inclusive of the anchor day. This asserted 2026-08-21,
    // a 31-day span — the off-by-one that inflated every velocity.
    assert.equal(window.startMs, Date.parse("2026-08-22T00:00:00.000Z"));
  });

  it("ignores orders with unparseable dates when choosing the anchor", () => {
    const orders = [
      makeOrder("a", [], { date: "2026-09-10" }),
      makeOrder("bad", [], { date: "garbage" }),
    ];
    assert.equal(
      resolveLookbackWindow(orders, 30, NOW).endMs,
      Date.parse("2026-09-10T00:00:00.000Z")
    );
  });

  it("falls back to nowMs when there are no orders at all", () => {
    assert.equal(resolveLookbackWindow([], 30, NOW).endMs, NOW);
  });

  it("covers exactly lookbackDays calendar days, counting the anchor day", () => {
    // Regression: the window is inclusive of both bounds, so subtracting the
    // full lookback from the anchor made it span lookbackDays + 1 days while
    // velocity still divided by lookbackDays — inflating every velocity by one
    // day of sales and over-ordering. 30 days back from 2026-10-01 inclusive is
    // 2026-09-02, not 2026-09-01.
    const window = resolveLookbackWindow([], 30, NOW);
    const days = Math.round((window.endMs - window.startMs) / 86_400_000) + 1;

    assert.equal(days, 30);
    assert.equal(new Date(window.startMs).toISOString().slice(0, 10), "2026-09-02");
  });

  it("keeps a zero-day lookback anchored on the anchor day instead of inverting", () => {
    const window = resolveLookbackWindow([], 0, NOW);

    assert.equal(window.startMs, window.endMs);
    assert.equal(window.startMs, NOW);
  });

  it("measures velocity over the same days the window reports", () => {
    // The end-to-end shape of the off-by-one: 1 unit/day for 30 days, plus one
    // order just outside the window, must read as exactly 30 units and 1.0/day.
    const window = resolveLookbackWindow([], 30, NOW);
    const inside = ordersWithinWindow(
      [
        makeOrder("edge", [], { date: new Date(window.startMs).toISOString().slice(0, 10) }),
        makeOrder("anchor", [], { date: new Date(window.endMs).toISOString().slice(0, 10) }),
        makeOrder("before", [], { date: "2026-09-01" }),
      ],
      window
    );

    assert.equal(inside.length, 2, "the day before the window must not be counted");
  });
});

describe("ordersWithinWindow", () => {
  const window = {
    startMs: Date.parse("2026-09-01T00:00:00.000Z"),
    endMs: Date.parse("2026-09-30T00:00:00.000Z"),
  };

  it("includes both bounds inclusively", () => {
    const orders = [
      makeOrder("start", [], { date: "2026-09-01" }),
      makeOrder("end", [], { date: "2026-09-30" }),
      makeOrder("mid", [], { date: "2026-09-15" }),
    ];
    assert.equal(ordersWithinWindow(orders, window).length, 3);
  });

  it("excludes orders outside the window", () => {
    const orders = [
      makeOrder("before", [], { date: "2026-08-31" }),
      makeOrder("after", [], { date: "2026-10-01" }),
    ];
    assert.equal(ordersWithinWindow(orders, window).length, 0);
  });

  it("excludes orders with unparseable dates rather than treating them as recent", () => {
    const orders = [makeOrder("bad", [], { date: "garbage" })];
    assert.equal(ordersWithinWindow(orders, window).length, 0);
  });
});

describe("unitsSoldForProduct", () => {
  it("sums quantities across orders", () => {
    const orders = [
      makeOrder("a", [{ productId: "p1", quantity: 2 }]),
      makeOrder("b", [{ productId: "p1", quantity: 3 }]),
    ];
    assert.equal(unitsSoldForProduct(orders, "p1"), 5);
  });

  it("sums duplicate line items for the same product within one order", () => {
    // Regression: `.find()` stopped at the first line and reported 1 instead of 2.
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 1 }, { productId: "p1", quantity: 1 }])];
    assert.equal(unitsSoldForProduct(orders, "p1"), 2);
  });

  it("returns 0 for a product that was never sold", () => {
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 7 }])];
    assert.equal(unitsSoldForProduct(orders, "other"), 0);
  });
});

describe("summarizeUnitsByProduct", () => {
  it("aggregates across orders and duplicate lines", () => {
    const orders = [
      makeOrder("a", [{ productId: "p1", quantity: 1 }, { productId: "p2", quantity: 2 }]),
      makeOrder("b", [{ productId: "p1", quantity: 4 }]),
    ];
    const summary = summarizeUnitsByProduct(orders);

    assert.equal(summary.get("p1"), 5);
    assert.equal(summary.get("p2"), 2);
  });
});

describe("revenueByProduct", () => {
  it("prices each product from the current catalog", () => {
    const products = [makeProduct({ id: "p1", price: 20 })];
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 3 }], { totalAmount: 60 })];

    assert.equal(revenueByProduct(products, orders).get("p1"), 60);
  });

  it("sums revenue across orders", () => {
    const products = [makeProduct({ id: "p1", price: 10 })];
    const orders = [
      makeOrder("a", [{ productId: "p1", quantity: 1 }], { totalAmount: 10 }),
      makeOrder("b", [{ productId: "p1", quantity: 1 }], { totalAmount: 10 }),
    ];

    assert.equal(revenueByProduct(products, orders).get("p1"), 20);
  });

  it("contributes nothing for products missing from the catalog", () => {
    const orders = [makeOrder("a", [{ productId: "ghost", quantity: 4 }], { totalAmount: 0 })];
    assert.equal(revenueByProduct([], orders).get("ghost"), 0);
  });
});

describe("computeSalesMetrics", () => {
  it("computes gross revenue, AOV, top sellers and fulfillment breakdown", () => {
    const products = [makeProduct({ id: "p1", price: 10 }), makeProduct({ id: "p2", price: 5 })];
    const orders = [
      makeOrder("a", [{ productId: "p1", quantity: 2 }], { totalAmount: 20, status: "delivered" }),
      makeOrder("b", [{ productId: "p2", quantity: 4 }, { productId: "p1", quantity: 1 }], {
        totalAmount: 25,
        status: "pending",
      }),
    ];

    const metrics = computeSalesMetrics(products, orders);

    assert.equal(metrics.orderCount, 2);
    assert.equal(metrics.grossRevenue, 45);
    assert.equal(metrics.averageOrderValue, 22.5);
    assert.deepEqual(metrics.orderFulfillmentBreakdown, { pending: 1, shipped: 0, delivered: 1 });
    assert.equal(metrics.topSellingProducts[0]?.productId, "p2");
    assert.equal(metrics.topSellingProducts[0]?.unitsSold, 4);
    assert.equal(metrics.topSellingProducts[0]?.revenue, 20);
  });

  it("caps top sellers at topN", () => {
    const products = Array.from({ length: 8 }, (_, i) => makeProduct({ id: `p${i}`, price: 1 }));
    const orders = Array.from({ length: 8 }, (_, i) =>
      makeOrder(`o${i}`, [{ productId: `p${i}`, quantity: i + 1 }], { totalAmount: i + 1 })
    );

    assert.equal(computeSalesMetrics(products, orders).topSellingProducts.length, 5);
  });

  it("scopes every figure to a category, re-cutting mixed orders line by line", () => {
    const products = [
      makeProduct({ id: "tech1", category: "tech", price: 10 }),
      makeProduct({ id: "home1", category: "home", price: 50 }),
    ];
    const orders = [
      makeOrder("a", [
        { productId: "tech1", quantity: 2 }, // 20 in tech
        { productId: "home1", quantity: 1 }, // 50 in home — not this scope's revenue
      ], { totalAmount: 70 }),
      makeOrder("b", [{ productId: "home1", quantity: 2 }], { totalAmount: 100 }),
      makeOrder("c", [{ productId: "tech1", quantity: 1 }], { totalAmount: 10 }),
    ];

    const scoped = computeSalesMetrics(products, orders, { category: "tech" });

    // Order "b" has no tech line and drops out; order "a" contributes only
    // its tech lines. Revenue is the category's, not the orders'.
    assert.deepEqual(scoped.filters, { category: "tech" });
    assert.equal(scoped.orderCount, 2);
    assert.equal(scoped.grossRevenue, 30); // 20 + 10
    assert.equal(scoped.averageOrderValue, 15); // 30 / 2
    assert.deepEqual(scoped.orderFulfillmentBreakdown, { pending: 0, shipped: 0, delivered: 2 });
    assert.deepEqual(scoped.topSellingProducts, [
      { productId: "tech1", productName: "Product tech1", unitsSold: 3, revenue: 30 },
    ]);
    assert.equal(scoped.period.firstOrderDate, "2026-10-01");

    // Unscoped reports itself as unscoped and measures the whole dataset.
    const all = computeSalesMetrics(products, orders);
    assert.deepEqual(all.filters, { category: null });
    assert.equal(all.orderCount, 3);
    assert.equal(all.grossRevenue, 180); // 70 + 100 + 10, as recorded

    // A blank category is not a category: same numbers as unscoped.
    const blank = computeSalesMetrics(products, orders, { category: "  " });
    assert.deepEqual(blank.filters, { category: null });
    assert.equal(blank.grossRevenue, 180);
  });

  it("answers with honest zeros when the category matches no product", () => {
    const products = [makeProduct({ id: "p1", category: "tech" })];
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 1 }], { totalAmount: 10 })];

    const metrics = computeSalesMetrics(products, orders, { category: "aircraft" });
    assert.deepEqual(metrics.filters, { category: "aircraft" });
    assert.equal(metrics.orderCount, 0);
    assert.equal(metrics.grossRevenue, 0);
    assert.equal(metrics.averageOrderValue, 0);
    assert.deepEqual(metrics.topSellingProducts, []);
    assert.equal(metrics.period.firstOrderDate, null);
    assert.deepEqual(metrics.trend.points, []);
  });

  it("handles an empty order history without dividing by zero", () => {
    const metrics = computeSalesMetrics([], []);
    assert.equal(metrics.grossRevenue, 0);
    assert.equal(metrics.averageOrderValue, 0);
    assert.deepEqual(metrics.topSellingProducts, []);
  });

  it("labels sales for products missing from the catalog", () => {
    const orders = [makeOrder("a", [{ productId: "ghost", quantity: 1 }], { totalAmount: 5 })];
    const top = computeSalesMetrics([], orders).topSellingProducts[0];

    assert.equal(top?.productName, "Unknown product");
    assert.equal(top?.revenue, 0);
  });
});

describe("computeSalesMetrics trend", () => {
  /** Build an order on a specific date, priced from a single-line item. */
  const on = (date: string, totalAmount: number, quantity = 1) =>
    makeOrder(`ord_${date}`, [{ productId: "p1", quantity }], { date, totalAmount });

  it("buckets every day in the span, including days with no orders", () => {
    const orders = [on("2026-09-28", 10), on("2026-10-01", 40, 3)];
    const trend = computeSalesMetrics([], orders).trend;

    assert.equal(trend.granularity, "day");
    assert.deepEqual(
      trend.points.map((p) => p.bucketStart),
      ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]
    );
    // The gap days are real zeroes, not missing rows.
    assert.deepEqual(
      trend.points.map((p) => p.revenue),
      [10, 0, 0, 40]
    );
    assert.deepEqual(
      trend.points.map((p) => p.units),
      [1, 0, 0, 3]
    );
  });

  it("compares the newest 7 days against the previous 7", () => {
    const orders = [
      on("2026-09-20", 100), // 11 days before the anchor -> previous
      on("2026-09-29", 300), // 2 days before the anchor -> recent
    ];
    const trend = computeSalesMetrics([], orders).trend;

    // Anchored on the latest order date (2026-09-29), so the windows are
    // [2026-09-23..29] and [2026-09-16..22] regardless of the calendar today.
    assert.equal(trend.revenueChangePercent, 200); // 300 vs 100
    assert.equal(trend.recent.start, "2026-09-23");
    assert.equal(trend.recent.end, "2026-09-29");
    assert.equal(trend.previous.start, "2026-09-16");
    assert.equal(trend.previous.end, "2026-09-22");
    assert.equal(trend.previous.orders, 1);
    assert.equal(trend.recent.orders, 1);
  });

  it("excludes the boundary day from the previous period", () => {
    // An order exactly 7 days before the anchor belongs to `recent`, never both.
    const orders = [on("2026-09-24", 50)];
    const trend = computeSalesMetrics([], orders).trend;

    assert.equal(trend.recent.orders, 1);
    assert.equal(trend.previous.orders, 0);
  });

  it("reports null change instead of Infinity when the previous period is empty", () => {
    const orders = [on("2026-10-01", 50)];
    const trend = computeSalesMetrics([], orders).trend;

    assert.equal(trend.previous.revenue, 0);
    assert.equal(trend.revenueChangePercent, null);
    assert.equal(trend.unitsChangePercent, null);
  });

  it("buckets weekly once the history is long", () => {
    const orders = [
 on("2026-01-05", 10), // Monday
      on("2026-04-06", 20), // Monday, 91 days later
    ];
    const trend = computeSalesMetrics([], orders).trend;

    assert.equal(trend.granularity, "week");
    assert.equal(trend.points[0]?.bucketStart, "2026-01-05");
    assert.ok(trend.points.every((p) => p.bucketStart.length === 10));
    assert.ok(trend.points.length < 92, "weekly buckets must collapse the span");
  });

  it("returns an empty trend when there is no order history", () => {
    const trend = computeSalesMetrics([], []).trend;

    assert.deepEqual(trend.points, []);
    assert.equal(trend.revenueChangePercent, null);
    assert.equal(trend.recent.start, null);
    assert.equal(trend.recent.revenue, 0);
  });

  it("uses the latest order date as the anchor, not the wall clock", () => {
    // A fixed 2026 dataset must produce a fixed window regardless of when the
    // test runs, or every date assertion drifts with the calendar.
    const trend = computeSalesMetrics([], [on("2026-03-10", 5)]).trend;

    assert.equal(trend.recent.end, "2026-03-10");
    assert.equal(trend.points[0]?.bucketStart, "2026-03-10");
  });
});

describe("aggregateQuantitiesByProduct", () => {
  it("sums duplicate lines for the same product", () => {
    const aggregated = aggregateQuantitiesByProduct([
      { product_id: "p1", quantity: 1 },
      { product_id: "p2", quantity: 2 },
      { product_id: "p1", quantity: 1 },
    ]);

    assert.equal(aggregated.get("p1"), 2);
    assert.equal(aggregated.get("p2"), 2);
    assert.equal(aggregated.size, 2);
  });
});

describe("validateOrderLines", () => {
  it("accepts an order that fits within stock", () => {
    const products = [makeProduct({ id: "p1", inventoryCount: 5 })];
    const result = validateOrderLines(products, aggregateQuantitiesByProduct([
      { product_id: "p1", quantity: 3 },
    ]));

    assert.equal(result.ok, true);
  });

  it("accepts duplicate lines whose combined quantity fits", () => {
    const products = [makeProduct({ id: "p1", inventoryCount: 2 })];
    const result = validateOrderLines(products, aggregateQuantitiesByProduct([
      { product_id: "p1", quantity: 1 },
      { product_id: "p1", quantity: 1 },
    ]));

    assert.equal(result.ok, true);
  });

  it("rejects duplicate lines whose combined quantity exceeds stock", () => {
    // Regression: validating each line against the pre-order snapshot let
    // 3 x qty 1 pass a stock level of 2 and drove inventory to -1.
    const products = [makeProduct({ id: "p1", inventoryCount: 2 })];
    const result = validateOrderLines(products, aggregateQuantitiesByProduct([
      { product_id: "p1", quantity: 1 },
      { product_id: "p1", quantity: 1 },
      { product_id: "p1", quantity: 1 },
    ]));

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("only 2 unit(s) in stock, but 3 were requested"));
  });

  it("rejects an unknown product id", () => {
    const result = validateOrderLines([], aggregateQuantitiesByProduct([{ product_id: "ghost", quantity: 1 }]));

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes('no product found with id "ghost"'));
  });

  it("rejects before any write when one line in a multi-line order is invalid", () => {
    const products = [
      makeProduct({ id: "ok", inventoryCount: 10 }),
      makeProduct({ id: "short", inventoryCount: 1 }),
    ];
    const result = validateOrderLines(products, aggregateQuantitiesByProduct([
      { product_id: "ok", quantity: 5 },
      { product_id: "short", quantity: 9 },
    ]));

    assert.equal(result.ok, false);
  });
});

describe("nextOrderId", () => {
  it("never collides, even for ids generated in the same millisecond", () => {
    // Regression: a bare Date.now() id handed back duplicate receipts.
    const ids = new Set(Array.from({ length: 500 }, () => nextOrderId(1_700_000_000_000)));
    assert.equal(ids.size, 500);
  });

  it("separates ids minted by two different processes", () => {
    // The sequence is module state, so it restarts at one in every process. Two
    // servers sharing a data directory that placed an order in the same
    // millisecond would mint the same id, and `orders.id` being a primary key
    // turned that into an order that could not be written at all.
    //
    // Both ids come from *fresh* child processes, because that is the only way
    // this is the real scenario: comparing against an id from this process would
    // differ merely because this process's counter has already advanced.
    const NOW = 1_700_000_000_000;
    const mint = () => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `import("./src/orderAnalytics.ts").then((m) => {
             process.stdout.write(m.nextOrderId(${NOW}));
           });`,
        ],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }
      );
      assert.equal(child.status, 0, `child process failed: ${child.stderr}`);
      return child.stdout.trim();
    };

    const first = mint();
    const second = mint();
    assert.match(first, /^ord_/, `unexpected id shape: ${first}`);
    assert.notEqual(
      first,
      second,
      "two pristine processes minting their first id in the same millisecond must differ"
    );
  });

  it("carries the process id, so the id says which server minted it", () => {
    assert.ok(
      nextOrderId(1_700_000_000_000).includes(process.pid.toString(36)),
      "the id must identify its process, or a collision is untraceable"
    );
  });
});

describe("buildOrder", () => {
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
  const lines = [
    { product: makeProduct({ id: "p1", name: "Kettle", price: 49.99, inventoryCount: 10 }), quantity: 2 },
    { product: makeProduct({ id: "p2", name: "Mug", price: 12.5, inventoryCount: 4 }), quantity: 3 },
  ];

  it("prices the order from the catalog, rounded to currency", () => {
    // 2 x 49.99 + 3 x 12.5 = 137.48 exactly; the rounding exists for thirds.
    const { order } = buildOrder(lines, "Maya Chen", NOW);
    assert.equal(order.totalAmount, 137.48);

    const thirds = buildOrder(
      [{ product: makeProduct({ id: "p3", price: 10.005 }), quantity: 3 }],
      "Maya Chen",
      NOW
    );
    assert.equal(thirds.order.totalAmount, 30.02, "rounds to 2dp rather than leaking float noise");
  });

  it("makes the total agree with the catalog price of its own lines", () => {
    const { order } = buildOrder(lines, "Maya Chen", NOW);
    const fromLines = order.items.reduce((sum, item) => {
      const line = lines.find((l) => l.product.id === item.productId)!;
      return sum + line.product.price * item.quantity;
    }, 0);
    assert.ok(Math.abs(order.totalAmount - Math.round(fromLines * 100) / 100) < 1e-9);
  });

  it("derives every stock update from the pre-order snapshot", () => {
    const { stockUpdates } = buildOrder(lines, "Maya Chen", NOW);
    assert.deepEqual(stockUpdates, [
      { productId: "p1", productName: "Kettle", newStock: 8 },
      { productId: "p2", productName: "Mug", newStock: 1 },
    ]);
  });

  it("stamps the order from the injected clock, not the wall clock", () => {
    // Reproducible by construction; the handler used to read Date.now() itself.
    const { order } = buildOrder(lines, "Maya Chen", NOW);
    assert.equal(order.date, "2023-11-14");
    assert.equal(buildOrder(lines, "Maya Chen", NOW).order.date, order.date);
  });

  it("records the customer, a pending status, and one line per input line", () => {
    const { order } = buildOrder(lines, "Maya Chen", NOW);
    assert.equal(order.customerName, "Maya Chen");
    assert.equal(order.status, "pending");
    assert.deepEqual(order.items, [
      { productId: "p1", quantity: 2 },
      { productId: "p2", quantity: 3 },
    ]);
  });

  it("builds a total of zero for no lines", () => {
    const { order, stockUpdates } = buildOrder([], "Nobody", NOW);
    assert.equal(order.totalAmount, 0);
    assert.deepEqual(stockUpdates, []);
  });
});

describe("findOrders", () => {
  const products = [
    makeProduct({ id: "p1", name: "AeroBuds", price: 129.99 }),
    makeProduct({ id: "p2", name: "Merino Sweater", price: 98 }),
  ];
  const orders = [
    makeOrder("ord_1", [{ productId: "p1", quantity: 2 }], {
      customerName: "Maya Chen",
      totalAmount: 259.98,
      date: "2026-09-20",
    }),
    makeOrder("ord_2", [{ productId: "p2", quantity: 1 }], {
      customerName: "Daniel Osei",
      totalAmount: 98,
      date: "2026-09-30",
    }),
    makeOrder("ord_3", [{ productId: "p1", quantity: 1 }], {
      customerName: "Maya Alvarez",
      totalAmount: 129.99,
      date: "2026-10-01",
    }),
  ];

  it("enriches lines with the product name and price", () => {
    const result = findOrders(orders, products, { orderId: "ord_1" });

    assert.equal(result.count, 1);
    assert.deepEqual(result.orders[0]!.lines, [
      { productId: "p1", productName: "AeroBuds", quantity: 2, unitPrice: 129.99, lineTotal: 259.98 },
    ]);
    // The lines and the stored total agree because both price from the catalog.
    assert.equal(
      result.orders[0]!.lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0),
      result.orders[0]!.totalAmount
    );
  });

  it("matches the order id case-insensitively and exactly", () => {
    assert.equal(findOrders(orders, products, { orderId: "ORD_2" }).count, 1);
    assert.equal(findOrders(orders, products, { orderId: "ord_" }).count, 0);
    assert.equal(findOrders(orders, products, { orderId: "ord_1" }).orders[0]!.id, "ord_1");
  });

  it("matches a customer name as a case-insensitive substring", () => {
    const result = findOrders(orders, products, { customerName: "maya" });

    assert.equal(result.count, 2);
    assert.deepEqual(result.orders.map((o) => o.customerName), ["Maya Alvarez", "Maya Chen"]);
  });

  it("returns newest orders first", () => {
    const result = findOrders(orders, products, { customerName: "a" });
    const dates = result.orders.map((o) => o.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  it("reports null rather than inventing data for a product that is gone", () => {
    const orphan = [
      makeOrder("ord_9", [{ productId: "delisted", quantity: 3 }], { customerName: "Maya Chen" }),
    ];

    const line = findOrders(orphan, products, { orderId: "ord_9" }).orders[0]!.lines[0]!;
    assert.equal(line.productName, null);
    assert.equal(line.unitPrice, null);
    assert.equal(line.lineTotal, null);
  });

  it("returns an empty result when nothing matches", () => {
    const result = findOrders(orders, products, { customerName: "nobody" });
    assert.equal(result.count, 0);
    assert.deepEqual(result.orders, []);
    assert.deepEqual(result.filters, { order_id: null, customer_name: "nobody" });
  });

  it("requires an order to satisfy both filters when both are supplied", () => {
    // Short-circuiting on the id returned ord_1 here while echoing both
    // filters, so the caller could not tell it had been handed someone else's
    // order. Both filters now apply together.
    const mismatch = findOrders(orders, products, {
      orderId: "ord_1",
      customerName: "zzz-not-a-customer",
    });
    assert.equal(mismatch.count, 0);
    assert.deepEqual(mismatch.orders, []);

    const agree = findOrders(orders, products, { orderId: "ord_1", customerName: "maya" });
    assert.equal(agree.count, 1);
    assert.equal(agree.orders[0]!.id, "ord_1");

    // Both were honoured, so both are honestly reported.
    assert.deepEqual(agree.filters, { order_id: "ord_1", customer_name: "maya" });
  });

  it("echoes only the filters it applied, so a blank one reads as absent", () => {
    const blank = findOrders(orders, products, { orderId: "   ", customerName: "maya" });
    assert.equal(blank.count, 2);
    assert.deepEqual(blank.filters, { order_id: null, customer_name: "maya" });
  });

  it("matches nothing at all when every filter is blank", () => {
    // Not an order exists: the filters decide, so a request with no usable
    // filter has no answer to give.
    const result = findOrders(orders, products, { orderId: "  ", customerName: "" });
    assert.equal(result.count, 0);
    assert.deepEqual(result.filters, { order_id: null, customer_name: null });
  });

  it("delivers every match uncapped by default, and reports the total", () => {
    const result = findOrders(orders, products, { customerName: "a" });

    assert.equal(result.limit, null);
    assert.equal(result.count, result.orders.length);
    assert.equal(result.totalMatches, result.count);
    assert.ok(result.count >= 2, "fixture expectation: 'a' matches at least the two Mayas");
  });

  it("delivers the newest N when asked, and keeps the withheld count visible", () => {
    const full = findOrders(orders, products, { customerName: "a" });
    const capped = findOrders(orders, products, { customerName: "a" }, 1);

    assert.equal(capped.limit, 1);
    assert.equal(capped.count, 1);
    // totalMatches is the full run's count, so a capped answer still admits
    // how much it did not deliver.
    assert.equal(capped.totalMatches, full.totalMatches);
    assert.ok(full.totalMatches > 1);
    // The delivered order is the newest match — a prefix of the full run.
    assert.equal(capped.orders[0]!.id, full.orders[0]!.id);
  });
});

describe("normaliseOrderLookupFilters", () => {
  it("trims both filters and drops the blanks", () => {
    assert.deepEqual(normaliseOrderLookupFilters({ orderId: "  ord_1  ", customerName: "  " }), {
      orderId: "ord_1",
      customerName: undefined,
    });
  });

  it("reports a blank-only request as no filter at all", () => {
    const normalised = normaliseOrderLookupFilters({ orderId: "   " });
    assert.equal(normalised.orderId, undefined);
    assert.equal(normalised.customerName, undefined);
  });
});
