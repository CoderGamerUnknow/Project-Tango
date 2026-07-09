# Project Tango

A **local-first** [Model Context Protocol](https://modelcontextprotocol.io) server that gives LLM agents — Claude Desktop, Cursor, VS Code, or any MCP-compatible client — instant, structured access to e-commerce data: products, inventory, orders, and sales analytics.

Project Tango ships with a realistic mock dataset so it works in under a minute with **zero configuration**, and it's built around a clean `DataProvider` interface so you can swap the mock engine for live Shopify/Stripe APIs without touching a single tool definition.

- **Runs entirely on your machine** over stdio — no server to deploy, no database to host.
- **$0 infrastructure cost.**
- **Production-ready TypeScript**, strict mode, fully typed domain model.

---

## What's inside

| Tool | What it does |
|---|---|
| `list_all_products` | Browse/search the catalog, filterable by category and price range |
| `get_low_stock_alerts` | Scans inventory and flags `low` / `critical` stock levels |
| `analyze_sales_metrics` | Gross revenue, AOV, top sellers, order-status breakdown |
| `smart_restock_predictor` | Recommends exact reorder quantities from demand velocity |
| `draft_product_copy` | Generates marketing copy + SEO tags for a given SKU |
| `simulate_order_placement` | Places a simulated order, validates stock, decrements inventory |

---

## Prerequisites

- **Node.js 18 or later** (`node -v` to check)
- npm (ships with Node)

---

## Quickstart

```bash
# 1. Clone the repository
git clone https://github.com/your-org/project-tango.git
cd project-tango

# 2. Install dependencies
npm install

# 3. Run it locally
npm start
```

`npm start` runs `tsx src/index.ts` directly — no build step needed for local development. The server communicates over stdio, so running it directly in a terminal will just sit there waiting for a JSON-RPC client (that's expected — it's designed to be launched *by* an MCP client, not used interactively).

To produce a compiled build (used by the client configs below):

```bash
npm run build     # emits dist/index.js
npm run inspect    # optional: open the MCP Inspector to poke at tools by hand
```

---

## Connecting Project Tango to an MCP client

Both configs below assume you've run `npm run build` and are pointing at the absolute path of your local clone.

### A) Claude Desktop

Edit your `claude_desktop_config.json` (Claude menu → Settings → Developer → Edit Config) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "project-tango": {
      "command": "node",
      "args": ["/absolute/path/to/project-tango/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Project Tango's tools will appear in the tool picker (hammer icon) in your next conversation.

> Prefer not to build first? You can point Claude Desktop at `tsx` instead:
> ```json
> {
>   "mcpServers": {
>     "project-tango": {
>       "command": "npx",
>       "args": ["tsx", "/absolute/path/to/project-tango/src/index.ts"]
>     }
>   }
> }
> ```

### B) Cursor

In Cursor: **Settings → MCP → Add new MCP Server**, or edit `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "project-tango": {
      "command": "node",
      "args": ["/absolute/path/to/project-tango/dist/index.js"]
    }
  }
}
```

Cursor will list `project-tango` under Settings → MCP with a green dot once it connects successfully, and its tools become available to the agent in Composer/Chat.

---

## Going live: swapping mock data for Shopify/Stripe

Every tool in `src/index.ts` is written against the `DataProvider` interface defined in `src/types.ts` — it never touches the mock arrays directly. To connect real data:

1. Create `src/shopifyDataProvider.ts` (or similar) implementing `DataProvider`:
   ```ts
   export class ShopifyDataProvider implements DataProvider {
     async getProducts() { /* call Shopify Admin API */ }
     async getOrders() { /* call Shopify Admin API */ }
     async getProductById(id: string) { /* ... */ }
     async getProductBySku(sku: string) { /* ... */ }
     async updateProductInventory(id: string, newCount: number) { /* ... */ }
     async addOrder(order: Order) { /* ... */ }
   }
   ```
2. In `src/index.ts`, change one line:
   ```ts
   const dataProvider: DataProvider = new ShopifyDataProvider(/* credentials */);
   ```
3. Rebuild (`npm run build`) — no tool logic changes required.

---

## Security

- **Local-first by design.** Project Tango runs as a child process on your own machine and speaks to its MCP client exclusively over stdio. There is no network listener, no exposed port, and no cloud component in the default configuration.
- **Zero external data exposure.** With the default mock `DataProvider`, no data ever leaves your machine — there are no outbound network calls anywhere in the tool logic.
- **Explicit, validated inputs.** Every tool parameter is validated at runtime with Zod schemas before any logic executes, rejecting malformed or out-of-range input before it reaches your data layer.
- **No silent partial writes.** `simulate_order_placement` validates stock for every line item *before* mutating any inventory — a failing item rejects the whole order rather than leaving data half-updated.
- **Bring your own credentials for live mode.** When you implement a real `DataProvider` against Shopify/Stripe, credentials should be loaded from environment variables (e.g. via `process.env`) and never hard-coded — this template intentionally ships with no secrets or network calls of any kind.

---

## Project structure

```
project-tango/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts       # Domain types + DataProvider interface
│   ├── mockData.ts     # Zero-config in-memory dataset + MockDataProvider
│   └── index.ts        # McpServer setup and the 6 tools
└── README.md
```

## License

MIT
