import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Exactly what `client.callTool` resolves to, including its result union. */
export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

import type { Order, Product } from "./types.js";

/**
 * Shared test scaffolding: the fixtures the analytics suites build on, and the
 * stdio client that drives the real server.
 *
 * Lives outside `*.test.ts` because several suites need it, and excluded from
 * the build alongside them (see tsconfig.json) — this is test code, and `dist/`
 * should contain only what the server actually ships.
 */

// --- Fixtures -------------------------------------------------------------
// One copy of each: a fixture change is a deliberate edit in a single place,
// rather than a divergence between the per-module suites that use them.

export function makeProduct(overrides: Partial<Product> & { id: string }): Product {
  return {
    name: `Product ${overrides.id}`,
    sku: `SKU-${overrides.id}`,
    price: 100,
    inventoryCount: 50,
    category: "tech",
    tags: ["generic"],
    description: "A test product.",
    ...overrides,
  };
}

export function makeOrder(
  id: string,
  items: Array<{ productId: string; quantity: number }>,
  overrides: Partial<Order> = {}
): Order {
  return {
    id,
    customerName: "Test Customer",
    items,
    totalAmount: 0,
    status: "delivered",
    date: "2026-10-01",
    ...overrides,
  };
}

/** Fixed clock so every window assertion is reproducible. */
export const NOW = Date.parse("2026-10-01T00:00:00.000Z");

const SERVER_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * Launch a server with its state pinned to `dataDir`.
 *
 * The server persists to `~/.project-tango` by default, so tests must always
 * override it — otherwise a test run would mutate the developer's real catalog
 * and leak state from one run into the next.
 */
export async function connectServer(
  dataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", SERVER_ENTRY],
    env: { ...process.env, PROJECT_TANGO_DATA_DIR: dataDir, ...extraEnv },
  });
  const client = new Client({ name: "project-tango-tests", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Parse a tool result's text block as JSON.
 *
 * Typed as the SDK's own `callTool` result rather than a hand-rolled shape: the
 * return is a union that also covers results carrying `toolResult` instead of
 * `content`, and a narrower parameter type made every call site fail to typecheck
 * once the suites were actually checked. Narrowing happens here, once.
 */
export function parse(r: ToolResult): any {
  const content = "content" in r ? (r.content as Array<{ text?: unknown }> | undefined) : undefined;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result carried no text content");
  return JSON.parse(text);
}
