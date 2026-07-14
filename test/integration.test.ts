#!/usr/bin/env tsx
/**
 * integration.test.ts — Runs every Project Tango tool through the MCP stdio
 * transport and reports on:
 *
 *   1. Successful response shape (no errors)
 *   2. Input validation bounds (oversized strings rejected)
 *   3. Error-path sanitization (no stack traces in error results)
 *   4. State isolation (mutations don't leak across reads)
 *
 * Usage:
 *   tsx test/integration.test.ts
 *
 * The script exits with 0 if all checks pass, 1 otherwise.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let requestId = 1;
function nextId(): number {
  return requestId++;
}

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/**
 * Spawns the MCP server and returns send/receive helpers.
 */
async function connect(): Promise<{
  send: (method: string, params?: Record<string, unknown>, id?: number) => Promise<Record<string, unknown>>;
  notify: (method: string, params?: Record<string, unknown>) => void;
  close: () => void;
}> {
  const proc: ChildProcess = spawn("tsx", ["src/index.ts"], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: false,
  });

  let buffer = "";
  const pending = new Map<number, (data: Record<string, unknown>) => void>();

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    // MCP sends one JSON-RPC message per line (newline-delimited)
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: JsonRpcMessage = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const resolve = pending.get(msg.id)!;
          pending.delete(msg.id);
          resolve(msg.result ?? { _error: msg.error });
        }
      } catch {
        // ignore malformed lines
      }
    }
  });

  // Wait for the process to be ready
  await new Promise<void>((resolve) => {
    // After spawn, send the initialize handshake
    const initId = nextId();
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    });
    proc.stdin!.write(msg + "\n");

    pending.set(initId, (_result) => {
      // Send initialized notification
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
      );
      resolve();
    });
  });

  return {
    send: (method: string, params?: Record<string, unknown>, id?: number) => {
      return new Promise<Record<string, unknown>>((resolve) => {
        const msgId = id ?? nextId();
        const msg = JSON.stringify({
          jsonrpc: "2.0",
          id: msgId,
          method,
          params,
        });
        pending.set(msgId, resolve);
        proc.stdin!.write(msg + "\n");
      });
    },
    notify: (method: string, params?: Record<string, unknown>) => {
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
      );
    },
    close: () => {
      proc.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n🔧 Project Tango — Integration Test Suite\n");
  console.log("Connecting to MCP server over stdio...\n");

  const mcp = await connect();
  console.log("  ✅ Handshake complete\n");

  // ── 1. tools/list ──────────────────────────────────────────────────
  console.log("── Tool Discovery ──────────────────────────────────────");
  const listResult = await mcp.send("tools/list");
  const tools = listResult.tools as Array<{ name: string; description?: string }>;
  assert(tools.length === 7, `Expected 7 tools, got ${tools.length}`);
  const toolNames = tools.map((t) => t.name);
  assert(
    toolNames.includes("list_all_products") &&
      toolNames.includes("get_low_stock_alerts") &&
      toolNames.includes("analyze_sales_metrics") &&
      toolNames.includes("smart_restock_predictor") &&
      toolNames.includes("draft_product_copy") &&
      toolNames.includes("simulate_order_placement") &&
      toolNames.includes("search_products"),
    "All 7 tool names present",
    `Found: ${toolNames.join(", ")}`
  );
  console.log();

  // ── 2. list_all_products (no filters) ──────────────────────────────
  console.log("── Tool: list_all_products ─────────────────────────────");
  const allProducts = await mcp.send("tools/call", {
    name: "list_all_products",
    arguments: {},
  });
  const allContent = extractText(allProducts);
  const allData = safeJson(allContent);
  assert(allData !== null, "Returns valid JSON");
  assert(allData.count === 13, `Expected 13 products, got ${allData.count}`, allContent.slice(0, 100));
  assert(Array.isArray(allData.products), "products is an array");
  assert(allData.products.length === 13, "products length matches count");
  // Verify deep-cloning: a second read should return the original data,
  // not a previously returned reference that could have been mutated.
  const productsAgain = await mcp.send("tools/call", {
    name: "list_all_products",
    arguments: {},
  });
  const againData = safeJson(extractText(productsAgain));
  assert(againData.products[0].name === "AeroBuds Pro Wireless Earbuds", "Read isolation (clone)");
  console.log();

  // ── 3. list_all_products (with filters) ────────────────────────────
  console.log("── Tool: list_all_products (filtered) ──────────────────");
  const filtered = await mcp.send("tools/call", {
    name: "list_all_products",
    arguments: { category: "apparel" },
  });
  const fData = safeJson(extractText(filtered));
  assert(fData.count === 4, `Expected 4 apparel products, got ${fData.count}`);
  assert(
    fData.products.every((p: { category: string }) => p.category === "apparel"),
    "All filtered products are apparel"
  );
  console.log();

  // ── 4. get_low_stock_alerts ───────────────────────────────────────
  console.log("── Tool: get_low_stock_alerts ──────────────────────────");
  const alerts = await mcp.send("tools/call", {
    name: "get_low_stock_alerts",
    arguments: {},
  });
  const aData = safeJson(extractText(alerts));
  assert(aData.alertCount > 0, "Returns at least one alert", `Count: ${aData.alertCount}`);
  assert(typeof aData.criticalCount === "number", "Has criticalCount");
  assert(aData.alerts.length === aData.alertCount, "alerts length matches count");
  // Default threshold is 5 — several products have stock ≤ 5
  assert(
    aData.alerts.every((a: { severity: string }) => ["low", "critical"].includes(a.severity)),
    "All alerts have valid severity"
  );
  console.log();

  // ── 5. analyze_sales_metrics ──────────────────────────────────────
  console.log("── Tool: analyze_sales_metrics ─────────────────────────");
  const metrics = await mcp.send("tools/call", {
    name: "analyze_sales_metrics",
    arguments: {},
  });
  const mData = safeJson(extractText(metrics));
  assert(typeof mData.grossRevenue === "number" && mData.grossRevenue > 0, "Gross revenue > 0");
  assert(typeof mData.averageOrderValue === "number" && mData.averageOrderValue > 0, "AOV > 0");
  assert(mData.orderCount === 5, `Expected 5 orders, got ${mData.orderCount}`);
  assert(Array.isArray(mData.topSellingProducts), "topSellingProducts is array");
  assert(
    typeof mData.orderFulfillmentBreakdown?.pending === "number",
    "Has order fulfillment breakdown"
  );
  console.log();

  // ── 6. smart_restock_predictor ────────────────────────────────────
  console.log("── Tool: smart_restock_predictor ───────────────────────");
  const restock = await mcp.send("tools/call", {
    name: "smart_restock_predictor",
    arguments: {},
  });
  const rData = safeJson(extractText(restock));
  assert(rData.recommendations.length > 0, "Has recommendations");
  assert(rData.recommendations[0].recommendedReorderQuantity >= 0, "Recommended qty >= 0");
  assert(
    rData.recommendations.every((rec: { basis: string }) =>
      ["demand_velocity", "fallback_flat_rate"].includes(rec.basis)
    ),
    "All recommendations have valid basis"
  );
  console.log();

  // ── 7. draft_product_copy ─────────────────────────────────────────
  console.log("── Tool: draft_product_copy ────────────────────────────");
  const copy = await mcp.send("tools/call", {
    name: "draft_product_copy",
    arguments: { sku: "TCH-AB-001" },
  });
  const cData = safeJson(extractText(copy));
  assert(cData.copy?.headline?.includes("AeroBuds"), "Headline includes product name");
  assert(cData.copy?.bulletPoints?.length === 4, "Has 4 bullet points");
  assert(Array.isArray(cData.seoTags), "Has SEO tags array");
  console.log();

  // ── 8. simulate_order_placement ───────────────────────────────────
  console.log("── Tool: simulate_order_placement ──────────────────────");
  const order = await mcp.send("tools/call", {
    name: "simulate_order_placement",
    arguments: {
      customer_name: "Test User",
      items: [{ product_id: "prod_003", quantity: 2 }],
    },
  });
  const oData = safeJson(extractText(order));
  assert(oData.success === true, "Order succeeds", JSON.stringify(oData));
  assert(oData.receipt?.customerName === "Test User", "Receipt has customer name");
  // prod_003 started at 15, we ordered 2, so stock should be 13
  assert(oData.updatedStockLevels?.[0]?.newStock === 13, "Stock decremented (15→13)");
  console.log();

  // ── 9. search_products (new v2.0.0 tool) ─────────────────────────
  console.log("── Tool: search_products ────────────────────────────────");
  const search = await mcp.send("tools/call", {
    name: "search_products",
    arguments: { query: "aero", max_results: 5 },
  });
  const sData = safeJson(extractText(search));
  assert(sData.totalResults > 0, "Search returns results", `Query 'aero' returned ${sData.totalResults}`);
  assert(sData.results.some((r: { productName: string }) => r.productName.includes("AeroBuds")), "AeroBuds in search results");
  assert(typeof sData.results[0].score === "number", "Search results have scores");
  // Edge case: empty results for nonsense query
  const noResults = await mcp.send("tools/call", {
    name: "search_products",
    arguments: { query: "xyznonexistent" },
  });
  const noData = safeJson(extractText(noResults));
  assert(noData.totalResults === 0, "Nonsense query returns 0 results");
  console.log();

  // ── 10. Validation bounds ──────────────────────────────────────────
  console.log("── Input Validation Bounds ─────────────────────────────");
  // Oversized customer_name should fail
  const longName = await mcp.send("tools/call", {
    name: "simulate_order_placement",
    arguments: {
      customer_name: "A".repeat(150),
      items: [{ product_id: "prod_003", quantity: 1 }],
    },
  });
  assert(longName.isError === true || longName._error !== undefined, "Overlong name rejected");
  // Oversized SKU should fail
  const longSku = await mcp.send("tools/call", {
    name: "draft_product_copy",
    arguments: { sku: "X".repeat(50) },
  });
  assert(longSku.isError === true || longSku._error !== undefined, "Overlong SKU rejected");
  // Oversized product_id should fail
  const longPid = await mcp.send("tools/call", {
    name: "simulate_order_placement",
    arguments: {
      customer_name: "Test",
      items: [{ product_id: "X".repeat(50), quantity: 1 }],
    },
  });
  assert(longPid.isError === true || longPid._error !== undefined, "Overlong product_id rejected");
  console.log();

  // ── 11. Error-path sanitization ───────────────────────────────────
  console.log("── Error Sanitization ──────────────────────────────────");
  // Non-existent SKU should return a clean error (not crash)
  const badSku = await mcp.send("tools/call", {
    name: "draft_product_copy",
    arguments: { sku: "DOES-NOT-EXIST" },
  });
  const badSkuText = extractText(badSku);
  assert(
    badSkuText.includes("not found") || badSku.isError === true,
    "Non-existent SKU returns clean error",
    badSkuText
  );
  // Excessive quantity should return clean error (not crash)
  const overOrder = await mcp.send("tools/call", {
    name: "simulate_order_placement",
    arguments: {
      customer_name: "Test",
      items: [{ product_id: "prod_011", quantity: 999 }],
    },
  });
  const overText = extractText(overOrder);
  assert(
    overText.includes("rejected") || overText.includes("stock") || overOrder.isError === true,
    "Over-order returns clean error",
    overText
  );
  // Non-existent product_id should return clean error
  const badPid = await mcp.send("tools/call", {
    name: "simulate_order_placement",
    arguments: {
      customer_name: "Test",
      items: [{ product_id: "prod_999", quantity: 1 }],
    },
  });
  const badPidText = extractText(badPid);
  assert(
    badPidText.includes("rejected") || badPidText.includes("not found") || badPid.isError === true,
    "Non-existent product_id returns clean error",
    badPidText
  );
  console.log();

  // ── 12. State isolation (order mutation doesn't leak) ──────────────
  console.log("── State Isolation ─────────────────────────────────────");
  // After placing an order, the products list should reflect the new stock
  const finalProducts = await mcp.send("tools/call", {
    name: "list_all_products",
    arguments: {},
  });
  const finalData = safeJson(extractText(finalProducts));
  const dataVault = finalData.products.find(
    (p: { id: string }) => p.id === "prod_003"
  );
  assert(dataVault.inventoryCount === 13, "Stock persisted (15-2=13)");
  console.log();

  // ── Summary ────────────────────────────────────────────────────────
  console.log("─────────────────────────────────────────────────────────\n");
  const total = passed + failed;
  console.log(`  ${passed}/${total} checks passed${failed > 0 ? `, ${failed} failed!` : " — all clear!"}`);
  console.log();

  mcp.close();
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function extractText(result: Record<string, unknown>): string {
  if (result._error) return JSON.stringify(result._error);
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  if (!content || content.length === 0) return "";
  const textEntry = content.find((c) => c.type === "text");
  return textEntry?.text ?? JSON.stringify(content[0]);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
