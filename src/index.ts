#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { mockDataProvider } from "./mockData.js";
import { withSanitizedErrors, formatZodIssues } from "./mcpHelpers.js";
import type {
  AlertSeverity,
  DataProvider,
  InventoryAlert,
  Order,
  OrderStatus,
  Product,
} from "./types.js";

/**
 * ---------------------------------------------------------------------------
 * Data source
 * ---------------------------------------------------------------------------
 * Every tool below is written entirely against the `DataProvider` interface.
 * To go live against Shopify/Stripe, implement `DataProvider` in a new file
 * (e.g. `src/shopifyDataProvider.ts`) and swap the line below — no tool
 * logic needs to change.
 */
const dataProvider: DataProvider = mockDataProvider;

const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const CRITICAL_STOCK_THRESHOLD = 3;
const ASSUMED_SUPPLIER_LEAD_TIME_DAYS = 14;
const SAFETY_STOCK_DAYS = 7;
const SALES_LOOKBACK_DAYS = 30;

const server = new McpServer({
  name: "project-tango",
  version: "1.0.0",
});

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

function toAlert(product: Product): InventoryAlert {
  const severity: AlertSeverity =
    product.inventoryCount < CRITICAL_STOCK_THRESHOLD ? "critical" : "low";
  return {
    productId: product.id,
    productName: product.name,
    currentStock: product.inventoryCount,
    severity,
  };
}

/** Total units of a given product sold across all orders. */
function unitsSoldForProduct(orders: Order[], productId: string): number {
  return orders.reduce((total, order) => {
    const item = order.items.find((i) => i.productId === productId);
    return total + (item?.quantity ?? 0);
  }, 0);
}

// -----------------------------------------------------------------------
// Tool 1: list_all_products
// -----------------------------------------------------------------------
server.registerTool(
  "list_all_products",
  {
    title: "List All Products",
    description:
      "Returns the full product catalog, optionally filtered by category and/or a min/max price range. " +
      "Use this to browse or search inventory before recommending, restocking, or drafting copy for products.",
    inputSchema: {
      category: z
        .string()
        .max(50)
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
    },
  },
  withSanitizedErrors(async ({ category, min_price, max_price }) => {
    const products = await dataProvider.getProducts();

    const filtered = products.filter((p) => {
      if (category && p.category.toLowerCase() !== category.toLowerCase()) return false;
      if (typeof min_price === "number" && p.price < min_price) return false;
      if (typeof max_price === "number" && p.price > max_price) return false;
      return true;
    });

    return jsonResult({
      count: filtered.length,
      filters: { category: category ?? null, min_price: min_price ?? null, max_price: max_price ?? null },
      products: filtered,
    });
  })
);

// -----------------------------------------------------------------------
// Tool 2: get_low_stock_alerts
// -----------------------------------------------------------------------
server.registerTool(
  "get_low_stock_alerts",
  {
    title: "Get Low Stock Alerts",
    description:
      "Scans the entire inventory and returns InventoryAlert objects for every product at or below a stock threshold. " +
      "Products under 3 units are flagged 'critical'; everything else at or under the threshold is flagged 'low'. " +
      "Results are sorted by current stock ascending (most urgent first).",
    inputSchema: {
      threshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Stock level at or below which a product triggers an alert. Defaults to ${DEFAULT_LOW_STOCK_THRESHOLD} if omitted.`
        ),
    },
  },
  withSanitizedErrors(async ({ threshold }) => {
    const effectiveThreshold = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const products = await dataProvider.getProducts();

    const alerts = products
      .filter((p) => p.inventoryCount <= effectiveThreshold)
      .map(toAlert)
      .sort((a, b) => a.currentStock - b.currentStock);

    return jsonResult({
      thresholdUsed: effectiveThreshold,
      alertCount: alerts.length,
      criticalCount: alerts.filter((a) => a.severity === "critical").length,
      alerts,
    });
  })
);

// -----------------------------------------------------------------------
// Tool 3: analyze_sales_metrics
// -----------------------------------------------------------------------
server.registerTool(
  "analyze_sales_metrics",
  {
    title: "Analyze Sales Metrics",
    description:
      "Calculates gross revenue, average order value (AOV), the top-selling products by units sold, and a breakdown " +
      "of orders by fulfillment status (pending / shipped / delivered), based on current order history.",
  },
  withSanitizedErrors(async () => {
    const [products, orders] = await Promise.all([dataProvider.getProducts(), dataProvider.getOrders()]);

    const grossRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
    const averageOrderValue = orders.length > 0 ? grossRevenue / orders.length : 0;

    const unitsByProduct = new Map<string, number>();
    for (const order of orders) {
      for (const item of order.items) {
        unitsByProduct.set(item.productId, (unitsByProduct.get(item.productId) ?? 0) + item.quantity);
      }
    }

    const topSellingProducts = [...unitsByProduct.entries()]
      .map(([productId, unitsSold]) => {
        const product = products.find((p) => p.id === productId);
        return {
          productId,
          productName: product?.name ?? "Unknown product",
          unitsSold,
          revenue: Math.round((product?.price ?? 0) * unitsSold * 100) / 100,
        };
      })
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 5);

    const orderFulfillmentBreakdown: Record<OrderStatus, number> = {
      pending: 0,
      shipped: 0,
      delivered: 0,
    };
    for (const order of orders) {
      orderFulfillmentBreakdown[order.status] += 1;
    }

    return jsonResult({
      orderCount: orders.length,
      grossRevenue: Math.round(grossRevenue * 100) / 100,
      averageOrderValue: Math.round(averageOrderValue * 100) / 100,
      topSellingProducts,
      orderFulfillmentBreakdown,
    });
  })
);

// -----------------------------------------------------------------------
// Tool 4: smart_restock_predictor
// -----------------------------------------------------------------------
server.registerTool(
  "smart_restock_predictor",
  {
    title: "Smart Restock Predictor",
    description:
      "Evaluates every low-stock item and recommends an exact reorder quantity. The recommendation is derived from " +
      "each product's demand velocity (units sold per day over recent order history), projected demand across an " +
      `assumed ${ASSUMED_SUPPLIER_LEAD_TIME_DAYS}-day supplier lead time plus a ${SAFETY_STOCK_DAYS}-day safety buffer, minus current stock on hand. ` +
      "Items with no recent sales history fall back to a conservative flat restock quantity.",
    inputSchema: {
      threshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Stock level at or below which a product is considered for restocking. Defaults to ${DEFAULT_LOW_STOCK_THRESHOLD} if omitted.`
        ),
    },
  },
  withSanitizedErrors(async ({ threshold }) => {
    const effectiveThreshold = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const [products, orders] = await Promise.all([dataProvider.getProducts(), dataProvider.getOrders()]);

    const lowStockProducts = products.filter((p) => p.inventoryCount <= effectiveThreshold);

    const FALLBACK_RESTOCK_QTY = 20;

    const recommendations = lowStockProducts
      .map((product) => {
        const unitsSold = unitsSoldForProduct(orders, product.id);
        const dailyVelocity = unitsSold / SALES_LOOKBACK_DAYS;
        const projectedDemand = dailyVelocity * (ASSUMED_SUPPLIER_LEAD_TIME_DAYS + SAFETY_STOCK_DAYS);

        const hasSalesHistory = unitsSold > 0;
        const recommendedReorderQuantity = hasSalesHistory
          ? Math.max(0, Math.ceil(projectedDemand - product.inventoryCount))
          : Math.max(0, FALLBACK_RESTOCK_QTY - product.inventoryCount);

        return {
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          currentStock: product.inventoryCount,
          unitsSoldLast30Days: unitsSold,
          dailyVelocity: Math.round(dailyVelocity * 1000) / 1000,
          basis: hasSalesHistory ? ("demand_velocity" as const) : ("fallback_flat_rate" as const),
          recommendedReorderQuantity,
        };
      })
      .sort((a, b) => b.recommendedReorderQuantity - a.recommendedReorderQuantity);

    return jsonResult({
      thresholdUsed: effectiveThreshold,
      assumptions: {
        supplierLeadTimeDays: ASSUMED_SUPPLIER_LEAD_TIME_DAYS,
        safetyStockDays: SAFETY_STOCK_DAYS,
        salesLookbackDays: SALES_LOOKBACK_DAYS,
        fallbackFlatRestockQuantity: FALLBACK_RESTOCK_QTY,
      },
      recommendations,
    });
  })
);

// -----------------------------------------------------------------------
// Tool 5: draft_product_copy
// -----------------------------------------------------------------------
server.registerTool(
  "draft_product_copy",
  {
    title: "Draft Product Copy",
    description:
      "Looks up a product by SKU and generates structured, high-conversion marketing copy (headline, short and long " +
      "description, key bullet points) plus SEO tags tailored to that product's category and tags.",
    inputSchema: {
      sku: z.string().min(1).max(30).describe("The exact product SKU to generate marketing copy for, e.g. 'TCH-AB-001'."),
    },
  },
  withSanitizedErrors(async ({ sku }) => {
    const product = await dataProvider.getProductBySku(sku);
    if (!product) {
      return errorResult(`No product found with SKU "${sku}". Use list_all_products to see valid SKUs.`);
    }

    const categoryVoice: Record<string, string> = {
      tech: "engineered for people who expect their gear to keep up",
      apparel: "made to be worn, washed, and worn again for years",
      home: "designed to make everyday rituals feel a little more considered",
    };
    const voice = categoryVoice[product.category.toLowerCase()] ?? "built with care, down to the last detail";

    const headline = `${product.name} — ${voice}`;
    const shortDescription = product.description;
    const longDescription =
      `${product.description} Part of our ${product.category} lineup, the ${product.name} is ${voice}. ` +
      `Every detail — from ${product.tags[0] ?? "materials"} to everyday durability — was chosen so this earns a ` +
      `permanent spot in your routine, not just a place in your cart.`;

    const bulletPoints = [
      `Category: ${product.category}`,
      `Key attributes: ${product.tags.join(", ")}`,
      `Priced at $${product.price.toFixed(2)}`,
      product.inventoryCount < CRITICAL_STOCK_THRESHOLD
        ? "Limited stock available — won't last long"
        : "In stock and ready to ship",
    ];

    const seoTags = [...new Set([...product.tags, product.category, product.name.toLowerCase()])];

    return jsonResult({
      sku: product.sku,
      productId: product.id,
      copy: {
        headline,
        shortDescription,
        longDescription,
        bulletPoints,
      },
      seoTags,
    });
  })
);

// -----------------------------------------------------------------------
// Tool 6: simulate_order_placement
// -----------------------------------------------------------------------
server.registerTool(
  "simulate_order_placement",
  {
    title: "Simulate Order Placement",
    description:
      "Write-action tool: places a new simulated order, validating stock availability for every line item, " +
      "decrementing inventory counts, computing the order total from current catalog prices, and returning a " +
      "success receipt with the updated stock levels. Rejects the entire order (no partial writes) if any item " +
      "is unavailable or under-stocked.",
    inputSchema: {
      customer_name: z.string().min(1).max(100).describe("Full name of the customer placing the order."),
      items: z
        .array(
          z.object({
            product_id: z.string().min(1).max(30).describe("The product's id, e.g. 'prod_004'."),
            quantity: z.number().int().positive().describe("Number of units of this product to order."),
          })
        )
        .min(1)
        .describe("One or more line items for this order."),
    },
  },
  withSanitizedErrors(async ({ customer_name, items }) => {
    const products = await dataProvider.getProducts();

    // Validate every line item before mutating any state.
    const resolvedItems: { product: Product; quantity: number }[] = [];
    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) {
        return errorResult(`Order rejected: no product found with id "${item.product_id}".`);
      }
      if (product.inventoryCount < item.quantity) {
        return errorResult(
          `Order rejected: "${product.name}" (${product.id}) has only ${product.inventoryCount} unit(s) in stock, ` +
            `but ${item.quantity} were requested.`
        );
      }
      resolvedItems.push({ product, quantity: item.quantity });
    }

    // All validated — now apply the writes.
    const updatedStockLevels: { productId: string; productName: string; newStock: number }[] = [];
    let totalAmount = 0;
    for (const { product, quantity } of resolvedItems) {
      const newCount = product.inventoryCount - quantity;
      await dataProvider.updateProductInventory(product.id, newCount);
      totalAmount += product.price * quantity;
      updatedStockLevels.push({ productId: product.id, productName: product.name, newStock: newCount });
    }

    const newOrder: Order = {
      id: `ord_${Date.now()}`,
      customerName: customer_name,
      items: resolvedItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      totalAmount: Math.round(totalAmount * 100) / 100,
      status: "pending",
      date: new Date().toISOString().slice(0, 10),
    };
    await dataProvider.addOrder(newOrder);

    return jsonResult({
      success: true,
      receipt: newOrder,
      updatedStockLevels,
    });
  })
);

// -----------------------------------------------------------------------
// Boot the server over stdio
// -----------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: stdout is reserved for the MCP protocol — all diagnostic logging
  // must go to stderr, which is exactly what console.error does.
  console.error("Project Tango MCP server running on stdio.");
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error(formatZodIssues(error));
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Fatal error starting Project Tango:", message);
  }
  process.exit(1);
});
