# Changelog

All notable changes to Project Tango, newest first. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); this project ships
only published releases, so `minor`/`patch` numbers here mean published tags.

> **Note on the `v2.0.0` tag.** The `v2.0.0` tag in this repository is **not an
> ancestor of `main`**. It sits on a divergent lineage that branched from
> `v1.0.0` and was never merged, and it is still unmerged. Its trie search and
> its SQLite store have since been *ported* onto `main` — as a ranking layer and
> as the durable store, respectively — so the feature list below is a record of
> what `v2.0.0` holds, not of what `main` lacks.

## [3.1.2] — 2026-10-04

Tightens the seam that 3.1.1 left loose, and proves it holds under load.
**One breaking change**, to the `StateStore` interface rather than to anything an
MCP client can see: no tool name, parameter or response field changed, and
upgrading is a normal reinstall.

### Changed

- **`StateStore.changeToken` is now required — breaking for backend authors.**
  3.1.1 fixed a server that kept serving a catalog another process had
  replaced, and made the fix reachable by *omitting* an optional member: a
  backend added later could leave `changeToken` off the interface and silently
  reinstate the exact defect, with nothing to notice it. Every backend this
  project can return already provided one, so no shipped behaviour changes. A
  backend that genuinely cannot detect another writer must now say so with
  `stableToken(reason)` — the limitation becomes a decision someone wrote down
  rather than a gap nobody noticed. The requirement is only that a rival's
  commit is *detectable*: a token that also moves on the provider's own writes is
  merely less efficient, which is what the JSON backend's `size:mtime` token does.
  Correctness never depends on which kind a backend provides.

### Added

- **Freshness verified under load.** Two real server processes, one data
  directory, forty commits spread across four products while the reader serves
  hundreds of interleaved `list_all_products` calls. The assertions are the ones
  that only fail once the two have had time to drift apart: no read trails a
  committed write by more than one commit, the reader is current within three
  reads of the writer going quiet, it follows the stream rather than jumping once
  at the end, and it never serves a catalog mid-write or reports stock moving
  backwards. Both ways of breaking it were confirmed to fail the suite — pinning
  the token, and refreshing only one read in sixty.
- **A performance guard on the token check.** The reload the token exists to
  avoid is the expensive path; if the check ever got slower than the reload it
  would be pure overhead. A guard holds `changeToken` at least 20x cheaper than a
  full load on the shipped dataset (measured ~72x).

### Fixed

- **The 3.1.0 release record was wrong in a way that mattered.** Its body had
  stray blank lines from the original extraction, and — more importantly — it
  described two data-loss defects without telling anyone who installed it that
  they were carrying them. Both it and 3.1.1's now lead with the upgrade path: if
  your stored state holds fewer products than the seed catalog, 3.1.1 repairs it
  on its own, with no manual step and nothing you placed lost.

## [3.1.1] — 2026-10-04

Bug fixes and release tooling. No tool names, parameters or response fields
changed. Two data-loss defects and one write failure, all found while trying to
make a server notice that another process had written, plus the workflow that
gives every release a verified artifact.

### Fixed

- **A server listed thirteen products and then refused to sell one of them.**
  Saved state can legitimately hold fewer products than the seed catalog — a
  `state.json` written before a product was added, or one whose rows were pruned
  — and the startup reconcile put the missing ones back in memory. A transaction
  then re-read the store under its write lock and adopted that smaller row set
  *verbatim*, so the catalog collapsed to whatever the file happened to contain,
  and `simulate_order_placement` answered `no product found with id "prod_001"`
  for a product `list_all_products` had just returned. The commit that followed
  persisted the loss, so the erosion survived every restart. Reconciliation now
  happens wherever stored state is adopted, and because a commit writes what is
  in memory, the stored catalog is repaired rather than eroded.
- **A running server kept serving a catalog another process had replaced.**
  Reads came from the process's own copy, which only caught up when that process
  wrote something itself — so an agent could place an order in one window and be
  told stale inventory in the next. Reads now compare a cheap change token first
  (`PRAGMA data_version`, `stat` on the JSON backend) and reload only when
  another process committed. The check is skipped during a transaction, where a
  reload would discard state that has not committed yet.
- **A rejected save reported itself as a successful one.** `save()` swallowed
  every write failure and logged it, which is right for the environment (a
  read-only disk, a closed handle) and wrong for the data: `SQLITE_CONSTRAINT`
  means the rows are not storable, which is a defect in what was built rather
  than where it is stored. That combination is how a caller comes to believe an
  order was placed when the transaction behind it was rolled back — the exact
  "silent partial write" this project promises cannot happen. Constraint failures
  are now rethrown; environmental ones still degrade with a warning.

### Changed

- **`StateStore.changeToken` is required.** It was optional, which meant a
  backend could omit it and silently keep serving a catalog another process had
  replaced — the exact defect this release exists to fix, reachable again by the
  next backend added. A backend that cannot detect another writer now returns
  `stableToken(reason)`, so the limitation is written down where a reader of
  the code will trip over it. Every store `resolveStateStore` can return is
  asserted to provide one.

### Added

- **Freshness is verified under load, not just on a single sample.** Two real
  server processes, one data directory, forty commits spread across four products
  while the reader serves hundreds of interleaved reads. The assertions are the
  ones that only fail after the two have been running long enough to drift: no
  read trails a committed write by more than one commit, the reader is current
  within three reads of the writer going quiet, it follows the stream instead of
  jumping once at the end, and it never serves a catalog mid-write or reports
  stock moving backwards. Both ways of breaking it were confirmed to fail the
  suite — pinning the token, and refreshing only one read in sixty.
- **Releases carry a verified installable tarball.** A new workflow builds it,
  installs it into a clean directory, drives the binary that install ships, and
  only then attaches it to the release — on `release: published`, so it happens
  without being asked. Two things this fixes: `v3.1.0` shipped source only, and
  an artifact attached from a contributor's machine turned out to be corrupt
  there (GitHub's asset endpoint stored the multipart envelope along with the
  file on every framing tried, so a "successful" upload produced an unusable
  download). Attaching from a runner also means the published file is the one
  that was executed, not one built alongside the release and never run.
- **`StateStore.changeToken`** — a cheap token that moves when another process
  committed, so a read can decide whether it needs to reload without loading
  anything to find out. Added here, and required rather than optional — see
  *Changed* above for why omission is not an option.
- **Order ids carry their process id.** `nextOrderId` proved unique only within
  one process: its sequence is module state, so two servers sharing a data
  directory minted the *same* id for orders placed in the same millisecond. With
  `orders.id` a primary key, the stored list then held that id twice and the
  second write was rejected outright — one server's order could not be placed at
  all. The pid closes the gap with no randomness: two live processes cannot share
  one, and a recycled pid only collides with an id from a different millisecond.

## [3.1.0] — 2026-10-04

State is now durable across processes, and the `v2.0.0` lineage's two useful
ideas are in `main`. Tool names, parameters and response fields are unchanged
from 3.0.1, except that `list_all_products` now returns its matches ranked.

### Added

- **A SQLite durable store** (`src/sqliteStore.ts`). State moved from a
  `state.json` snapshot to `state.db`, using Node's built-in `node:sqlite` — no
  new dependency, nothing to install, nothing to host. An existing `state.json`
  is imported on first run, validated record by record with exactly the rules
  the JSON store used, and kept as `state.json.migrated`.
- **Cross-process write transactions.** `StateStore` gained an optional `update`,
  and the SQLite store implements it as `BEGIN IMMEDIATE` — the write lock is
  taken *before* the state is read, so a second server validates against what
  the first one committed rather than against a snapshot it has already moved
  past. `MockDataProvider.transact()` uses it, so order placement's whole
  read-validate-write is exclusive. This is the change that makes concurrent
  writes safe: ten server attempts at 5 units against a stock of 42 fill
  exactly eight orders and refuse the other two with a reason, where before the
  last writer's snapshot simply overwrote the others.
- **Search ranking** (`src/productIndex.ts`), ported from the `v2.0.0` lineage's
  `src/trie.ts` — but as a *ranking layer*, not the filter it was there. See
  [the note below](#why-the-v200-trie-was-ported-as-ranking).
- **`PROJECT_TANGO_STORE=json`** to force the previous whole-snapshot backend,
  for a runtime without `node:sqlite` (Node < 22.5). It keeps publishing one
  process's complete snapshot and is still last-writer-wins across processes;
  the README says so where it documents that flag.

### Fixed

- **Two servers starting together could split one catalog across two files.**
  `PRAGMA journal_mode = WAL` returns `SQLITE_BUSY` *immediately*, ignoring
  `busy_timeout`, so opening the store raced: the loser gave up, fell back to
  the JSON backend, and two processes then wrote `state.db` and `state.json` as
  separate catalogs that each believed they owned the stock. The store now
  retries the open with backoff and waits out a lock another process holds
  instead of routing around it.
- **Falling back to a different on-disk store is worse than losing durability.**
  Two files disagreeing about inventory is not recoverable; losing state across
  a restart is. A store that cannot be opened now degrades to memory with a
  warning on stderr, never to a second file.
- **A test run could create the real `~/.project-tango` catalog.** The store is
  resolved — and therefore created — when `mockData.ts` is imported, and
  `src/storage.test.ts` asked for the default directory to check its
  description. The runner now pins a throwaway data directory for every test
  process (`src/testGlobalSetup.ts`), and a suite-hygiene test fails if that
  wiring is ever dropped.

### Known limitation

Reads are served from a running process's own in-memory catalog, so a
long-lived server can trail another process's last commit until it writes
something itself. Writes never read a stale snapshot — they re-read under the
transaction lock — and a freshly started process is always current. Two servers
driven from one client are the case this shows up in; the lifecycle suite reads
the final state through a new process for exactly that reason.

> **Fixed in [3.1.1](#311--2026-10-04).** Reads now refresh against
> `PRAGMA data_version`, and the catalog a partial state file erodes is repaired
> rather than committed.

## Why the `v2.0.0` trie was ported as ranking

`v2.0.0` replaced substring search with prefix-only matching and called it an
improvement. Measured against this catalog, it is not: `"tch"` matches **7**
products by substring and **5** by token prefix, and `"a"` matches 13 against 6.
Substring matching reaches inside `tech` and `stitch`; a prefix only matches from
the start of a token. Shipping it as written would have cut recall while
looking like a speed-up.

So the index here ranks instead of filtering. `filterProducts` still decides the
candidate set, and the trie only orders it — a product whose own token is the
query outranks one that merely contains it, on three tiers (the query is a whole
name/SKU/category/tag, is one word of one, or starts one). The tier is what
separates `Cable` from `Cable Management Tray`: both carry a `cable` token, and
a token-level comparison alone lets the longer name win on accumulated prefix
matches.

## [3.0.1] — 2026-10-04

Bug fixes only. No tool names, parameters or response fields changed.

### Fixed

- **The sales-lookback window measured one day more than it reported.** The
  window subtracted the full `salesLookbackDays` from its anchor date while the
  window filter includes both bounds, so a 30-day lookback covered **31** days of
  demand and still divided by 30. Every velocity ran ~3% high, `daysOfCover` ran
  low, and `recommendedReorderQuantity` came out too large. The window now spans
  exactly `salesLookbackDays` calendar days counting the anchor day.
- **Non-finite numbers in a restored state file broke every analytics tool.**
  Restored records were validated with `typeof x === "number"`, which accepts
  `Infinity` — the value `JSON.parse("1e999")` produces — and fractional
  quantities. Those passed validation, reached the catalog, and then failed the
  tools' own declared output schemas
  (`Output validation error: expected number, received Infinity`), turning one
  bad field in one record into a hard failure across `analyze_sales_metrics`,
  `smart_restock_predictor` and `find_orders`. Validation now requires finite
  numbers, and integers where the schemas declare them.

## [3.0.0] — 2026-10-04

Restructure and quality gates. This is the release `main` was built on.

### Added

- **Category scoping on every analytics tool.** `get_low_stock_alerts`,
  `analyze_sales_metrics` and `smart_restock_predictor` each accept a `category`
  and echo the category actually applied in a `filters` block. Scoped sales
  figures count only lines in that category, and an order counts toward the
  status breakdown and AOV when it contains at least one such line.
- **`limit` and `totalMatches` on `find_orders`.** A caller that wants a bound
  can now ask for one; `totalMatches` always reports the full match count, so a
  capped answer cannot be mistaken for a complete one. The default stays
  uncapped.
- **An injectable provider seam.** `createServer(provider)` takes a required
  `DataProvider`, so the whole MCP surface can be built in-process against any
  implementation — proven in tests over the SDK's in-memory transport, with no
  process spawn.
- **Type-aware ESLint** with zero rule suppressions.
- **A coverage gate.** `npm run test:coverage` fails below 98% lines / 94%
  branches / 96% functions, using Node's built-in reporter (no new dependency).
- **GitHub Actions CI** running typecheck → lint → coverage floor → README
  test-count drift check → build.

### Changed

- **Module layout.** The single `analytics.ts` grab-bag became `catalog.ts`,
  `orderAnalytics.ts`, `restock.ts`, `productCopy.ts` and `conventions.ts`, each
  owning one concern, with shared rules (`round1`/`round2`/`trimmed`) having
  exactly one owner rather than a copy per module. `src/index.ts` is now a
  process bootstrap only; registration lives in `server.ts`, and the prompt
  renderer, response envelopes and tool-name constant are separate modules.
- **The review prompt scopes every step.** A `category` argument previously
  narrowed only the catalog listing while three analytics steps ran catalog-wide,
  papered over by a disclaimer telling the reader to relabel the figures. The
  gap is closed instead of described.
- **Policy prose is interpolated.** The low-stock tool description states the
  critical threshold from the policy value rather than a literal that could drift
  from it.

### Fixed

Response-honesty defects: blank filters echoed as applied, mismatched
`find_orders` filters short-circuiting instead of combining with AND, prompt
steps not rendering their per-tool arguments, and a failed second order line
needing an explicit no-partial-write guarantee.

## [1.0.0] — 2026-07-09

The first published tag: a flat layout (`index.ts`, `mockData.ts`, `types.ts` at
the repository root) with six tools over the `DataProvider` interface, running on
a generated mock dataset over stdio.

## Divergent lineage

The `v2.0.0` tag (commit `a37a9c7`) branched from `v1.0.0` and **was never merged
into `main`**. It is a parallel implementation, not a step toward 3.x.

It contains work `main` does not have:

- **SQLite persistence** (`.tango/store.db`) with a WAL, via `src/database.ts` —
  *ported in 3.1.0, with different behaviour*: the port adds the cross-process
  write transaction that `v2.0.0` did not have, and reads the store through
  `BEGIN IMMEDIATE`.
- **Prefix-trie product search** (`src/trie.ts`) exposed as a `search_products`
  tool — *ported in 3.1.0 as a ranking layer*, keeping `list_all_products`'s
  substring recall rather than replacing it with prefix-only matching. The
  separate `search_products` tool was not ported.
- **A reactive event broker and saga rollback** (`src/engine.ts`) — still absent
  from `main`; `MockDataProvider.transact()` covers the rollback, but nothing
  publishes events.
- A 422-line integration suite (`test/integration.test.ts`) and a `.prettierrc`
  — with no ESLint, coverage gate or CI

The tag is still off `main`'s lineage and this section is a record, not a merge
plan: the two implementations share only `types.ts` and the tool names they have
in common, so anything carried over was rewritten rather than merged. `main`
also has seven features `v2.0.0` lacks: `find_orders`, `reset_demo_state`, the
category scoping on three tools, the sales trend series, durable restart-safe
persistence, the injectable `createServer` seam, and the lint/coverage/CI gates.

[3.1.2]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.1.2
[3.1.1]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.1.1
[3.1.0]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.1.0
[3.0.1]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.0.1
[3.0.0]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.0.0
[1.0.0]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v1.0.0