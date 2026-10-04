# Changelog

All notable changes to Project Tango, newest first. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); this project ships
only published releases, so `minor`/`patch` numbers here mean published tags.

> **Note on the `v2.0.0` tag.** The `v2.0.0` tag in this repository is **not an
> ancestor of `main`**. It sits on a divergent lineage that branched from
> `v1.0.0` and was never merged. See [Divergent lineage](#divergent-lineage)
> below — it contains features `main` does not have.

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

- **SQLite persistence** (`.tango/store.db`) with a WAL, via `src/database.ts`
- **Prefix-trie product search** (`src/trie.ts`) exposed as a `search_products`
  tool — `main` instead has a substring search on `list_all_products`
- **A reactive event broker and saga rollback** (`src/engine.ts`)
- A 422-line integration suite (`test/integration.test.ts`) and a `.prettierrc`
  — with no ESLint, coverage gate or CI

`main` does **not** contain any of this. Conversely `main` has seven features
`v2.0.0` lacks: `find_orders`, `reset_demo_state`, the category scoping on three
tools, the sales trend series, durable restart-safe persistence, the injectable
`createServer` seam, and the lint/coverage/CI gates. Neither lineage descends from
the other past `v1.0.0`, so neither is a strict successor.

If you want `v2.0.0`'s trie search or SQLite store in the current code, that is
porting work, not a merge — the two implementations share only `types.ts` and the
tool names they have in common.

[3.0.1]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.0.1
[3.0.0]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v3.0.0
[1.0.0]: https://github.com/CoderGamerUnknow/Project-Tango/releases/tag/v1.0.0