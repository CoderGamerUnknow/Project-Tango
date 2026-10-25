<div align="center">

# Project Tango

**A local-first Model Context Protocol server that gives LLM agents structured access to e-commerce data — products, inventory, orders and sales analytics.**

[![CI](https://github.com/CoderGamerUnknow/Project-Tango/actions/workflows/ci.yml/badge.svg)](https://github.com/CoderGamerUnknow/Project-Tango/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-6f42c1?style=flat-square)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-287-16a34a?style=flat-square)](#testing)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)

</div>

## Overview

Works with Claude Desktop, Cursor, VS Code or any MCP-compatible client. It ships with a
realistic mock dataset, so it runs in under a minute with **zero configuration**, and every
tool is written against a `DataProvider` interface — swap the mock engine for live
Shopify/Stripe APIs without touching a single tool definition.

- **Runs entirely on your machine** over stdio — no server to deploy, no database to host.
- **$0 infrastructure cost.**
- **State survives a restart** — writes land in a local SQLite database, not in memory that
  evaporates when the MCP client relaunches the process.
- **Strict TypeScript**, fully typed domain model, coverage-gated test suite.

Release history, including a divergent `v2.0.0` lineage that was never merged into `main`
(its trie search is ported here), lives in [CHANGELOG.md](CHANGELOG.md).

## Tools

| Tool | What it does |
| --- | --- |
| `list_all_products` | Browse the catalog filtered by category, price range or free-text search — results ranked so a product whose own name, SKU, category or tag matches ranks above one that merely mentions the term |
| `get_low_stock_alerts` | Scans inventory and flags `low` / `critical` stock levels, optionally for one category |
| `analyze_sales_metrics` | Gross revenue, AOV, top sellers, order-status breakdown and a daily trend with a recent-vs-previous comparison, optionally scoped to one category |
| `smart_restock_predictor` | Ranks low-stock items by days of cover and recommends an exact reorder quantity |
| `draft_product_copy` | Generates marketing copy and SEO tags for a SKU |
| `find_orders` | Looks up an order by id or a customer by name, with lines enriched by product name and price; uncapped by default, bounded with `limit` |
| `simulate_order_placement` | Places a simulated order, validates stock, decrements inventory |
| `reset_demo_state` | Discards simulated orders and restores the seed catalog |

Beyond tools, the server exposes a **`weekly_inventory_review` prompt** that sequences the
review (alerts → restock plan → trend) with its reporting format, and a
**`tango://catalog` resource** that serves the catalog as JSON for clients that read
resources rather than call tools. The prompt's optional `category` is honoured by every step
it sequences, so a scoped run returns genuinely scoped numbers.

Every tool declares an `outputSchema` and returns typed `structuredContent`, so clients
validate responses instead of re-parsing JSON, and the shape is visible in `tools/list`
before a call. A compact JSON rendering accompanies it for clients that read the text block.
`src/schemas.ts` is the single source of truth — the analytics modules derive their return
types from it, so a response cannot drift from the implementation without a compile error.

Read tools answer "nothing matched" the same way everywhere: a successful response with
`count: 0` and an empty list. Only a malformed call (no usable filter, an unknown SKU) is a
tool error, and responses echo the filters actually applied, so a blank argument reads back
as `null` instead of as a filter that matched everything.

`find_orders` is deliberately uncapped by default. `customer_name` is a substring match, soa one-letter query matches most of the dataset — on the bundled seed data `"a"` matches 130 of the 142 orders, about 46 KB of JSON. Nothing is dropped, because truncating would remove
orders from a response that reports `count` and claims to enumerate its matches; callers
narrow the filter or pass `order_id`, or ask for a bound with `limit` — and `totalMatches`
always reports the full match count, so a capped answer admits exactly how much it withheld.

## Prerequisites

- **Node.js 22.5 or later** (`node -v`) — the floor is `node:sqlite`, the built-in database.
  On an older runtime the server refuses to start and says why (see
  [Runtime floor](#runtime-floor)).
- npm (ships with Node)

## Getting started

```bash
git clone https://github.com/CoderGamerUnknow/Project-Tango.git
cd Project-Tango
npm install
npm start          # tsx src/index.ts — no build step for local development
```

The server speaks stdio, so running it in a terminal just sits there waiting for a JSON-RPC
client. That is expected: it is designed to be launched *by* an MCP client.

```bash
npm run build      # emits dist/index.js
npm run inspect    # optional: MCP Inspector to poke at tools by hand
```

### Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Run the server from source with `tsx` |
| `npm run dev` | Same, in watch mode |
| `npm run build` | Clean `dist/` and compile with `tsc` |
| `npm run typecheck` | `tsc --noEmit` for both the build and test configs |
| `npm run lint` | Type-aware ESLint |
| `npm test` | Typecheck, then the suite (`pretest` runs the typecheck) |
| `npm run test:coverage` | The suite under coverage, with hard minimums |
| `npm run verify` | typecheck + lint + coverage + build |
| `npm run release:check <version>` | Mechanical release validation |

## Connecting to an MCP client

Both configs assume `npm run build` has run and point at the absolute path of your clone.

**Claude Desktop** — edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

Restart Claude Desktop; the tools appear in the tool picker in your next conversation. To
skip the build, point it at `npx tsx /absolute/path/to/project-tango/src/index.ts` instead.

**Cursor** — Settings → MCP → Add new MCP Server, or edit `.cursor/mcp.json` (or
`~/.cursor/mcp.json` globally) with the same block. Cursor shows a green dot once connected.

## State and persistence

`simulate_order_placement` is a write tool, so its effects have to outlive the process. State
is written to `state.db` — a SQLite database — after every mutation and restored on startup.

| Variable | Effect |
| --- | --- |
| `PROJECT_TANGO_DATA_DIR` | Directory holding the state database. Defaults to `~/.project-tango`. A fixed absolute path is used because an MCP client launches the server from an arbitrary working directory |
| `PROJECT_TANGO_PERSIST=0` | Disable persistence entirely — the original in-memory behaviour, for throwaway or CI runs |
| `PROJECT_TANGO_STORE=json` | Use the older whole-snapshot JSON file instead of SQLite. Works on a runtime without `node:sqlite`, with a narrower guarantee |

Delete `state.db` to reset to the seed dataset. Saved state is **reconciled** against the
seed rather than replacing it: products in the state file win (they carry real stock
history), while seed products missing from it are re-added, so editing the catalog still
takes effect. An existing `state.json` from an earlier version is imported automatically on
first run, validated record by record, and kept as `state.json.migrated`.

The store is deliberately forgiving, because this process is a background child of someone
else's app: saves are atomic (one transaction for the whole snapshot), an unreadable,
corrupt, wrong-shape or wrong-version store degrades to the seed dataset with a warning on
stderr, and a read-only data directory disables persistence with a warning instead of
crashing.

**Concurrency.** Order placement wraps its read-validate-write in a SQLite
`BEGIN IMMEDIATE` transaction, taking the write lock before the first read, so two server
processes sharing one data directory serialise — one cannot pass a stock check against a
snapshot the other has already moved past. The suite drives two real processes against one
directory to pin it.

**Reading.** Before each read the server compares a cheap change token
(`PRAGMA data_version`, which moves for other connections' commits and not for its own) and
reloads only when another process actually committed. A read never happens mid-transaction,
so a reload can never discard an uncommitted write. The token is a required part of the
`StateStore` contract: a backend that cannot detect another writer must say so with
`stableToken(reason)`, so "this one goes stale" is a decision someone wrote down.

**Upgrading from 3.1.0.** That release shipped two data-loss defects; if you hit either,
stored state may hold fewer products than the seed. **3.1.1 repairs this on its own** —
starting it re-adds the missing seed products and the next write saves the repaired catalog.
Nothing you placed is lost: orders recorded against the missing products resolve again once
they are back.

### Runtime floor

Most failures to persist are environmental — an unwritable directory, a full disk, a lock —
and degrade to a warning on stderr, because a warning is recoverable where a dead server is
not. A runtime with no `node:sqlite` is different: it will still be true tomorrow, and a
server that starts anyway accepts orders and discards every one at exit, on a stderr line
the MCP client throws away. So the server checks before it connects and **refuses to start**,
naming the fix. Either upgrade Node, set `PROJECT_TANGO_STORE=json` to accept a narrower
durability guarantee, or set `PROJECT_TANGO_PERSIST=0` to say you meant to run without
persistence. `engines.node` is `>=22.5.0`, but npm only warns on a mismatch — this check is
what actually holds the line.

## Going live: swapping mock data for Shopify/Stripe

Every tool is written against the `DataProvider` interface in `src/types.ts`; none touches
the mock arrays directly.

1. Implement the interface, e.g. `src/shopifyDataProvider.ts`:

```ts
export class ShopifyDataProvider implements DataProvider {
  async getProducts() { /* Shopify Admin API */ }
  async getOrders() { /* ... */ }
  async getProductBySku(sku: string) { /* ... */ }
  async updateProductInventory(id: string, newCount: number) { /* ... */ }
  async addOrder(order: Order) { /* ... */ }

  // Order placement reads stock, awaits, then writes. Without a transaction an
  // interleaved caller validates against a snapshot you have already moved past.
  async transact<T>(fn: (p: DataProvider) => Promise<T>) { /* real transaction */ }

  // Optional. Omit it and `reset_demo_state` reports that the provider does not
  // support it — do NOT stub it with a destructive no-op.
  async reset() { /* omit or throw */ }
}
```

2. Change one line in `src/index.ts`:
   `const dataProvider: DataProvider = new ShopifyDataProvider(/* credentials */);`
   The whole surface is also constructible in-process via `createServer(provider)`.
3. `npm run build` — no tool logic changes required.

## Testing

```bash
npm test              # typecheck, then the suite
npm run lint          # type-aware ESLint over source and suites
npm run test:coverage # suite under coverage, with minimum thresholds
npm run verify        # typecheck + lint + coverage + build
```

287 tests, no test framework to install — Node's built-in runner drives `tsx`. The suites are
typechecked before they run (`tsconfig.test.json` makes that possible, since the build config
must exclude `*.test.ts`). Coverage is a gate, not a report: the run fails below **98% line /
94% branch / 96% function**. The lint gate is type-aware, with one documented exception for
test payloads where `any` is the honest type of parsed JSON.

Five layers:

- **Unit** — catalog, order analytics, restock, copy, storage, state store, mock data and
  review prompt: velocity math, lookback-window resolution, threshold boundaries, order-line
  aggregation, revenue attribution, category scoping, copy generation, persistence
  atomicity/recovery, transaction rollback and read isolation.
- **End-to-end** (`tools.test.ts`) — one long-lived server over stdio with the MCP SDK's own
  client: tool registration, declared output schemas, structured responses, the prompt and
  resource surface, scoped calls, and write-path guarantees (no partial writes, unique order
  ids, inventory never negative, `transact()` honoured under concurrency).
- **Lifecycle** (`persistence.test.ts`) — restarts real server processes to prove state
  survives, seed rows reconcile, corrupt files recover, `reset_demo_state` works, and ten
  concurrent orders against 42 units accept exactly eight.
- **In-process seam** (`server.test.ts`) — builds the whole MCP surface with
  `createServer(provider)` against a stub provider over the SDK's in-memory transport.
- **Bootstrap** (`bootstrap.test.ts`) — launches `src/index.ts` as the real child process a
  user launches, covering the runtime floor end to end.
- **Docs** (`docs.test.ts`) — reads the README and changelog as text and pins their claims
  (dataset figures, structure tree, tool names, release headings and dates) to the code, the
  data and the git tags, so documentation cannot rot quietly.

Every server the tests launch is pinned to a temp data directory, so the suite never touches
your real `~/.project-tango` catalog. Several tests are explicit regressions for bugs the
server previously shipped: duplicate order lines driving inventory negative, colliding order
ids, a seed that silently broke lookback anchoring, concurrent orders overselling from -7,
saved state deleting seed products, reads handing out live references, a throwing transaction
committing half-applied state, and non-finite numbers failing output validation.

## Security

- **Local-first** — a child process on your machine speaking stdio. No network listener, no
  exposed port, no cloud component in the default configuration.
- **Zero external data exposure** — with the mock provider no data leaves your machine and
  the tool logic makes no outbound calls.
- **Explicit, validated inputs** — every parameter is checked with Zod before any logic runs.
- **No silent partial writes** — stock is validated for every line before any inventory
  mutates; the whole read-validate-write runs inside `transact()`, and a throw restores the
  pre-transaction state and skips the save.
- **Every write is reversible** — `reset_demo_state` discards simulated orders and restores
  the seed, so an exploring agent cannot permanently distort the numbers.
- **Bring your own credentials** — live providers should read them from the environment. This
  template ships with no secrets and no network calls.

## Project structure

```
project-tango/
├── src/
│   ├── types.ts          Domain types + DataProvider interface
│   ├── schemas.ts        Zod response schemas — source of truth for shapes
│   ├── conventions.ts    Rules shared by several analytics modules
│   ├── catalog.ts        Filtering, low-stock alerts, search ranking
│   ├── productIndex.ts   Prefix index that ranks search results (from v2.0.0)
│   ├── sqliteStore.ts    Durable store with cross-process write transactions
│   ├── orderAnalytics.ts Windowing, metrics, trend, order drill-down, buildOrder
│   ├── restock.ts        Restocking policy + demand-velocity planning
│   ├── productCopy.ts    Marketing copy and its per-tag voice tables
│   ├── toolNames.ts      The eight tool names, declared once
│   ├── responses.ts      jsonResult / errorResult wire envelopes
│   ├── reviewPrompt.ts   The weekly review prompt as a pure function
│   ├── server.ts         MCP surface: createServer(provider) — 8 tools, 1 prompt, 1 resource
│   ├── mockData.ts       MockDataProvider (read this to implement DataProvider)
│   ├── seedCatalog.ts    The 13-product starter catalog
│   ├── orderGenerator.ts Deterministic seeded order history
│   ├── storage.ts        Store selection, atomic JSON store, recovery
│   ├── index.ts          Bootstrap: picks the provider, connects stdio
│   ├── testHelpers.ts    Shared fixtures + stdio launcher for the suites
│   ├── testGlobalSetup.ts Pins every test process to a throwaway data directory
│   └── *.test.ts         Unit, e2e, lifecycle, seam, bootstrap and docs suites
├── scripts/release-check.mjs
├── .github/workflows/     CI + release artifact
├── CHANGELOG.md
├── tsconfig.json / tsconfig.test.json
└── eslint.config.mjs
```

The split between analytics and MCP wiring is deliberate: every tool's logic is a pure
function over plain data, so it is unit-testable without spawning a server, and handlers stay
readable as validate → fetch → compute → wrap. `server.ts` owns registration only and takes
the provider as an argument; `index.ts` is the thin bootstrap. The analytics layer is split
by concern — catalog, orders, restock, copy — with `conventions.ts` holding only the rules
more than one of them follows.

## Releasing

Order matters, because two steps are checked against each other and getting them backwards
fails *after* the release is public.

1. **Prepare.** Bump `package.json`, `package-lock.json` (`npm install --package-lock-only`)
   and `SERVER_VERSION` in `src/server.ts`. Write the `## [X.Y.Z] — YYYY-MM-DD` changelog
   section and its link definition. `docs.test.ts` refuses a release whose heading has no tag
   or whose tag date is not the heading's date.
2. **Verify locally** — `npm run verify`.
3. **Commit, then tag the commit** (`git tag -a vX.Y.Z -m "Project Tango vX.Y.Z"`).
4. **Push the tag _before_ the branch** — a tag run checks out a detached HEAD and reads
   `main`'s tag history, so an unlanded branch fails `docs.test.ts` on `malformed object name
   main`.
5. **Wait for the tag run to go green** before publishing. CI runs
   `scripts/release-check.mjs` on tag pushes.
6. **Publish** with notes generated from the changelog section, and let
   `release-artifact.yml` attach the tarball — it is built, installed and booted on the runner
   before upload.
7. **Confirm** the tarball is attached. CI also runs on Windows; both legs must be green.

## License

[MIT](LICENSE) © 2026 CoderGamerUnknow
