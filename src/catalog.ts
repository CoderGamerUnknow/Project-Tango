import { trimmed } from "./conventions.js";
import { ProductIndex } from "./productIndex.js";
import type { AlertSeverity, InventoryAlert, Product } from "./types.js";

/**
 * Catalog queries: filtering products and flagging low stock.
 *
 * Pure business logic over plain data — no provider, SDK or I/O, which is what
 * makes it unit-testable without a server. This is the lowest layer of the
 * analytics modules: it reads products and nothing else, so the order- and
 * restock-facing modules can depend on it without a cycle.
 */

export interface ProductFilters {
  category?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  search?: string | undefined;
}

/**
 * The filters a matcher will actually honour: strings trimmed, blanks dropped.
 *
 * The response echoes these back in its `filters` block, so the normalisation
 * has to live with the matcher rather than in the echo — otherwise the two can
 * disagree about what was applied. A blank argument is the two ways of getting
 * that wrong: `search: "   "` trimmed to nothing and returned the whole catalog
 * while being echoed as `"   "`, and `category: "   "` matched no product at
 * all. Both wore the same lie — "this is the filter I applied". Prices are not
 * strings, so they pass through untouched.
 */
export function normaliseProductFilters(filters: ProductFilters): ProductFilters {
  return {
    category: trimmed(filters.category),
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    search: trimmed(filters.search),
  };
}

/**
 * Case-insensitive category match, inclusive price range, free-text search.
 *
 * Every supplied filter applies — they combine with AND, so a category and a
 * search that disagree yield nothing rather than silently dropping one. A
 * filter absent (or blank) is not applied, which is why `normaliseProductFilters`
 * is called here and not left to each caller.
 *
 * The search term is matched as a substring of name, SKU, description, tags or
 * category, so "merino" finds the sweater by name, "usb-c" finds the SSD by
 * tag, and "kitchen" finds the home goods by category. Without this, a caller
 * asked to find a product had to pull the entire catalog and filter it by hand.
 */
export function filterProducts(products: Product[], filters: ProductFilters): Product[] {
  const applied = normaliseProductFilters(filters);
  const category = applied.category?.toLowerCase();
  const search = applied.search?.toLowerCase();

  return products.filter((p) => {
    if (category && p.category.toLowerCase() !== category) return false;
    if (typeof applied.minPrice === "number" && p.price < applied.minPrice) return false;
    if (typeof applied.maxPrice === "number" && p.price > applied.maxPrice) return false;
    if (search) {
      const haystack = [p.name, p.sku, p.description, p.category, ...p.tags].join("\n").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Order search results by how well they matched, keeping every match.
 *
 * Recall is unchanged from `filterProducts`: the substring match decides *which*
 * products are returned, exactly as before. The prefix index only decides their
 * *order*, so a product whose own token is the query ("usbc" as a tag) appears
 * above one that merely contains the text somewhere in its description. This is
 * the part the `v2.0.0` lineage got wrong — it let the index filter as well, and
 * lost matches that substring search found.
 *
 * A product the index does not know about (a caller passing an ad-hoc array)
 * still appears, at the end of its group, rather than disappearing.
 */
export function rankProducts(products: Product[], search: string): Product[] {
  const trimmedSearch = trimmed(search);
  if (!trimmedSearch) return products;

  const index = new ProductIndex(products);
  const scores = new Map(index.search(trimmedSearch).map((m) => [m.productId, m.score]));

  return [...products].sort((a, b) => {
    const scoreA = scores.get(a.id);
    const scoreB = scores.get(b.id);
    if (scoreA === undefined && scoreB === undefined) return 0;
    if (scoreA === undefined) return 1;
    if (scoreB === undefined) return -1;
    if (scoreA !== scoreB) return scoreB - scoreA;
    // Deterministic tie-break, so two equally-scored products do not swap places
    // between runs.
    return a.id.localeCompare(b.id);
  });
}

function toAlert(product: Product, criticalThreshold: number): InventoryAlert {
  const severity: AlertSeverity =
    product.inventoryCount < criticalThreshold ? "critical" : "low";
  return {
    productId: product.id,
    productName: product.name,
    currentStock: product.inventoryCount,
    severity,
  };
}

/** Alerts for every product at or below `threshold`, most urgent (lowest stock) first. */
export function computeLowStockAlerts(
  products: Product[],
  threshold: number,
  criticalThreshold: number
): InventoryAlert[] {
  return products
    .filter((p) => p.inventoryCount <= threshold)
    .map((p) => toAlert(p, criticalThreshold))
    .sort((a, b) => a.currentStock - b.currentStock);
}
