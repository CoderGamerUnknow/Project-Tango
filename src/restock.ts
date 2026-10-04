import { z } from "zod";

import { filterProducts, normaliseProductFilters } from "./catalog.js";
import { round1, round3 } from "./conventions.js";
import { ordersWithinWindow, resolveLookbackWindow, unitsSoldForProduct } from "./orderAnalytics.js";
import type { restockPlanSchema, restockRecommendationSchema } from "./schemas.js";
import type { Order, Product } from "./types.js";

/**
 * Restock planning: how much of what to reorder, and how urgently.
 *
 * Pure business logic over plain data. Velocity math comes from
 * `orderAnalytics` because it is the same windowing the sales figures use — a
 * plan measured over a different window than the metrics it sits beside would
 * quietly disagree with them.
 */

/** Business rules live beside the functions that apply them, not in the MCP wiring. */
export const RESTOCK_POLICY = {
  defaultLowStockThreshold: 5,
  criticalStockThreshold: 3,
  supplierLeadTimeDays: 14,
  safetyStockDays: 7,
  salesLookbackDays: 30,
  fallbackRestockQuantity: 20,
} as const;

export interface RestockParams {
  threshold: number;
  supplierLeadTimeDays: number;
  safetyStockDays: number;
  salesLookbackDays: number;
  fallbackRestockQuantity: number;
  /**
   * Restrict the plan to products in this category, case-insensitively.
   * Omitted (or blank) plans for the whole catalog.
   */
  category?: string | undefined;
  /** Injected so the resolved window is reproducible in tests. */
  nowMs?: number;
}

/**
 * Velocity is measured strictly inside the lookback window: older history
 * divided by the same denominator silently understates velocity as the dataset
 * grows. Products with no sales history in the window fall back to a flat
 * quantity rather than being recommended zero.
 *
 * Recommendations are ordered by `daysOfCover` ascending, so the first entry is
 * the item that runs out first — reorder quantity is a cost, not an urgency.
 */
export function computeRestockPlan(
  products: Product[],
  orders: Order[],
  params: RestockParams
): z.infer<typeof restockPlanSchema> {
  const { supplierLeadTimeDays, safetyStockDays, salesLookbackDays, fallbackRestockQuantity } = params;

  // Normalise once, then plan and echo the same value: a blank category is
  // "no filter", and the echoed filters block has to report the filter that
  // ran rather than the argument as supplied. Velocity is still measured
  // against ALL orders — demand for a category's products is demand, wherever
  // the orders that bought them sit in history.
  const applied = normaliseProductFilters({ category: params.category });
  const scope = filterProducts(products, applied);

  // Only orders inside the lookback window contribute to demand velocity.
  const window = resolveLookbackWindow(orders, salesLookbackDays, params.nowMs);
  const windowOrders = ordersWithinWindow(orders, window);

  const recommendations = scope
    .filter((p) => p.inventoryCount <= params.threshold)
    .map((product): z.infer<typeof restockRecommendationSchema> => {
      const unitsSold = unitsSoldForProduct(windowOrders, product.id);
      const dailyVelocity = unitsSold / salesLookbackDays;
      const projectedDemand = dailyVelocity * (supplierLeadTimeDays + safetyStockDays);

      const hasSalesHistory = unitsSold > 0;
      const recommendedReorderQuantity = hasSalesHistory
        ? Math.max(0, Math.ceil(projectedDemand - product.inventoryCount))
        : Math.max(0, fallbackRestockQuantity - product.inventoryCount);

      // Days the current stock lasts at the observed velocity. Zero velocity
      // would yield Infinity, which is not JSON — `null` is the honest value,
      // and it is what sorts after every item that does have a clock.
      const daysOfCover =
        dailyVelocity > 0 ? round1(product.inventoryCount / dailyVelocity) : null;

      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        currentStock: product.inventoryCount,
        unitsSoldInWindow: unitsSold,
        dailyVelocity: round3(dailyVelocity),
        daysOfCover,
        basis: hasSalesHistory ? "demand_velocity" : "fallback_flat_rate",
        recommendedReorderQuantity,
      };
    })
    // Order by urgency, not by spend: the operator's question is which item
    // runs out first, not which reorder costs most. Items with no measurable
    // demand (`null`) have no clock to race and sort last; ties — including
    // two nulls, where `Infinity - Infinity` would be NaN — fall back to the
    // larger reorder, keeping the previous ordering as a secondary key.
    .sort((a, b) => {
      const coverA = a.daysOfCover ?? Number.POSITIVE_INFINITY;
      const coverB = b.daysOfCover ?? Number.POSITIVE_INFINITY;
      return coverA === coverB
        ? b.recommendedReorderQuantity - a.recommendedReorderQuantity
        : coverA - coverB;
    });

  return {
    // Echoed so the plan fully describes itself and the tool can return it
    // directly, rather than the MCP layer bolting the threshold on afterwards.
    filters: {
      category: applied.category ?? null,
    },
    thresholdUsed: params.threshold,
    assumptions: {
      supplierLeadTimeDays,
      safetyStockDays,
      salesLookbackDays,
      fallbackFlatRestockQuantity: fallbackRestockQuantity,
    },
    window: {
      start: new Date(window.startMs).toISOString().slice(0, 10),
      end: new Date(window.endMs).toISOString().slice(0, 10),
      ordersInWindow: windowOrders.length,
      totalOrders: orders.length,
    },
    recommendations,
  };
}
