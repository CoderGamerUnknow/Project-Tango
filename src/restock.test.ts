import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRestockPlan, RESTOCK_POLICY } from "./restock.js";
import { NOW, makeOrder, makeProduct } from "./testHelpers.js";

/**
 * Restock planning: velocity, days of cover, and reorder quantities.
 */

/**
 * The plan assumptions every case shares; each one overrides `threshold`.
 *
 * Written as literals rather than spread from `RESTOCK_POLICY` on purpose. The
 * assertions below are numbers — "60 units / 30 days = 2/day" — and deriving
 * them from the policy would make them restate the policy instead of pinning it.
 */
const RESTOCK_PARAMS = {
  supplierLeadTimeDays: 14,
  safetyStockDays: 7,
  salesLookbackDays: 30,
  fallbackRestockQuantity: 20,
};

/**
 * The fixture stands in for the shipped policy, so the two must not drift.
 *
 * Deriving it from `RESTOCK_POLICY` would tie the knot instead of testing it —
 * the assertions above are arithmetic ("60 units / 30 days = 2/day"), and sourcing
 * their inputs from the code under test would make them restate that code rather
 * than pin it. Asserting the agreement is the way to keep both properties at once.
 */
function paramsAgreeWithPolicy(): boolean {
  return (
    RESTOCK_PARAMS.supplierLeadTimeDays === RESTOCK_POLICY.supplierLeadTimeDays &&
    RESTOCK_PARAMS.safetyStockDays === RESTOCK_POLICY.safetyStockDays &&
    RESTOCK_PARAMS.salesLookbackDays === RESTOCK_POLICY.salesLookbackDays &&
    RESTOCK_PARAMS.fallbackRestockQuantity === RESTOCK_POLICY.fallbackRestockQuantity
  );
}

describe("computeRestockPlan", () => {
  it("derives reorder quantity from velocity across lead time plus safety stock", () => {
    // 60 units / 30 days = 2/day; 2 * 21 days = 42 projected; 42 - 10 stock = 32.
    const products = [makeProduct({ id: "p1", inventoryCount: 10 })];
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 60 }], { date: "2026-09-30" })];

    const plan = computeRestockPlan(products, orders, {
      ...RESTOCK_PARAMS,
      threshold: 20,
      nowMs: NOW,
    });
    const rec = plan.recommendations[0];

    assert.equal(rec?.dailyVelocity, 2);
    assert.equal(rec?.basis, "demand_velocity");
    assert.equal(rec?.unitsSoldInWindow, 60);
    assert.equal(rec?.recommendedReorderQuantity, 32);
    assert.equal(rec?.daysOfCover, 5); // 10 stock / 2 per day
  });

  it("never recommends a negative quantity when stock already exceeds projected demand", () => {
    const products = [makeProduct({ id: "p1", inventoryCount: 100 })];
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 3 }], { date: "2026-09-30" })];

    const rec = computeRestockPlan(products, orders, {
      ...RESTOCK_PARAMS,
      threshold: 150,
      nowMs: NOW,
    }).recommendations[0];

    assert.equal(rec?.recommendedReorderQuantity, 0);
  });

  it("excludes orders outside the lookback window from velocity", () => {
    // Regression: history older than the window was divided by the same
    // 30-day denominator, understating velocity.
    const products = [makeProduct({ id: "p1", inventoryCount: 0 })];
    const orders = [
      makeOrder("old", [{ productId: "p1", quantity: 60 }], { date: "2026-01-01" }),
      makeOrder("recent", [{ productId: "p1", quantity: 30 }], { date: "2026-09-30" }),
    ];

    const plan = computeRestockPlan(products, orders, { ...RESTOCK_PARAMS, threshold: 5, nowMs: NOW });

    assert.equal(plan.window.ordersInWindow, 1);
    assert.equal(plan.window.totalOrders, 2);
    assert.equal(plan.recommendations[0]?.unitsSoldInWindow, 30);
  });

  it("falls back to a flat quantity when there is no sales history", () => {
    const products = [makeProduct({ id: "p1", inventoryCount: 3 })];
    const orders = [makeOrder("a", [{ productId: "other", quantity: 5 }], { date: "2026-09-30" })];

    const rec = computeRestockPlan(products, orders, {
      ...RESTOCK_PARAMS,
      threshold: 5,
      nowMs: NOW,
    }).recommendations[0];

    assert.equal(rec?.basis, "fallback_flat_rate");
    assert.equal(rec?.recommendedReorderQuantity, 17); // 20 - 3
    // No velocity means no measurable runway — and no Infinity leaking into JSON.
    assert.equal(rec?.daysOfCover, null);
  });

  it("only considers products at or below the threshold", () => {
    const products = [
      makeProduct({ id: "low", inventoryCount: 2 }),
      makeProduct({ id: "high", inventoryCount: 40 }),
    ];
    const plan = computeRestockPlan(products, [], {
      ...RESTOCK_PARAMS,
      threshold: 5,
      nowMs: NOW,
    });

    assert.deepEqual(plan.recommendations.map((r) => r.productId), ["low"]);
  });

  it("orders recommendations by days of cover ascending, soonest stockout first", () => {
    const products = [
      makeProduct({ id: "slow", inventoryCount: 4 }),
      makeProduct({ id: "fast", inventoryCount: 0 }),
    ];
    const orders = [
      makeOrder("a", [{ productId: "fast", quantity: 60 }], { date: "2026-09-30" }),
    ];

    const plan = computeRestockPlan(products, orders, {
      ...RESTOCK_PARAMS,
      threshold: 5,
      nowMs: NOW,
    });

    assert.deepEqual(plan.recommendations.map((r) => r.productId), ["fast", "slow"]);
    assert.deepEqual(
      plan.recommendations.map((r) => r.daysOfCover),
      [0, null]
    );
  });

  it("puts a hungrier item first even when its reorder quantity is smaller", () => {
    // Regression: sorting by reorder quantity ranked the bigger buy first, so
    // the item days from running out sat behind one with weeks of cover.
    const products = [
      makeProduct({ id: "restocked", inventoryCount: 10 }), // 2/day -> 5 days of cover, reorder 32
      makeProduct({ id: "urgent", inventoryCount: 1 }), // 0.5/day -> 2 days of cover, reorder 10
    ];
    const orders = [
      makeOrder("a", [{ productId: "restocked", quantity: 60 }], { date: "2026-09-30" }),
      makeOrder("b", [{ productId: "urgent", quantity: 15 }], { date: "2026-09-30" }),
    ];

    const plan = computeRestockPlan(products, orders, {
      ...RESTOCK_PARAMS,
      threshold: 150,
      nowMs: NOW,
    });

    assert.deepEqual(plan.recommendations.map((r) => r.productId), ["urgent", "restocked"]);
    assert.ok(
      plan.recommendations[0]!.recommendedReorderQuantity <
        plan.recommendations[1]!.recommendedReorderQuantity,
      "the urgency-first order must disagree with the old quantity-first order"
    );
    assert.deepEqual(
      plan.recommendations.map((r) => r.daysOfCover),
      [2, 5]
    );
  });

  it("reports the resolved window bounds", () => {
    const orders = [makeOrder("a", [{ productId: "p1", quantity: 5 }], { date: "2026-09-20" })];
    const plan = computeRestockPlan([makeProduct({ id: "p1", inventoryCount: 1 })], orders, {
      ...RESTOCK_PARAMS,
      threshold: 5,
      nowMs: NOW,
    });

    assert.equal(plan.window.end, "2026-09-20");
    assert.equal(plan.window.start, "2026-08-21");
  });

  it("restricts the plan to one category and echoes what it applied", () => {
    const products = [
      makeProduct({ id: "t1", category: "tech", inventoryCount: 1 }),
      makeProduct({ id: "h1", category: "home", inventoryCount: 2 }),
    ];

    const plan = computeRestockPlan(products, [], {
      ...RESTOCK_PARAMS,
      threshold: 5,
      category: "tech",
      nowMs: NOW,
    });

    assert.deepEqual(plan.filters, { category: "tech" });
    assert.deepEqual(plan.recommendations.map((r) => r.productId), ["t1"]);

    // A blank category plans for everything, and says null rather than echoing
    // the whitespace as if it had filtered.
    const unscoped = computeRestockPlan(products, [], {
      ...RESTOCK_PARAMS,
      threshold: 5,
      category: "   ",
      nowMs: NOW,
    });
    assert.deepEqual(unscoped.filters, { category: null });
    assert.equal(unscoped.recommendations.length, 2);
  });

  it("keeps the test fixture in step with the policy it stands in for", () => {
    assert.ok(
      paramsAgreeWithPolicy(),
      `RESTOCK_PARAMS ${JSON.stringify(RESTOCK_PARAMS)} has drifted from RESTOCK_POLICY ` +
        `{lead=${RESTOCK_POLICY.supplierLeadTimeDays}, safety=${RESTOCK_POLICY.safetyStockDays}, ` +
        `lookback=${RESTOCK_POLICY.salesLookbackDays}, fallback=${RESTOCK_POLICY.fallbackRestockQuantity}}. ` +
        "Update the fixture deliberately — these numbers are the inputs the assertions above pin."
    );
  });
});
