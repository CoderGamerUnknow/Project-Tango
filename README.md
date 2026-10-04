# Project Tango

A **local-first** [Model Context Protocol](https://modelcontextprotocol.io) server that gives LLM agents — Claude Desktop, Cursor, VS Code, or any MCP-compatible client — instant, structured access to e-commerce data: products, inventory, orders, and sales analytics.

Project Tango ships with a realistic mock dataset so it works in under a minute with **zero configuration**, and it's built around a clean `DataProvider` interface so you can swap the mock engine for live Shopify/Stripe APIs without touching a single tool definition.

- **Runs entirely on your machine** over stdio — no server to deploy, no database to host.
- **$0 infrastructure cost.**
- **State survives a restart** — writes land in a local SQLite database, not in memory that evaporates when the MCP client relaunches the process.
- **Production-ready TypeScript**, strict mode, fully typed domain model.

Release history, including a divergent `v2.0.0` lineage that was never merged
into `main` (its trie search is ported here; see
[CHANGELOG.md](CHANGELOG.md)).

---

## What's inside

| Tool | What it does |
|---|---|
| `list_all_products` | Browse the catalog, filtered by category, price range, or free-text search — results ranked so a product whose own name, SKU, category or tag matches ranks above one that merely mentions the term |
| `get_low_stock_alerts` | Scans inventory and flags `low` / `critical` stock levels, optionally for one category |
| `analyze_sales_metrics` | Gross revenue, AOV, top sellers, order-status breakdown, and a daily trend with a recent-vs-previous comparison — all optionally scoped to one category |
| `smart_restock_predictor` | Ranks low-stock items by days of cover and recommends an exact reorder quantity for each, optionally within one category |
| `draft_product_copy` | Generates marketing copy + SEO tags for a given SKU |
| `find_orders` | Looks up an order by id or a customer by name, with lines enriched by product name and price; uncapped by default, bounded with an optional `limit` |
| `simulate_order_placement` | Places a simulated order, validates stock, decrements inventory |
| `reset_demo_state` | Discards simulated orders and restores the seed catalog |

Beyond tools, the server exposes a `weekly_inventory_review` prompt that
sequences the review (alerts → restock plan → trend) with its reporting format,
and a `tango://catalog` resource that serves the product catalog as JSON for
clients that read resources rather than call tools. The prompt takes an optional
`category`, and the scoping is real: every step the prompt sequences accepts the
category itself, so a scoped run genuinely returns category-scoped numbers
rather than catalog-wide ones wearing a category heading.

Read tools answer "nothing matched" the same way everywhere — a successful
response with `count: 0` and an empty list. Only a malformed call (no usable
filter at all, an unknown SKU) is a tool error. Responses echo the filters
actually applied, so a blank argument reads back as `null` instead of as a
filter that matched everything or nothing.

`find_orders` is deliberately uncapped by default and has no pagination.
`customer_name` is a substring match, so a one-letter query matches most of the
dataset — on the bundled seed data, `"a"` matches 130 of the 142 orders, about 46 KB of JSON.
Against a live provider those figures differ; what does not change is that
nothing is dropped. Truncating would remove orders from a response that reports
`count` and claims to enumerate its matches, so the default narrows nothing and
callers narrow the filter instead (or pass an `order_id` for a single order).
Callers who want a bound ask for one with `limit` — and `totalMatches` always
reports the full match count, so a capped answer admits exactly how much it
withheld. A test pins the invariant — `count` equals the number of orders
actually delivered, and `totalMatches` is never smaller than it — rather than
any particular result size, so it holds at any dataset size.

Every tool declares an `outputSchema` and returns typed `structuredContent`, so
clients validate the response instead of re-parsing JSON — and the shape is
visible in `tools/list` before a call is made. A compact JSON rendering is
returned alongside for clients and models that read the text block. The schemas
in `src/schemas.ts` are the single source of truth: the analytics modules derive
their return types from them, so a response shape cannot drift from the
implementation without a compile error.

---

## Prerequisites

- **Node.js 18 or later** (`node -v` to check)
- npm (ships with Node)

---

## Quickstart

```bash
# 1. Clone the repository
git clone https://github.com/CoderGamerUnknow/Project-Tango.git
cd Project-Tango

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

## Testing

```bash
npm test              # typecheck, then the suite
npm run lint          # type-aware ESLint over source and suites
npm run test:coverage # the suite under coverage, with minimum thresholds
npm run verify        # typecheck + lint + coverage + build, in one shot
```

271 tests, no test framework to install — Node's built-in test runner drives
`tsx`. The
suites are typechecked before they run (`pretest` → `npm run typecheck`), which
covers them as well as the source; previously only the source was checked, so a
broken test reached the runner and failed as a runtime error instead of a
compile error. `tsconfig.test.json` is what makes that possible — the build
config has to exclude `*.test.ts` so they never reach `dist/`.

Coverage is a gate, not a report: `npm run test:coverage` fails the run below
**98% line / 94% branch / 96% function** coverage, so a new branch without a
test breaks the build instead of hiding. The lint gate is type-aware
(`typescript-eslint` with type information — floating promises, unsafe `any`
propagation) with one documented exception for test payloads, where `any` is
the honest type of parsed JSON. GitHub Actions
(`.github/workflows/ci.yml`) runs typecheck, lint, the coverage-floored suite,
a check that this very test count matches the runner, and the build on every
push.

The suite runs in five layers:

- **Unit** (`src/catalog.test.ts`, `src/orderAnalytics.test.ts`,
  `src/restock.test.ts`, `src/productCopy.test.ts`, `src/storage.test.ts`,
  `src/sqliteStore.test.ts`, `src/mockData.test.ts`, `src/reviewPrompt.test.ts`)
  pins the business logic, the state store, the search index, the provider, and
  the rendered review prompt directly:
  velocity
  math, lookback-window resolution, threshold boundaries, order-line
  aggregation, revenue attribution, order drill-down, category scoping, sales
  trend, copy generation, persistence atomicity/recovery, transaction rollback,
  and read isolation (`MockDataProvider` hands out copies, never live
  references). `src/sqliteStore.test.ts` additionally opens real databases: it
  proves the store waits out another process's lock instead of falling back, that
  a rolled-back transaction leaves the store usable, and that search ranking
  never drops a substring match. Each unit suite pairs with the module it
  covers, so the split is visible in the tests too.
- **End-to-end** (`src/tools.test.ts`) drives a single long-lived server over
  stdio with the MCP SDK's own client, covering tool registration, declared
  output schemas, structured responses, the prompt and resource surface, scoped
  calls on every tool, and the write-path guarantees (no partial writes, unique
  order ids, inventory never negative, `transact()` honoured under concurrency).
- **Lifecycle** (`src/persistence.test.ts`) restarts real server processes to
  prove state survives, seed rows reconcile correctly, corrupt files recover,
  and `reset_demo_state` works — including that a rejected order does not poison
  the transaction queue for later callers, that two server processes racing on
  one data directory both keep their writes, and that ten concurrent orders
  against 42 units of stock accept exactly eight.
- **In-process seam** (`src/server.test.ts`) builds the entire MCP surface with
  `createServer(provider)` against a stub `DataProvider` over the SDK's
  in-memory transport — the proof that swapping providers needs no process and
  no module rewiring.
- **Docs** (`src/docs.test.ts`) reads the README and changelog as text and pins
  their claims — dataset figures, structure tree, tool names, release headings,
  release dates, and the divergent `v2.0.0` lineage — to the code, the data and
  the git tags they describe, so documentation cannot rot quietly.

Every server the tests launch is pinned to a temp data directory, so running the
suite never touches your real `~/.project-tango` catalog.

Several tests are explicit regressions for bugs this server previously shipped —
duplicate order lines driving inventory negative, colliding order ids, a
`Math.max(NaN, …)` seed that silently broke lookback anchoring, concurrent
orders overselling stock from -7, saved state silently deleting seed products,
unchecked restored records crashing the catalog, reads handing out live
references whose mutation bypassed the persistence counter, a throwing
transaction committing the half-applied state it was supposed to discard, a
sales lookback window that measured 31 days of demand and divided by 30, and
non-finite numbers in a restored state file failing every analytics tool's output
validation.

---

## State and persistence

`simulate_order_placement` is a write tool, so its effects have to outlive the
process — MCP clients relaunch the server routinely, and an agent that places an
order in one session then asks about inventory in the next would otherwise be
told about a catalog state that no longer exists.

State is written to `state.db` — a SQLite database — after every mutation and
restored on startup.

| Variable | Effect |
|---|---|
| `PROJECT_TANGO_DATA_DIR` | Directory holding the state database. Defaults to `~/.project-tango`. A fixed absolute path is used because an MCP client launches the server from an arbitrary working directory. |
| `PROJECT_TANGO_PERSIST=0` | Disable persistence entirely — the original in-memory behaviour, for throwaway or CI runs. |
| `PROJECT_TANGO_STORE=json` | Use the older whole-snapshot JSON file instead of SQLite. Useful on a runtime without `node:sqlite` (Node < 22.5), but see the concurrency note below. |

Delete `state.db` to reset back to the seed dataset. Saved state is reconciled
against the seed catalog rather than replacing it: products present in the state
file win (they carry the real stock history), while seed products missing from
it are re-added, so editing the catalog still takes effect. The server logs what
it restored on startup.

An existing `state.json` from an earlier version is imported automatically on
first run — validated record by record, exactly as the JSON store did, so a
malformed record is dropped rather than becoming a runtime failure — and the old
file is kept as `state.json.migrated`.

**Upgrading from 3.1.0.** That release shipped two data-loss defects, and if you
hit either of them your stored state may hold fewer products than the seed
catalog: the server would list all thirteen and then refuse to sell one of them,
committing the shortfall so it survived every restart. **3.1.1 repairs this on
its own** — starting it re-adds the missing seed products, and the first write
that follows saves the repaired catalog back, so there is no manual step.
Install 3.1.1 and restart. Nothing you placed is lost: orders recorded against
the missing products are still in the database and resolve again once the
products are back. See the
[3.1.0 release notes](https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.1.0).

The store is deliberately forgiving, because this process is a background child of
someone else's app: saves are atomic (one transaction for the whole snapshot), an
unreadable, corrupt, wrong-shape or wrong-version store degrades to the seed
dataset with a warning on stderr rather than taking the tools down, and a
read-only data directory disables persistence with a warning instead of crashing.

**Concurrency.** Order placement wraps its read-validate-write in a SQLite
`BEGIN IMMEDIATE` transaction, which takes the database's write lock before the
first read. Two server processes sharing one data directory therefore serialise:
each validates against the state as of the moment it acquired the lock, so one
cannot pass a stock check against a snapshot the other has already moved past.
The suite drives two real server processes against one directory to pin this —
both orders survive, stock reflects both, and ten racing attempts at 5 units
against a stock of 42 fill exactly eight orders rather than driving inventory
negative. The lock is released on commit, rollback, or process death.

**Reading.** A server keeps its catalog in memory, and an MCP client keeps a
server alive for a whole conversation — so a second window could write while this
one reads. Before each read the server compares a cheap change token
(`PRAGMA data_version`, which moves for other connections' commits and not for
its own) and reloads only when another process has actually committed. Staying
current therefore costs one query per read rather than a full reload, and a
server that never wrote anything still sees what everyone else did. A read never
happens mid-transaction, so a reload can never discard a write that has not
committed yet.

The token is a required part of the `StateStore` contract, not an optional extra.
A backend that genuinely cannot detect another writer has to say so with
`stableToken(reason)` rather than omit the member, so "this one goes stale" is a
decision someone wrote down instead of a gap nobody noticed. The suite holds two
real server processes against one data directory through a soak — 40 commits
spread over four products while the reader serves hundreds of interleaved
`list_all_products` calls — and asserts the properties that matter under load
rather than on a single sample: no read ever trails a committed write by more
than one commit, the reader becomes current within three reads of the writer going
quiet, it follows the stream rather than jumping once at the end, and it never
serves a catalog mid-write or reports stock moving backwards. The check itself is
pinned by a performance guard: it must stay at least 20x cheaper than the reload
it avoids (measured ~72x on the shipped dataset).

`PROJECT_TANGO_STORE=json` keeps the previous whole-snapshot backend available,
and its guarantee is deliberately narrower: it publishes one process's complete
snapshot (never a torn file) but is still last-writer-wins across processes,
because `load()`/`save()` cannot be made atomic between two independent copies.

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

Every tool in `src/server.ts` is written against the `DataProvider` interface defined in `src/types.ts` — it never touches the mock arrays directly. To connect real data:

1. Create `src/shopifyDataProvider.ts` (or similar) implementing `DataProvider`:
   ```ts
   export class ShopifyDataProvider implements DataProvider {
     async getProducts() { /* call Shopify Admin API */ }
     async getOrders() { /* call Shopify Admin API */ }
     async getProductBySku(sku: string) { /* ... */ }
     async updateProductInventory(id: string, newCount: number) { /* ... */ }
     async addOrder(order: Order) { /* ... */ }

     // Order placement reads stock, awaits, then writes. Without a transaction
     // an interleaved caller validates against a snapshot you have already moved
     // past, and oversells. Map this onto whatever your store offers.
     async transact<T>(fn: (p: DataProvider) => Promise<T>) { /* real transaction */ }

     // Optional. Omit it and `reset_demo_state` simply reports that the
     // provider does not support it — do NOT stub it with a destructive
     // no-op, or an agent will "reset" your live inventory.
     async reset() { /* throw or omit the method entirely */ }
   }
   ```
2. In `src/index.ts`, change one line:
   ```ts
   const dataProvider: DataProvider = new ShopifyDataProvider(/* credentials */);
   ```
   The whole surface is also constructible in-process as
   `createServer(provider)` (`src/server.ts`) — which is how the test suite
   exercises the seam against stub data without spawning anything.
3. Rebuild (`npm run build`) — no tool logic changes required.

---

## Security

- **Local-first by design.** Project Tango runs as a child process on your own machine and speaks to its MCP client exclusively over stdio. There is no network listener, no exposed port, and no cloud component in the default configuration.
- **Zero external data exposure.** With the default mock `DataProvider`, no data ever leaves your machine — there are no outbound network calls anywhere in the tool logic.
- **Explicit, validated inputs.** Every tool parameter is validated at runtime with Zod schemas before any logic executes, rejecting malformed or out-of-range input before it reaches your data layer.
- **No silent partial writes.** `simulate_order_placement` validates stock for every line item *before* mutating any inventory — a failing item rejects the whole order rather than leaving data half-updated. The whole read-validate-write runs inside `DataProvider.transact()`, so concurrent calls cannot all pass a stock check against the same pre-write snapshot, and atomicity is a property of the data layer rather than of this server's wiring. If a provider method throws halfway through, `transact()` restores the pre-transaction state and skips the save, so neither memory nor the state file is left holding a half-applied order.
- **Every write is reversible.** `simulate_order_placement` is irreversible within a session, so an agent exploring the catalog could otherwise permanently distort the numbers it reports back. `reset_demo_state` discards simulated orders and restores the seed dataset.
- **Bring your own credentials for live mode.** When you implement a real `DataProvider` against Shopify/Stripe, credentials should be loaded from environment variables (e.g. via `process.env`) and never hard-coded — this template intentionally ships with no secrets or network calls of any kind.

---

## Project structure

```
project-tango/
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── eslint.config.mjs    # Type-aware lint gate (npm run lint)
├── .github/workflows/ci.yml # CI: typecheck, lint, coverage floor, build, docs drift
├── .github/workflows/release-artifact.yml # Packs, installs and smoke-tests the tarball, then attaches it to the release
├── src/
│   ├── types.ts        # Domain types + DataProvider interface
│   ├── schemas.ts      # Zod response schemas — the source of truth for shapes
│   ├── conventions.ts  # Rules shared by several analytics modules (rounding, blank input)
│   ├── catalog.ts      # Product filtering + low-stock alerts + search ranking
│   ├── productIndex.ts # Prefix index that ranks search results (ported from the v2.0.0 lineage)
│   ├── sqliteStore.ts  # SQLite durable store with cross-process write transactions
│   ├── orderAnalytics.ts # Windowing, sales metrics, trend, order drill-down + buildOrder (order + stock writes)
│   ├── restock.ts      # Restocking policy + demand-velocity planning
│   ├── productCopy.ts  # Marketing copy + its per-tag voice tables
│   ├── toolNames.ts    # The eight tool names, declared once
│   ├── responses.ts    # jsonResult / errorResult wire envelopes
│   ├── reviewPrompt.ts # The weekly review prompt as a pure function
│   ├── server.ts       # MCP surface: createServer(provider) — 8 tools, 1 prompt, 1 resource
│   ├── mockData.ts     # MockDataProvider (read this to implement DataProvider)
│   ├── seedCatalog.ts  # The 13-product starter catalog
│   ├── orderGenerator.ts # Deterministic seeded order history
│   ├── storage.ts      # Durable state: store selection, atomic JSON store, recovery
│   ├── index.ts        # Process bootstrap: picks the provider, connects stdio
│   ├── testHelpers.ts  # Shared fixtures + stdio launcher for the suites
│   ├── testGlobalSetup.ts # Pins every test process to a throwaway data directory
│   └── *.test.ts      # Unit, e2e, lifecycle, in-process seam and docs suites
├── CHANGELOG.md      # Release history, pinned to the tags by src/docs.test.ts
└── README.md
```

The split between the analytics modules and the MCP wiring is deliberate: every
tool's logic is a pure function over plain data, so it can be unit tested
without spawning a server, and the handlers stay readable as validate → fetch →
compute → wrap. `server.ts` owns registration only — it takes the `DataProvider`
as an argument (`createServer(provider)`), so the whole surface can be built
in-process against stub data, while `index.ts` is the thin bootstrap that picks
the real provider and connects stdio. The analytics layer is itself split by
concern — catalog, orders, restock, copy — because a single 750-line file
covering all four is none of them; `conventions.ts` holds only the rules more
than one of them follows, so a shared rule has exactly one owner instead of one
copy per module.

## License

MIT
