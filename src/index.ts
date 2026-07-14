#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { withSanitizedErrors, formatZodIssues } from "./mcpHelpers.js";
import { getEngine, type EngineEvent } from "./engine.js";
import type {
  AlertSeverity,
  InventoryAlert,
  Order,
  OrderStatus,
  Product,
} from "./types.js";

// ---------------------------------------------------------------------------
// Hybrid Engine — SQLite + Trie + Event Broker + Saga
// ---------------------------------------------------------------------------
const engine = getEngine();

const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const CRITICAL_STOCK_THRESHOLD = 3;
const ASSUMED_SUPPLIER_LEAD_TIME_DAYS = 14;
const SAFETY_STOCK_DAYS = 7;
const SALES_LOOKBACK_DAYS = 30;

const server = new McpServer({
  name: "project-tango",
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
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

function unitsSoldForProduct(orders: Order[], productId: string): number {
  return orders.reduce((total, order) => {
    const item = order.items.find((i) => i.productId === productId);
    return total + (item?.quantity ?? 0);
  }, 0);
}

// ---------------------------------------------------------------------------
// Reactive Event Broker — subscribes to engine events and pushes MCP
// notifications/resources/updated to the client in real time.
// ---------------------------------------------------------------------------

const subscribedResources = new Set<string>();

// @ts-expect-error MCP SDK types may differ from runtime
server.setRequestHandler?.(
  { method: "resources/subscribe" },
  async (request: { params?: { uri?: string } }) => {
    const uri = request.params?.uri;
    if (uri) {
      subscribedResources.add(uri);
      console.error(`Client subscribed to: ${uri}`);
    }
    return {};
  },
);

// @ts-expect-error MCP SDK types may differ from runtime
server.setRequestHandler?.(
  { method: "resources/unsubscribe" },
  async (request: { params?: { uri?: string } }) => {
    const uri = request.params?.uri;
    if (uri) {
      subscribedResources.delete(uri);
      console.error(`Client unsubscribed from: ${uri}`);
    }
    return {};
  },
);

engine.onEvent((event: EngineEvent) => {
  const matches: string[] = [];
  for (const uri of subscribedResources) {
    if (uri === event.resourceUri || uri === "tango://*") {
      matches.push(uri);
    }
    if (uri.endsWith("/*") && event.resourceUri.startsWith(uri.slice(0, -1))) {
      matches.push(uri);
    }
  }
  for (const matchedUri of matches) {
    try {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: { uri: matchedUri },
        }) + "\n",
      );
    } catch {
      subscribedResources.clear();
    }
  }
});

// ---------------------------------------------------------------------------
// Tool 1: list_all_products
// ---------------------------------------------------------------------------
server.registerTool(
  "list_all_products",
  {
    title: "List All Products",
    description:
      "Returns the full product catalog, optionally filtered by category, price range, or free-text search.",
    inputSchema: {
      category: z
        .string()
        .max(50)
        .optional()
        .describe("Restrict results to a single category, e.g. 'tech', 'apparel', or 'home'. Case-insensitive."),
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
        .max(100)
        .optional()
        .describe(
          "Free-text search query via the in-memory prefix trie for near-instant results.",
        ),
    },
  },
  withSanitizedErrors(async ({ category, min_price, max_price, search }) => {
    let products = await engine.getProducts();
    if (search && search.trim().length > 0) {
      const searchIds = new Set(engine.searchProductIds(search));
      products = products.filter((p) => searchIds.has(p.id));
    }
    const filtered = products.filter((p) => {
      if (category && p.category.toLowerCase() !== category.toLowerCase()) return false;
      if (typeof min_price === "number" && p.price < min_price) return false;
      if (typeof max_price === "number" && p.price > max_price) return false;
      return true;
    });
    return jsonResult({
      count: filtered.length,
      filters: { category: category ?? null, min_price: min_price ?? null, max_price: max_price ?? null, search: search ?? null },
      products: filtered,
    });
  }),
);

// ---------------------------------------------------------------------------
// Tool 2: get_low_stock_alerts
// ---------------------------------------------------------------------------
server.registerTool(
  "get_low_stock_alerts",
  {
    title: "Get Low Stock Alerts",
    description:
      "Scans inventory and returns alerts for every product at or below a stock threshold. " +
      "Products under 3 units are flagged 'critical'; the rest at or under threshold are 'low'. Sorted by urgency.",
    inputSchema: {
      threshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Stock threshold. Defaults to ${DEFAULT_LOW_STOCK_THRESHOLD} if omitted.`),
    },
  },
  withSanitizedErrors(async ({ threshold }) => {
    const effectiveThreshold = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const products = await engine.getProducts();
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
  }),
);

// ---------------------------------------------------------------------------
// Tool 3: analyze_sales_metrics
// ---------------------------------------------------------------------------
server.registerTool(
  "analyze_sales_metrics",
  {
    title: "Analyze Sales Metrics",
    description:
      "Gross revenue, AOV, top sellers, and order-status breakdown from order history.",
  },
  withSanitizedErrors(async () => {
    const [products, orders] = await Promise.all([engine.getProducts(), engine.getOrders()]);
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
    const orderFulfillmentBreakdown: Record<OrderStatus, number> = { pending: 0, shipped: 0, delivered: 0 };
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
  }),
);

// ---------------------------------------------------------------------------
// Tool 4: smart_restock_predictor
// ---------------------------------------------------------------------------
server.registerTool(
  "smart_restock_predictor",
  {
    title: "Smart Restock Predictor",
    description:
      "Recommends reorder quantities based on demand velocity, supplier lead time, and safety stock.",
    inputSchema: {
      threshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Stock threshold for restock consideration. Defaults to ${DEFAULT_LOW_STOCK_THRESHOLD}.`),
    },
  },
  withSanitizedErrors(async ({ threshold }) => {
    const effectiveThreshold = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const [products, orders] = await Promise.all([engine.getProducts(), engine.getOrders()]);
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
          basis: hasSalesHistory ? "demand_velocity" as const : "fallback_flat_rate" as const,
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
  }),
);

// ---------------------------------------------------------------------------
// Tool 5: draft_product_copy
// ---------------------------------------------------------------------------
server.registerTool(
  "draft_product_copy",
  {
    title: "Draft Product Copy",
    description:
      "Looks up a product by SKU and generates marketing copy (headline, description, bullet points) plus SEO tags.",
    inputSchema: {
      sku: z.string().min(1).max(30).describe("The exact product SKU, e.g. 'TCH-AB-001'."),
    },
  },
  withSanitizedErrors(async ({ sku }) => {
    const product = await engine.getProductBySku(sku);
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
      copy: { headline, shortDescription: product.description, longDescription, bulletPoints },
      seoTags,
    });
  }),
);

// ---------------------------------------------------------------------------
// Tool 6: simulate_order_placement (with saga rollback protection)
// ---------------------------------------------------------------------------
server.registerTool(
  "simulate_order_placement",
  {
    title: "Simulate Order Placement",
    description:
      "Places a simulated order with saga rollback protection. Validates stock for every line item, " +
      "decrements inventory atomically, and persists the order to SQLite. If any step fails, the " +
      "saga automatically rolls back all partial changes.",
    inputSchema: {
      customer_name: z.string().min(1).max(100).describe("Full name of the customer."),
      items: z
        .array(
          z.object({
            product_id: z.string().min(1).max(30).describe("The product's id, e.g. 'prod_004'."),
            quantity: z.number().int().positive().describe("Number of units to order."),
          }),
        )
        .min(1)
        .describe("One or more line items."),
    },
  },
  withSanitizedErrors(async ({ customer_name, items }) => {
    const products = await engine.getProducts();
    const resolvedItems: { product: Product; quantity: number }[] = [];
    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) {
        return errorResult(`Order rejected: no product found with id "${item.product_id}".`);
      }
      if (product.inventoryCount < item.quantity) {
        return errorResult(
          `Order rejected: "${product.name}" (${product.id}) has only ${product.inventoryCount} unit(s) in stock, ` +
            `but ${item.quantity} were requested.`,
        );
      }
      resolvedItems.push({ product, quantity: item.quantity });
    }
    const newOrder: Order = {
      id: `ord_${crypto.randomUUID().slice(0, 8)}`,
      customerName: customer_name,
      items: resolvedItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      totalAmount: Math.round(
        resolvedItems.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0) * 100,
      ) / 100,
      status: "pending" as OrderStatus,
      date: new Date().toISOString().slice(0, 10),
    };
    await engine.addOrder(newOrder);
    const updatedStockLevels = [];
    for (const { product } of resolvedItems) {
      const updated = await engine.getProductById(product.id);
      updatedStockLevels.push({
        productId: product.id,
        productName: product.name,
        newStock: updated?.inventoryCount ?? 0,
      });
    }
    return jsonResult({ success: true, receipt: newOrder, updatedStockLevels });
  }),
);

// ---------------------------------------------------------------------------
// Tool 7: search_products — Trie-powered instant prefix search
// ---------------------------------------------------------------------------
server.registerTool(
  "search_products",
  {
    title: "Search Products",
    description:
      "Searches the product catalog using an in-memory prefix trie for near-instant results. " +
      "Matches against product names, SKUs, categories, and tags. Results are relevance-scored.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(100)
        .describe("Search prefix to match against product names, SKUs, categories, and tags."),
      max_results: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum results. Defaults to 10."),
    },
  },
  withSanitizedErrors(async ({ query, max_results }) => {
    const maxResults = max_results ?? 10;
    const results = engine.searchProducts(query, maxResults);
    const enriched = [];
    for (const r of results) {
      const product = await engine.getProductById(r.productId);
      if (product) {
        enriched.push({
          productId: r.productId,
          productName: product.name,
          sku: product.sku,
          price: product.price,
          inventoryCount: product.inventoryCount,
          category: product.category,
          match: r.match,
          score: r.score,
        });
      }
    }
    return jsonResult({ query, totalResults: enriched.length, results: enriched });
  }),
);

// ---------------------------------------------------------------------------
// Boot the server over stdio
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Project Tango v2.0.0 — Hybrid Engine running on stdio.");
  console.error(
    `  Engine: SQLite + Prefix Trie | ${engine.trie.count} products indexed | ${engine.allProductIds().length} IDs`,
  );
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
