#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";
import { durabilityBlocker } from "./storage.js";
import type { DataProvider } from "./types.js";

/**
 * ---------------------------------------------------------------------------
 * Data source
 * ---------------------------------------------------------------------------
 * The whole MCP surface (8 tools, 1 prompt, 1 resource — see `server.ts`) is
 * written entirely against the `DataProvider` interface, and the import below is
 * the only place a provider is chosen. To go live against Shopify/Stripe,
 * implement `DataProvider` in a new file (e.g. `src/shopifyDataProvider.ts`)
 * and swap that one import — no tool logic needs to change.
 *
 * It is a dynamic import so the runtime floor is checked *before* the provider
 * loads. `./mockData.js` resolves its state store in a top-level await, so a
 * static import would create the data directory and print its own fallback
 * warnings before `main()` ever ran — on a runtime that was never going to
 * serve anyway, and with a set of warnings that contradicted the refusal the
 * user was about to read.
 */
async function main() {
  const blocker = await durabilityBlocker();
  if (blocker) {
    // stdout is reserved for the MCP protocol, so this — like every other
    // diagnostic — goes to stderr. The client has no other way to hear why its
    // server did not start.
    console.error(blocker);
    process.exit(1);
  }

  const { mockDataProvider, stateStoreDescription } = await import("./mockData.js");
  const dataProvider: DataProvider = mockDataProvider;

  const transport = new StdioServerTransport();
  await createServer(dataProvider).connect(transport);
  console.error(`Project Tango MCP server running on stdio. State: ${stateStoreDescription}`);
}

main().catch((error) => {
  console.error("Fatal error starting Project Tango:", error);
  process.exit(1);
});
