import { z } from "zod";

/**
 * Zod schemas describing what every tool returns — the single source of truth
 * for response shapes.
 *
 * Each schema is declared once and used for two jobs: the `outputSchema` the
 * tool advertises in `tools/list`, and the TypeScript return type of the
 * function that produces the data. The analytics layer annotates its returns as
 * `z.infer<typeof …Schema>`, so a schema and its implementation cannot drift
 * apart without the compiler objecting — previously a mismatch surfaced only as
 * a runtime `InvalidParams` from the SDK, and in one case not even that.
 *
 * Clients get validated, typed responses instead of a JSON string they must
 * re-parse. Nested shapes are factored out so a recommendation is described
 * once and reused wherever it appears.
 */

// --- Domain records --------------------------------------------------------
// Composed into the tool schemas below; not exported, because nothing outside
// this module describes a bare product or order.

const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string(),
  price: z.number(),
  inventoryCount: z.number(),
  category: z.string(),
  tags: z.array(z.string()),
  description: z.string(),
});

const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number(),
});

const orderSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  items: z.array(orderItemSchema),
  totalAmount: z.number(),
  status: z.enum(["pending", "shipped", "delivered"]),
  date: z.string(),
});

const inventoryAlertSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  currentStock: z.number(),
  severity: z.enum(["low", "critical"]),
});

/**
 * One order line as the drill-down reports it: enriched with catalog data so a
 * caller never has to join productId back to a product by hand.
 *
 * `productName`, `unitPrice` and `lineTotal` are nullable because orders can
 * outlive the product they reference — against a live backend a delisted SKU
 * still appears in order history. Prices come from the current catalog, which
 * is how `totalAmount` itself is computed, so the lines and the order total
 * agree by construction.
 */
const orderLineSchema = z.object({
  productId: z.string(),
  productName: z.string().nullable(),
  quantity: z.number().int(),
  unitPrice: z.number().nullable(),
  lineTotal: z.number().nullable(),
});

// --- Nested fragments ------------------------------------------------------

const topSellingProductSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  unitsSold: z.number(),
  revenue: z.number(),
});

/** One bucket of the sales series: the shape of "how much, and which way". */
const trendPointSchema = z.object({
  /** Bucket start, ISO "YYYY-MM-DD" (the Monday, for weekly buckets). */
  bucketStart: z.string(),
  orders: z.number().int(),
  units: z.number().int(),
  revenue: z.number(),
});

const trendPeriodSchema = z.object({
  start: z.string().nullable(),
  end: z.string().nullable(),
  orders: z.number().int(),
  units: z.number().int(),
  revenue: z.number(),
});

const trendSchema = z.object({
  granularity: z.enum(["day", "week"]),
  /** Every bucket across the data's span, gaps included as zero rows. */
  points: z.array(trendPointSchema),
  /** Last 7 days of data — the newer half of the comparison. */
  recent: trendPeriodSchema,
  /** The 7 days before that, excluding the boundary day. */
  previous: trendPeriodSchema,
  /** null when the previous period has no sales to measure a change against. */
  revenueChangePercent: z.number().nullable(),
  unitsChangePercent: z.number().nullable(),
});

export const restockRecommendationSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  sku: z.string(),
  currentStock: z.number(),
  /**
   * Units sold for this product inside the plan's `window`.
   *
   * Named after the window rather than a day count: the window spans
   * `salesLookbackDays`, so a `…Last30Days` label starts lying the moment the
   * policy changes.
   */
  unitsSoldInWindow: z.number().int(),
  dailyVelocity: z.number(),
  /**
   * Days the current stock lasts at `dailyVelocity`, rounded to one decimal.
   *
   * Nullable because a zero-velocity item has no measurable runway: the raw
   * division yields `Infinity`, which is not JSON and would be rejected by this
   * very schema when the SDK validates the response. `null` is the honest
   * encoding of "no demand to run out against", and sorts last.
   */
  daysOfCover: z.number().nullable(),
  basis: z.enum(["demand_velocity", "fallback_flat_rate"]),
  recommendedReorderQuantity: z.number().int(),
});

const restockAssumptionsSchema = z.object({
  supplierLeadTimeDays: z.number().int(),
  safetyStockDays: z.number().int(),
  salesLookbackDays: z.number().int(),
  fallbackFlatRestockQuantity: z.number().int(),
});

const restockWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  ordersInWindow: z.number().int(),
  totalOrders: z.number().int(),
});

const copyBodySchema = z.object({
  headline: z.string(),
  shortDescription: z.string(),
  longDescription: z.string(),
  bulletPoints: z.array(z.string()),
});

// --- Tool responses --------------------------------------------------------

export const listAllProductsSchema = z.object({
  count: z.number().int(),
  /**
   * The filters actually applied, not the ones as supplied: null means no such
   * filter ran, so a blank argument comes back null instead of being echoed as
   * a filter that matched everything or nothing.
   */
  filters: z.object({
    category: z.string().nullable(),
    min_price: z.number().nullable(),
    max_price: z.number().nullable(),
    search: z.string().nullable(),
  }),
  products: z.array(productSchema),
});

/**
 * The category actually applied by a scoped tool — null means no category
 * filter ran, so a blank argument reads back as "unscoped" rather than as a
 * category that happened to match nothing. The same rule as the `filters`
 * block on `listAllProductsSchema`, in miniature.
 */
const appliedCategorySchema = z.object({
  category: z.string().nullable(),
});

export const lowStockAlertsSchema = z.object({
  filters: appliedCategorySchema,
  thresholdUsed: z.number(),
  alertCount: z.number().int(),
  criticalCount: z.number().int(),
  alerts: z.array(inventoryAlertSchema),
});

export const salesMetricsSchema = z.object({
  filters: appliedCategorySchema,
  orderCount: z.number().int(),
  /**
   * Span of the data these figures cover. The metrics are all-time by design,
   * so without this an agent cannot tell a healthy 30-day history from a
   * three-year-old one it is about to reason about.
   */
  period: z.object({
    firstOrderDate: z.string().nullable(),
    lastOrderDate: z.string().nullable(),
  }),
  grossRevenue: z.number(),
  averageOrderValue: z.number(),
  topSellingProducts: z.array(topSellingProductSchema),
  orderFulfillmentBreakdown: z.object({
    pending: z.number().int(),
    shipped: z.number().int(),
    delivered: z.number().int(),
  }),
  /**
   * The shape behind `period`: a series of revenue/units buckets plus a
   * recent-vs-previous comparison. Without it the tool answered "how much"
   * but never "which way" — a flat total cannot distinguish a store that is
   * accelerating from one that is winding down.
   */
  trend: trendSchema,
});

export const restockPlanSchema = z.object({
  filters: appliedCategorySchema,
  thresholdUsed: z.number(),
  assumptions: restockAssumptionsSchema,
  window: restockWindowSchema,
  recommendations: z.array(restockRecommendationSchema),
});

export const productCopySchema = z.object({
  sku: z.string(),
  productId: z.string(),
  copy: copyBodySchema,
  seoTags: z.array(z.string()),
});

export const orderPlacementSchema = z.object({
  success: z.literal(true),
  receipt: orderSchema,
  updatedStockLevels: z.array(
    z.object({
      productId: z.string(),
      productName: z.string(),
      newStock: z.number(),
    })
  ),
});

/**
 * Zero is a real, expected answer here — a name that matches no orders — so it
 * is a successful response with `count: 0` and an empty `orders` array, matching
 * what `listAllProductsSchema` does for an empty catalog search. Only a call
 * that supplies no usable filter at all is an error.
 */
export const orderLookupSchema = z.object({
  /** How many orders are actually delivered in this response. */
  count: z.number().int(),
  /**
   * How many orders matched in full, before any `limit` was applied. Equal to
   * `count` whenever the result is uncapped, so a capped answer can never be
   * mistaken for a complete one — the honesty `count` used to guarantee by
   * always delivering every match.
   */
  totalMatches: z.number().int(),
  /** The bound the caller asked for; null means the result is uncapped. */
  limit: z.number().int().nullable(),
  /** Both filters apply together when both are supplied; null means unused. */
  filters: z.object({
    order_id: z.string().nullable(),
    customer_name: z.string().nullable(),
  }),
  orders: z.array(
    // Reuses the order envelope, with `items` replaced by enriched lines.
    orderSchema.omit({ items: true }).extend({ lines: z.array(orderLineSchema) })
  ),
});

export const resetStateSchema = z.object({
  reset: z.literal(true),
  products: z.number().int(),
  orders: z.number().int(),
});

// No `z.infer` aliases are exported. Consumers annotate their own returns as
// `z.infer<typeof …Schema>` — re-exporting the alias as well would only give a
// response shape two names and a second place to drift.