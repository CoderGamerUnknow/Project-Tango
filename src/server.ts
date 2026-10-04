import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { computeLowStockAlerts, filterProducts, normaliseProductFilters, rankProducts } from "./catalog.js";
import {
  aggregateQuantitiesByProduct,
  buildOrder,
  computeSalesMetrics,
  findOrders,
  normaliseOrderLookupFilters,
  validateOrderLines,
} from "./orderAnalytics.js";
import { buildProductCopy } from "./productCopy.js";
import { renderWeeklyReview } from "./reviewPrompt.js";
import { computeRestockPlan, RESTOCK_POLICY } from "./restock.js";
import { errorResult, jsonResult } from "./responses.js";
import {
  listAllProductsSchema,
  lowStockAlertsSchema,
  orderLookupSchema,
  orderPlacementSchema,
  productCopySchema,
  resetStateSchema,
  restockPlanSchema,
  salesMetricsSchema,
} from "./schemas.js";
import { TOOL } from "./toolNames.js";
import type { DataProvider } from "./types.js";

/**
 * ---------------------------------------------------------------------------
 * MCP surface
 * ---------------------------------------------------------------------------
 * Every tool the server exposes, registered against an injected `DataProvider`.
 *
 * The registration lives apart from the process bootstrap (`index.ts`) so the
 * whole surface can be built in-process against any provider — tests use that
 * to exercise the seam with stub data instead of spawning a process per suite.
 * Handlers stay short on purpose: read from the provider, delegate to one pure
 * function, wrap the answer. A handler that starts doing arithmetic is a sign
 * the logic belongs in the module it should be calling.
 */

// The values are owned and applied by `restock.ts`; this module reads them only
// to render tool descriptions and pass them straight through.
const {
  defaultLowStockThreshold,
  criticalStockThreshold,
  supplierLeadTimeDays,
  safetyStockDays,
  salesLookbackDays,
  fallbackRestockQuantity,
} = RESTOCK_POLICY;

/** The shared description of the optional category argument on scoped tools. */
const CATEGORY_ARG_DOC =
  "Restrict to a single category, e.g. 'tech', 'apparel', or 'home'. Case-insensitive. " +
  "Omit to cover the whole catalog.";

/**
 * The version this server reports to every MCP client.
 *
 * Exported, and named, because it is a claim in three places at once — this
 * line, `package.json`, and the changelog — and nothing held them together: the
 * version was previously a bare literal here that a release could bump in
 * `package.json` and forget here, which would ship a tarball whose binary
 * announces a different version to every client that connects to it.
 */
export const SERVER_VERSION = "3.2.0";

export function createServer(dataProvider: DataProvider): McpServer {
  const server = new McpServer({
    name: "project-tango",
    version: SERVER_VERSION,
  });

  server.registerTool(
    TOOL.listAllProducts,
    {
      title: "List All Products",
      description:
        "Returns the product catalog, optionally filtered by category, a min/max price range, or a free-text search. " +
        "Use this to browse inventory or to find a specific product by name, SKU, description or tag before " +
        "recommending, restocking, or drafting copy for products.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Restrict results to a single category, e.g. 'tech', 'apparel', or 'home'. Case-insensitive. Omit to include all categories."
          ),
        min_price: z
          .number()
          .nonnegative()
          .optional()
          .describe("Only include products priced at or above this amount, in USD."),
        max_price: z
          .number()
          .nonnegative()
          .optional()
          .describe("Only include products priced at or below this amount, in USD."),
        search: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Free-text search matched against product name, SKU, description, tags and category. " +
              "Case-insensitive substring, so 'merino' finds the Highland Merino Wool Sweater. " +
              "Results are ranked by match quality, so a product whose own name or tag is the query " +
              "comes first; the set of matches is the same either way. " +
              "Combine with the other filters to narrow further."
          ),
      },
      outputSchema: listAllProductsSchema,
    },
    async ({ category, min_price, max_price, search }) => {
      const products = await dataProvider.getProducts();
      // Normalise once, then match and echo the same object: a filter reported as
      // applied has to be the filter that ran, or the two can drift apart.
      const applied = normaliseProductFilters({
        category,
        minPrice: min_price,
        maxPrice: max_price,
        search,
      });
      const filtered = rankProducts(filterProducts(products, applied), applied.search ?? "");

      return jsonResult({
        count: filtered.length,
        filters: {
          category: applied.category ?? null,
          min_price: applied.minPrice ?? null,
          max_price: applied.maxPrice ?? null,
          search: applied.search ?? null,
        },
        products: filtered,
      });
    }
  );

  server.registerTool(
    TOOL.lowStockAlerts,
    {
      title: "Get Low Stock Alerts",
      description:
        "Scans inventory and returns InventoryAlert objects for every product at or below a stock threshold. " +
        `Products under ${criticalStockThreshold} units are flagged 'critical'; everything else at or under the ` +
        "threshold is flagged 'low'. Results are sorted by current stock ascending (most urgent first). " +
        "An optional category restricts the scan to one category; the echoed 'filters' block reports the " +
        "category actually applied.",
      inputSchema: {
        threshold: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Stock level at or below which a product triggers an alert. Defaults to ${defaultLowStockThreshold} if omitted.`
          ),
        category: z.string().optional().describe(CATEGORY_ARG_DOC),
      },
      outputSchema: lowStockAlertsSchema,
    },
    async ({ threshold, category }) => {
      const effectiveThreshold = threshold ?? defaultLowStockThreshold;
      const products = await dataProvider.getProducts();
      // Normalise first, then filter and echo the same value: a blank category
      // must read back as "no filter" rather than as a category that matched
      // nothing.
      const applied = normaliseProductFilters({ category });
      const scoped = filterProducts(products, applied);
      const alerts = computeLowStockAlerts(scoped, effectiveThreshold, criticalStockThreshold);

      return jsonResult({
        filters: {
          category: applied.category ?? null,
        },
        thresholdUsed: effectiveThreshold,
        alertCount: alerts.length,
        criticalCount: alerts.filter((a) => a.severity === "critical").length,
        alerts,
      });
    }
  );

  server.registerTool(
    TOOL.salesMetrics,
    {
      title: "Analyze Sales Metrics",
      description:
        "Calculates gross revenue, average order value (AOV), the top-selling products by units sold, and a breakdown " +
        "of orders by fulfillment status (pending / shipped / delivered), based on current order history. " +
        "Figures cover all recorded orders; the 'period' field reports the actual date span so a stale dataset is visible. " +
        "An optional category scopes every figure to products in that category: revenue, units and the trend count " +
        "only lines of those products, an order counts toward the breakdown and AOV when it contains at least one " +
        "such line, and the echoed 'filters' block reports the category actually applied.",
      inputSchema: {
        category: z.string().optional().describe(CATEGORY_ARG_DOC),
      },
      outputSchema: salesMetricsSchema,
    },
    async ({ category }) => {
      const [products, orders] = await Promise.all([dataProvider.getProducts(), dataProvider.getOrders()]);
      return jsonResult(computeSalesMetrics(products, orders, { category }));
    }
  );

  server.registerTool(
    TOOL.findOrders,
    {
      title: "Find Orders",
      description:
        "Looks up orders by exact order id or by customer name (case-insensitive substring match, so 'maya' finds " +
        "'Maya Chen') and returns each order's line items enriched with product name, unit price and line total. " +
        `This is the drill-down behind the aggregates: ${TOOL.salesMetrics} reports what sold in total, this reports ` +
        `what a single order or customer actually bought. Results are newest first. Line prices come from the current ` +
        `catalog; a line whose product is no longer catalogued reports null rather than an invented price. ` +
        `Supplying both filters requires an order to satisfy both; the echoed 'filters' block reports the values ` +
        `actually matched on. A filter that matches nothing is a successful lookup with count 0 and an empty 'orders' ` +
        `array — the same answer ${TOOL.listAllProducts} gives — not a tool error. ` +
        `Results are deliberately uncapped by default and there is no pagination: 'customer_name' is a substring ` +
        `match, so a broad query returns every matching order in the dataset (a one-letter name matches most of it). ` +
        `Pass 'limit' to bound a broad query — 'totalMatches' always reports how many matched in full, so a capped ` +
        `answer cannot be mistaken for a complete one. Narrow the filter rather than expecting a page, and prefer ` +
        `'order_id' when you want a single order.`,
      inputSchema: {
        order_id: z
          .string()
          .min(1)
          .optional()
          .describe("Exact order id to fetch, e.g. 'ord_1042'. Case-insensitive."),
        customer_name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Customer name to match, case-insensitively as a substring: 'maya' matches 'Maya Chen'. Use this to answer questions like 'what did Maya order?'."
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Return at most this many matches, newest first. 'totalMatches' still reports the full match count. Omit to return every match."
          ),
      },
      outputSchema: orderLookupSchema,
    },
    async ({ order_id, customer_name, limit }) => {
      // Guard on the normalised filters, not the raw arguments, so a blank filter
      // is reported as "no filter given" rather than as a lookup that matched
      // nothing — the same thing the caller meant, and the same thing the matcher
      // will actually do with it.
      const filters = normaliseOrderLookupFilters({ orderId: order_id, customerName: customer_name });
      if (filters.orderId === undefined && filters.customerName === undefined) {
        return errorResult(
          `${TOOL.findOrders} needs at least one filter: pass \`order_id\` for a specific order, or \`customer_name\` to find every order that customer placed.`
        );
      }

      const [products, orders] = await Promise.all([
        dataProvider.getProducts(),
        dataProvider.getOrders(),
      ]);

      // No interception of `count === 0`: a lookup that matched nothing is a
      // successful answer, and `orderLookupSchema` declares that count.
      return jsonResult(findOrders(orders, products, filters, limit));
    }
  );

  server.registerTool(
    TOOL.restockPredictor,
    {
      title: "Smart Restock Predictor",
      description:
        "Evaluates every low-stock item and recommends an exact reorder quantity. The recommendation is derived from " +
        "each product's demand velocity (units sold per day over recent order history), projected demand across an " +
        `assumed ${supplierLeadTimeDays}-day supplier lead time plus a ${safetyStockDays}-day safety buffer, minus current stock on hand. ` +
        "Items with no recent sales history fall back to a conservative flat restock quantity. " +
        "Results are ordered by days of cover (stock remaining / daily velocity), so the first recommendation is the " +
        "item that runs out first; items with no measurable demand report a null daysOfCover and sort last. " +
        "An optional category restricts the plan to one category; the echoed 'filters' block reports the category " +
        "actually applied.",
      inputSchema: {
        threshold: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Stock level at or below which a product is considered for restocking. Defaults to ${defaultLowStockThreshold} if omitted.`
          ),
        category: z.string().optional().describe(CATEGORY_ARG_DOC),
      },
      outputSchema: restockPlanSchema,
    },
    async ({ threshold, category }) => {
      const [products, orders] = await Promise.all([dataProvider.getProducts(), dataProvider.getOrders()]);

      return jsonResult(
        computeRestockPlan(products, orders, {
          threshold: threshold ?? defaultLowStockThreshold,
          supplierLeadTimeDays,
          safetyStockDays,
          salesLookbackDays,
          fallbackRestockQuantity,
          category,
        })
      );
    }
  );

  server.registerTool(
    TOOL.productCopy,
    {
      title: "Draft Product Copy",
      description:
        "Looks up a product by SKU and generates structured, high-conversion marketing copy (headline, short and long " +
        "description, key bullet points) plus SEO tags tailored to that product's category and tags.",
      inputSchema: {
        sku: z.string().min(1).describe("The exact product SKU to generate marketing copy for, e.g. 'TCH-AB-001'."),
      },
      outputSchema: productCopySchema,
    },
    async ({ sku }) => {
      const product = await dataProvider.getProductBySku(sku);
      if (!product) {
        return errorResult(
          `No product found with SKU "${sku}". Use ${TOOL.listAllProducts} to see valid SKUs.`
        );
      }

      return jsonResult(buildProductCopy(product, criticalStockThreshold));
    }
  );

  server.registerTool(
    TOOL.orderPlacement,
    {
      title: "Simulate Order Placement",
      description:
        "Write-action tool: places a new simulated order, validating stock availability for every line item, " +
        "decrementing inventory counts, computing the order total from current catalog prices, and returning a " +
        "success receipt with the updated stock levels. Rejects the entire order (no partial writes) if any item " +
        "is unavailable or under-stocked. The whole read-validate-write runs inside the provider's transaction, " +
        "so a concurrent order cannot both pass a stock check and oversell. " +
        `This permanently changes the dataset until ${TOOL.resetState} is called.`,
      inputSchema: {
        customer_name: z.string().min(1).describe("Full name of the customer placing the order."),
        items: z
          .array(
            z.object({
              product_id: z.string().min(1).describe("The product's id, e.g. 'prod_004'."),
              quantity: z.number().int().positive().describe("Number of units of this product to order."),
            })
          )
          .min(1)
          .describe("One or more line items for this order."),
      },
      outputSchema: orderPlacementSchema,
    },
    async ({ customer_name, items }) =>
      // The provider owns atomicity: this read-validate-write spans an await, so
      // without the transaction an interleaved caller validates against a
      // snapshot the writer has already moved past and oversells.
      dataProvider.transact(async (provider) => {
        const products = await provider.getProducts();

        // Validate the whole order before mutating anything.
        const validation = validateOrderLines(products, aggregateQuantitiesByProduct(items));
        if (!validation.ok) {
          return errorResult(validation.reason);
        }

        // All validated — now apply the writes. The order, its total and the stock
        // levels it implies are all computed by `buildOrder`; this layer only
        // performs the writes that result.
        const { order, stockUpdates } = buildOrder(validation.lines, customer_name);
        for (const { productId, newStock } of stockUpdates) {
          await provider.updateProductInventory(productId, newStock);
        }
        await provider.addOrder(order);

        return jsonResult({
          success: true,
          receipt: order,
          updatedStockLevels: stockUpdates,
        });
      })
  );

  server.registerTool(
    TOOL.resetState,
    {
      title: "Reset Demo State",
      description:
        "Write-action tool: discards every simulated order and inventory change made during this or any earlier " +
        "session, restoring the original seed catalog. Use it to undo exploratory ordering before reporting " +
        "results, so the numbers you hand back reflect the real dataset rather than your own test orders.",
      inputSchema: {},
      outputSchema: resetStateSchema,
    },
    async () => {
      if (!dataProvider.reset) {
        return errorResult(
          "This data provider does not support resetting state. Against a live commerce backend there is nothing " +
            "safe to discard."
        );
      }

      const discarded = await dataProvider.reset();
      return jsonResult({ reset: true, ...discarded });
    }
  );

  /**
   * ---------------------------------------------------------------------------
   * Prompt and resource
   * ---------------------------------------------------------------------------
   * Tools answer a question the caller already knew to ask. A prompt encodes the
   * question — here, the weekly inventory review, which is a fixed sequence of
   * tool calls plus a reporting format — so a client can start from intent
   * instead of from a tool list. The resource gives the same catalog data a
   * non-tool read path, which clients use for context attachment.
   */
  server.registerPrompt(
    "weekly_inventory_review",
    {
      title: "Weekly Inventory Review",
      description:
        "Runs the full inventory review: low-stock alerts, restock plan ordered by days of cover, and the sales " +
        "trend behind them, then writes up what to reorder first. An optional category narrows every step to one " +
        "category.",
      argsSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Narrow the review to one category, e.g. 'tech'. Every step applies the filter, so all figures are " +
              "scoped to that category. Omit to review the whole catalog."
          ),
      },
    },
    // Sync on purpose: `PromptCallback` accepts a bare `GetPromptResult`, and
    // there is nothing to await — rendering is pure.
    ({ category }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: renderWeeklyReview({ category }),
          },
        },
      ],
    })
  );

  server.registerResource(
    "catalog",
    "tango://catalog",
    {
      title: "Product Catalog",
      description:
        `The current product catalog as JSON — the same rows ${TOOL.listAllProducts} returns, readable without a tool call.`,
      mimeType: "application/json",
    },
    async (uri) => {
      const products = await dataProvider.getProducts();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(products),
          },
        ],
      };
    }
  );

  return server;
}
