#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { mockDataProvider, stateStoreDescription } from "./mockData.js";
import { createServer } from "./server.js";
import type { DataProvider } from "./types.js";

/**
 * ---------------------------------------------------------------------------
 * Data source
 * ---------------------------------------------------------------------------
 * The whole MCP surface (8 tools, 1 prompt, 1 resource — see `server.ts`) is
 * written entirely against the `DataProvider` interface, and this line is the
 * only place a provider is chosen. To go live against Shopify/Stripe,
 * implement `DataProvider` in a new file (e.g. `src/shopifyDataProvider.ts`)
 * and swap the line below — no tool logic needs to change.
 */
const dataProvider: DataProvider = mockDataProvider;

async function main() {
  const transport = new StdioServerTransport();
  await createServer(dataProvider).connect(transport);
  // Note: stdout is reserved for the MCP protocol — all diagnostic logging
  // must go to stderr, which is exactly what console.error does.
  console.error(`Project Tango MCP server running on stdio. State: ${stateStoreDescription}`);
}

main().catch((error) => {
  console.error("Fatal error starting Project Tango:", error);
  process.exit(1);
});
