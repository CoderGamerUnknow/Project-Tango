import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeLowStockAlerts, filterProducts, normaliseProductFilters } from "./catalog.js";
import { makeProduct } from "./testHelpers.js";

/**
 * Catalog queries: product filtering and low-stock alerts.
 */

describe("filterProducts", () => {
  const products = [
    makeProduct({ id: "a", category: "tech", price: 50 }),
    makeProduct({ id: "b", category: "home", price: 150 }),
    makeProduct({ id: "c", category: "Tech", price: 100 }),
  ];

  it("returns everything when no filters are supplied", () => {
    assert.equal(filterProducts(products, {}).length, 3);
  });

  it("matches category case-insensitively", () => {
    assert.deepEqual(
      filterProducts(products, { category: "TECH" }).map((p) => p.id),
      ["a", "c"]
    );
  });

  it("treats price bounds as inclusive", () => {
    assert.deepEqual(
      filterProducts(products, { minPrice: 100, maxPrice: 150 }).map((p) => p.id),
      ["b", "c"]
    );
  });
});

describe("filterProducts by search term", () => {
  const products = [
    makeProduct({ id: "sweater", name: "Highland Merino Wool Sweater", tags: ["wool", "winter"] }),
    makeProduct({ id: "ssd", name: "DataVault SSD", sku: "TCH-DV-1TB", tags: ["storage", "usb-c"] }),
    makeProduct({ id: "kettle", name: "Pour-Over Kettle", category: "home", description: "For the kitchen." }),
  ];

  it("finds a product by name, case-insensitively", () => {
    assert.deepEqual(filterProducts(products, { search: "MERINO" }).map((p) => p.id), ["sweater"]);
  });

  it("finds a product by tag", () => {
    assert.deepEqual(filterProducts(products, { search: "usb-c" }).map((p) => p.id), ["ssd"]);
  });

  it("finds a product by SKU and by description", () => {
    assert.deepEqual(filterProducts(products, { search: "tch-dv" }).map((p) => p.id), ["ssd"]);
    assert.deepEqual(filterProducts(products, { search: "kitchen" }).map((p) => p.id), ["kettle"]);
  });

  it("returns nothing when no product matches", () => {
    assert.deepEqual(filterProducts(products, { search: "nonexistent" }), []);
  });

  it("combines with the category filter", () => {
    // "kitchen" matches the kettle's description, but only in the home category.
    assert.deepEqual(
      filterProducts(products, { search: "kettle", category: "tech" }).map((p) => p.id),
      []
    );
    assert.deepEqual(
      filterProducts(products, { search: "kettle", category: "home" }).map((p) => p.id),
      ["kettle"]
    );
  });

  it("treats a whitespace-only term as no filter", () => {
    assert.equal(filterProducts(products, { search: "   " }).length, 3);
  });

  it("treats a whitespace-only category as no filter, not as a category that matches nothing", () => {
    // The two blank arguments used to disagree in the worst way: a blank search
    // returned everything while a blank category returned nothing, and the
    // caller could not tell from either response which had actually run.
    assert.deepEqual(
      filterProducts(products, { category: "   " }).map((p) => p.id),
      ["sweater", "ssd", "kettle"]
    );
  });
});

describe("normaliseProductFilters", () => {
  it("trims string filters and drops the blanks", () => {
    assert.deepEqual(
      normaliseProductFilters({ category: "  tech ", search: "   ", minPrice: 10, maxPrice: 20 }),
      { category: "tech", search: undefined, minPrice: 10, maxPrice: 20 }
    );
  });

  it("passes prices through untouched", () => {
    // 0 is a real bound, so it must not be confused with an absent filter.
    assert.deepEqual(normaliseProductFilters({ minPrice: 0, maxPrice: 0 }), {
      category: undefined,
      minPrice: 0,
      maxPrice: 0,
      search: undefined,
    });
  });

  it("is what filterProducts matches on, so the echo cannot drift from the query", () => {
    const products = [makeProduct({ id: "p1", category: "tech" })];
    const requested = { category: "  tech  " };

    assert.equal(filterProducts(products, requested).length, 1);
    assert.equal(normaliseProductFilters(requested).category, "tech");
  });
});

describe("computeLowStockAlerts", () => {
  const products = [
    makeProduct({ id: "a", inventoryCount: 0 }),
    makeProduct({ id: "b", inventoryCount: 2 }),
    makeProduct({ id: "c", inventoryCount: 3 }),
    makeProduct({ id: "d", inventoryCount: 5 }),
    makeProduct({ id: "e", inventoryCount: 6 }),
  ];

  it("includes products exactly at the threshold", () => {
    assert.deepEqual(
      computeLowStockAlerts(products, 5, 3).map((a) => a.productId),
      ["a", "b", "c", "d"]
    );
  });

  it("flags stock below criticalThreshold as critical and the boundary as low", () => {
    const byId = new Map(computeLowStockAlerts(products, 5, 3).map((a) => [a.productId, a.severity]));

    assert.equal(byId.get("a"), "critical"); // 0
    assert.equal(byId.get("b"), "critical"); // 2
    assert.equal(byId.get("c"), "low"); // 3 — boundary is not critical
    assert.equal(byId.get("d"), "low"); // 5
  });

  it("sorts most urgent (lowest stock) first", () => {
    assert.deepEqual(
      computeLowStockAlerts(products, 5, 3).map((a) => a.currentStock),
      [0, 2, 3, 5]
    );
  });
});
