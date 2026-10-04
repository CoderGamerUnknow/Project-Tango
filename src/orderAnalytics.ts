import { z } from "zod";

import { filterProducts, normaliseProductFilters } from "./catalog.js";
import { round1, round2, trimmed } from "./conventions.js";
import type { orderLookupSchema, salesMetricsSchema } from "./schemas.js";
import type { Order, OrderStatus, Product } from "./types.js";

/**
 * Order-side analytics: date/window math, sales figures, the trend series,
 * order-line validation and ids, and the per-order drill-down.
 *
 * Pure business logic over plain data — no provider, SDK or I/O, which is what
 * makes it unit-testable without a server. Return types are inferred from
 * `schemas.ts`, so each response shape is declared exactly once and drift is a
 * compile error.
 */

/** One day in milliseconds: order dates are calendar days, not instants. */
const MS_PER_DAY = 86_400_000;

/**
 * Parse an ISO "YYYY-MM-DD" order date into a UTC timestamp.
 *
 * Order dates are calendar dates rather than instants, so they are pinned to
 * UTC midnight instead of local midnight. This keeps the sales-lookback window
 * free of timezone drift and consistent with `simulate_order_placement`, which
 * stamps new orders with `toISOString().slice(0, 10)` — itself UTC-based.
 *
 * Unparseable dates yield NaN, which fails every window comparison and is
 * therefore excluded from the lookback rather than silently treated as recent.
 */
export function parseOrderDate(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export interface LookbackWindow {
  startMs: number;
  endMs: number;
}

/**
 * Anchored to the most recent order rather than wall-clock today, so a static
 * seed dataset never ages out of its own analysis window. Against a live
 * provider the two are equivalent, since real orders track real time.
 */
export function resolveLookbackWindow(
  orders: Order[],
  lookbackDays: number,
  nowMs: number = Date.now()
): LookbackWindow {
  // Seeded with -Infinity, not NaN: `Math.max(NaN, x)` is NaN for every x, so a
  // NaN seed would poison the accumulator on the first order and the anchor
  // would silently fall back to `nowMs` even when the dataset had valid dates.
  const latestOrderMs = orders.reduce((max, order) => {
    const timestamp = parseOrderDate(order.date);
    return Number.isNaN(timestamp) ? max : Math.max(max, timestamp);
  }, Number.NEGATIVE_INFINITY);

  const endMs = latestOrderMs === Number.NEGATIVE_INFINITY ? nowMs : latestOrderMs;
  return { startMs: endMs - lookbackDays * MS_PER_DAY, endMs };
}

/** Narrow a list of orders to those falling inside `window`, inclusive of both bounds. */
export function ordersWithinWindow(orders: Order[], window: LookbackWindow): Order[] {
  return orders.filter((order) => {
    const timestamp = parseOrderDate(order.date);
    return timestamp >= window.startMs && timestamp <= window.endMs;
  });
}

/**
 * Total units of a given product sold across the supplied orders.
 *
 * Sums every matching line item rather than stopping at the first, so an order
 * that lists the same product on two separate lines contributes both quantities
 * instead of silently dropping one.
 */
export function unitsSoldForProduct(orders: Order[], productId: string): number {
  return orders.reduce(
    (total, order) =>
      total +
      order.items.reduce(
        (itemTotal, item) => (item.productId === productId ? itemTotal + item.quantity : itemTotal),
        0
      ),
    0
  );
}

/** Units sold per product across all supplied orders. */
export function summarizeUnitsByProduct(orders: Order[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      units.set(item.productId, (units.get(item.productId) ?? 0) + item.quantity);
    }
  }
  return units;
}
/** Revenue per product, priced from the current catalog. */
export function revenueByProduct(products: Product[], orders: Order[]): Map<string, number> {
  const catalogPrice = new Map(products.map((p) => [p.id, p.price]));
  const revenue = new Map<string, number>();

  for (const order of orders) {
    for (const item of order.items) {
      const price = catalogPrice.get(item.productId) ?? 0;
      revenue.set(item.productId, (revenue.get(item.productId) ?? 0) + price * item.quantity);
    }
  }
  return revenue;
}

export interface SalesMetricsOptions {
  /** How many entries `topSellingProducts` reports. Defaults to 5. */
  topN?: number;
  /**
   * Restrict every figure to products in this category, case-insensitively.
   * Omitted (or blank) covers the whole dataset.
   */
  category?: string;
}

/**
 * Re-cut orders to the lines that belong to `scope`.
 *
 * Items are filtered to the scoped product ids, `totalAmount` is recomputed
 * from current catalog prices for the surviving lines, and an order with no
 * line in scope is dropped — it contains nothing this scope asks about. This
 * is what makes a scoped revenue figure the category's revenue rather than
 * the whole order total of every order that happened to touch the category.
 */
function ordersScopedTo(scope: Product[], orders: Order[]): Order[] {
  const ids = new Set(scope.map((p) => p.id));
  const price = new Map(scope.map((p) => [p.id, p.price]));
  const scoped: Order[] = [];
  for (const order of orders) {
    const items = order.items.filter((item) => ids.has(item.productId));
    if (items.length === 0) continue;
    const totalAmount = round2(
      items.reduce((sum, item) => sum + (price.get(item.productId) ?? 0) * item.quantity, 0)
    );
    scoped.push({ ...order, items, totalAmount });
  }
  return scoped;
}

/**
 * Sales figures over the given orders — optionally scoped to one category.
 *
 * When `options.category` is set, the products shrink to the category and
 * every order is re-cut to its lines in that category (see `ordersScopedTo`)
 * before any figure is computed. Revenue, units and the trend then count only
 * those lines; the status breakdown and `orderCount` count the orders that
 * contain at least one such line; AOV is the category's revenue over those
 * orders. A category that matches no product yields an honest all-zero answer
 * rather than falling back to the full dataset.
 *
 * Unscoped, the input orders are used exactly as given — `totalAmount` comes
 * from the order as recorded, not recomputed.
 */
export function computeSalesMetrics(
  products: Product[],
  orders: Order[],
  options: SalesMetricsOptions = {}
): z.infer<typeof salesMetricsSchema> {
  const { topN = 5 } = options;
  const applied = normaliseProductFilters({ category: options.category });
  const scope = applied.category ? filterProducts(products, applied) : products;
  const metricsOrders = applied.category ? ordersScopedTo(scope, orders) : orders;

  const grossRevenue = metricsOrders.reduce((sum, o) => sum + o.totalAmount, 0);
  const averageOrderValue = metricsOrders.length > 0 ? grossRevenue / metricsOrders.length : 0;

  const revenue = revenueByProduct(scope, metricsOrders);

  const dates = metricsOrders.map((o) => o.date).sort();

  const topSellingProducts = [...summarizeUnitsByProduct(metricsOrders).entries()]
    .map(([productId, unitsSold]) => {
      const product = scope.find((p) => p.id === productId);
      return {
        productId,
        productName: product?.name ?? "Unknown product",
        unitsSold,
        revenue: round2(revenue.get(productId) ?? 0),
      };
    })
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, topN);

  const orderFulfillmentBreakdown: Record<OrderStatus, number> = {
    pending: 0,
    shipped: 0,
    delivered: 0,
  };
  for (const order of metricsOrders) {
    orderFulfillmentBreakdown[order.status] += 1;
  }

  return {
    filters: {
      // Echoed from the same normalisation that selected `scope`, so the
      // reported category is the one that actually ran.
      category: applied.category ?? null,
    },
    orderCount: metricsOrders.length,
    // ISO "YYYY-MM-DD" sorts lexicographically, so no date parsing is needed.
    period: {
      firstOrderDate: dates[0] ?? null,
      lastOrderDate: dates[dates.length - 1] ?? null,
    },
    grossRevenue: round2(grossRevenue),
    averageOrderValue: round2(averageOrderValue),
    topSellingProducts,
    orderFulfillmentBreakdown,
    trend: computeSalesTrend(metricsOrders),
  };
}

/** Days in each half of the recent-vs-previous comparison. */
const TREND_PERIOD_DAYS = 7;

/** Spans longer than this bucket by week, so the series stays readable. */
const TREND_DAILY_MAX_DAYS = 60;

function unitsIn(orders: Order[]): number {
  return orders.reduce(
    (sum, order) => sum + order.items.reduce((lineSum, item) => lineSum + item.quantity, 0),
    0
  );
}

/** Orders whose date falls inside `[startMs, endMs]`, skipping unparseable dates. */
function ordersBetween(orders: Order[], startMs: number, endMs: number): Order[] {
  return orders.filter((order) => {
    const timestamp = parseOrderDate(order.date);
    return !Number.isNaN(timestamp) && timestamp >= startMs && timestamp <= endMs;
  });
}

function trendPeriod(
  orders: Order[],
  startMs: number,
  endMs: number
): z.infer<typeof salesMetricsSchema>["trend"]["recent"] {
  const inRange = ordersBetween(orders, startMs, endMs);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    // The bounds describe the window itself, not the orders inside it: an empty
    // window is still a period, and reporting `null` bounds would hide it.
    start: iso(startMs),
    end: iso(endMs),
    orders: inRange.length,
    units: unitsIn(inRange),
    revenue: round2(inRange.reduce((sum, order) => sum + order.totalAmount, 0)),
  };
}

/**
 * Revenue/units per day (or per week for long histories), plus a
 * recent-vs-previous 7-day comparison so the direction of travel is visible.
 *
 * Both halves anchor on the latest order date rather than "today": the seed
 * data and every test fixture carry fixed dates, and a wall-clock anchor would
 * make the window (and every assertion about it) drift with the calendar. A
 * day with no orders still gets a zero row, because a gap in a chart and a
 * missing data point are different facts.
 *
 * Percentage change is `null` — not `Infinity`, not `0` — when the previous
 * period had no sales: there is no denominator, and inventing one would claim a
 * growth rate the data does not support.
 */
function computeSalesTrend(orders: Order[]): z.infer<typeof salesMetricsSchema>["trend"] {
  const anchorMs = orders.reduce((max, order) => {
    const timestamp = parseOrderDate(order.date);
    return Number.isNaN(timestamp) ? max : Math.max(max, timestamp);
  }, Number.NEGATIVE_INFINITY);

  if (anchorMs === Number.NEGATIVE_INFINITY) {
    const none = { start: null, end: null, orders: 0, units: 0, revenue: 0 };
    return { granularity: "day", points: [], recent: none, previous: none, revenueChangePercent: null, unitsChangePercent: null };
  }

  const day = (offset: number) => anchorMs - offset * MS_PER_DAY;
  // Windows are half-open at day granularity: the newest 7 days are
  // [anchor-6, anchor], the previous 7 are [anchor-13, anchor-7]. No day
  // belongs to both halves, and neither window overlaps the other.
  const recent = trendPeriod(orders, day(TREND_PERIOD_DAYS - 1), day(0));
  const previous = trendPeriod(orders, day(2 * TREND_PERIOD_DAYS - 1), day(TREND_PERIOD_DAYS));

  const firstMs = ordersBetween(orders, Number.NEGATIVE_INFINITY, anchorMs).reduce(
    (min, order) => Math.min(min, parseOrderDate(order.date)),
    anchorMs
  );
  const spanDays = Math.round((anchorMs - firstMs) / MS_PER_DAY) + 1;
  const granularity: "day" | "week" = spanDays > TREND_DAILY_MAX_DAYS ? "week" : "day";

  const bucketOf = (ms: number): number => {
    const midnight = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
    if (granularity === "day") return midnight;
    // ISO weeks start on Monday (getUTCDay() is 0 for Sunday).
    return midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * MS_PER_DAY;
  };

  const buckets = new Map<number, { orders: Order[] }>();
  for (const order of orders) {
    const timestamp = parseOrderDate(order.date);
    if (Number.isNaN(timestamp)) continue;
    const key = bucketOf(timestamp);
    const entry = buckets.get(key) ?? { orders: [] };
    entry.orders.push(order);
    buckets.set(key, entry);
  }

  const stepMs = (granularity === "day" ? 1 : 7) * MS_PER_DAY;
  const firstBucket = bucketOf(firstMs);
  const points: z.infer<typeof salesMetricsSchema>["trend"]["points"] = [];
  for (let start = firstBucket; start <= anchorMs; start += stepMs) {
    const filled = buckets.get(start)?.orders ?? [];
    points.push({
      bucketStart: new Date(start).toISOString().slice(0, 10),
      orders: filled.length,
      units: unitsIn(filled),
      revenue: round2(filled.reduce((sum, order) => sum + order.totalAmount, 0)),
    });
  }

  const change = (recentValue: number, previousValue: number): number | null =>
    previousValue === 0 ? null : round1(((recentValue - previousValue) / previousValue) * 100);

  return {
    granularity,
    points,
    recent,
    previous,
    revenueChangePercent: change(recent.revenue, previous.revenue),
    unitsChangePercent: change(recent.units, previous.units),
  };
}
interface OrderLineInput {
  product_id: string;
  quantity: number;
}

/**
 * Collapse duplicate lines for the same product into a single total quantity.
 *
 * Validating each line independently against the pre-order snapshot lets three
 * lines of quantity 1 each pass a stock level of 2, then drive inventory
 * negative as the writes are applied one after another. Aggregating first makes
 * the stock check and the write operate on the same number.
 */
export function aggregateQuantitiesByProduct(lines: OrderLineInput[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    quantities.set(line.product_id, (quantities.get(line.product_id) ?? 0) + line.quantity);
  }
  return quantities;
}

/**
 * Validate every aggregated line before any inventory is mutated, so a failure
 * leaves the catalog untouched.
 */
export function validateOrderLines(
  products: Product[],
  quantitiesByProduct: Map<string, number>
): { ok: true; lines: Array<{ product: Product; quantity: number }> } | { ok: false; reason: string } {
  const lines: Array<{ product: Product; quantity: number }> = [];

  for (const [productId, quantity] of quantitiesByProduct) {
    const product = products.find((p) => p.id === productId);
    if (!product) {
      return { ok: false, reason: `Order rejected: no product found with id "${productId}".` };
    }
    if (product.inventoryCount < quantity) {
      return {
        ok: false,
        reason:
          `Order rejected: "${product.name}" (${product.id}) has only ${product.inventoryCount} unit(s) in stock, ` +
          `but ${quantity} were requested.`,
      };
    }
    lines.push({ product, quantity });
  }

  return { ok: true, lines };
}

/**
 * The stock levels a set of validated lines implies, with no I/O.
 *
 * Derived rather than read back from the provider: the caller already validated
 * these lines against the snapshot it is holding, so recomputing from that same
 * snapshot is what keeps the receipt honest — a level read back *after* the
 * writes would reflect any concurrent change instead of this order's effect.
 */
function stockUpdatesFor(
  lines: Array<{ product: Product; quantity: number }>
): { productId: string; productName: string; newStock: number }[] {
  return lines.map(({ product, quantity }) => ({
    productId: product.id,
    productName: product.name,
    newStock: product.inventoryCount - quantity,
  }));
}

/**
 * Turn validated lines into the order to store plus the stock it implies.
 *
 * This was inline in the MCP handler, where it was the one piece of write-path
 * logic no unit test could reach: every other tool is a pure function over plain
 * data, so this one was being exercised only by spinning up a server. Total,
 * rounding and the order's date and id are all policy, and policy that belongs
 * next to the rest of the order math rather than in the wiring.
 *
 * `nowMs` is injected so the whole construction is reproducible; the default
 * matches the wall clock the handler previously read for itself.
 */
export function buildOrder(
  lines: Array<{ product: Product; quantity: number }>,
  customerName: string,
  nowMs: number = Date.now()
): { order: Order; stockUpdates: { productId: string; productName: string; newStock: number }[] } {
  const totalAmount = lines.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0);

  return {
    order: {
      id: nextOrderId(nowMs),
      customerName,
      items: lines.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      // Same rounding the catalog prices imply, so the order total and its lines
      // agree by construction rather than by coincidence.
      totalAmount: round2(totalAmount),
      status: "pending",
      // UTC calendar date, matching the format the seed orders use.
      date: new Date(nowMs).toISOString().slice(0, 10),
    },
    stockUpdates: stockUpdatesFor(lines),
  };
}

/**
 * A bare `Date.now()` collides whenever two orders land in the same
 * millisecond, handing back two receipts with an identical id.
 */
let orderSequence = 0;

export function nextOrderId(nowMs: number = Date.now()): string {
  return `ord_${nowMs.toString(36)}_${(++orderSequence).toString(36)}`;
}
export interface OrderLookupFilters {
  orderId?: string | undefined;
  customerName?: string | undefined;
}

/**
 * Trim both filters, dropping blanks — the same rule `normaliseProductFilters`
 * applies, for the same reason: a blank argument is the absence of a filter,
 * not a filter that happens to match nothing. The caller reads this back to
 * decide whether a filter was supplied at all, so the two must not disagree.
 */
export function normaliseOrderLookupFilters(filters: OrderLookupFilters): OrderLookupFilters {
  return {
    orderId: trimmed(filters.orderId),
    customerName: trimmed(filters.customerName),
  };
}

/**
 * Drill-down: the order lines no aggregate exposes.
 *
 * Every other order-facing view reports totals — revenue, units, fulfillment
 * counts — so "what did this customer actually order" was unanswerable. Lines
 * are enriched with the product name and price from the current catalog so the
 * caller never joins `productId` back to a product itself; a line whose product
 * is gone reports `null` rather than a fabricated name or price.
 *
 * Matching is by exact order id (case-insensitive) or by case-insensitive
 * substring of the customer name, and results are ordered newest first so the
 * most relevant match is the first entry.
 *
 * When both filters are supplied they combine with AND, and an order has to
 * satisfy both. Short-circuiting on the id instead — returning `ord_1001` for
 * `{orderId: "ord_1001", customerName: "someone-else"}` — handed back one
 * customer’s order while echoing both filters as applied, so the caller could
 * not tell an honoured match from an ignored one.
 *
 * No match is a successful lookup with `count: 0`, not an error: the same
 * answer `filterProducts` gives, and the same one `orderLookupSchema` declares.
 *
 * The result set is deliberately uncapped by default. `customerName` is a
 * substring match, so a broad query matches most of the dataset —
 * `customer_name: "a"` returns 130 orders, roughly 46 KB of JSON, on the seed
 * data. Truncating silently would drop orders from an answer that reports
 * `count` and claims to enumerate its matches, which is the same dishonesty as
 * echoing a filter that never ran. A caller that wants a bound asks for one
 * explicitly with `limit`, and `totalMatches` always reports the full match
 * count — so a capped answer still says how much it left out, and an uncapped
 * one still delivers everything. `findOrders` is the single place to change.
 */
export function findOrders(
  orders: Order[],
  products: Product[],
  filters: OrderLookupFilters,
  limit?: number
): z.infer<typeof orderLookupSchema> {
  const applied = normaliseOrderLookupFilters(filters);
  const orderId = applied.orderId?.toLowerCase();
  const customerName = applied.customerName?.toLowerCase();

  const productById = new Map(products.map((p) => [p.id, p]));

  const matched = orders
    .filter((order) => {
      if (!orderId && !customerName) return false;
      if (orderId && order.id.toLowerCase() !== orderId) return false;
      if (customerName && !order.customerName.toLowerCase().includes(customerName)) return false;
      return true;
    })
    .map((order) => ({
      id: order.id,
      customerName: order.customerName,
      totalAmount: order.totalAmount,
      status: order.status,
      date: order.date,
      lines: order.items.map((item) => {
        const product = productById.get(item.productId);
        return {
          productId: item.productId,
          productName: product?.name ?? null,
          quantity: item.quantity,
          unitPrice: product?.price ?? null,
          lineTotal: product ? round2(product.price * item.quantity) : null,
        };
      }),
    }))
    // ISO dates sort lexicographically, so a plain string compare is enough.
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));

  // The bound applies after sorting, so `limit` returns the newest N matches;
  // `totalMatches` keeps the uncapped answer visible even when one is withheld.
  const totalMatches = matched.length;
  const delivered = limit === undefined ? matched : matched.slice(0, limit);

  return {
    count: delivered.length,
    totalMatches,
    limit: limit ?? null,
    // Echoes the values actually matched on: both filters are honoured, so
    // anything non-null here really was applied.
    filters: {
      order_id: applied.orderId ?? null,
      customer_name: applied.customerName ?? null,
    },
    orders: delivered,
  };
}
