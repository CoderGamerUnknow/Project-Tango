import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Order, Product } from "./types.js";

/**
 * Durable state for the mock provider.
 *
 * Without this, every simulated order is lost when the server restarts: an MCP
 * client relaunches the process routinely, so an agent that places an order and
 * then asks for updated inventory in a later session would be told about a
 * catalog state that no longer exists.
 *
 * Design constraints, in priority order:
 *
 * 1. Never crash the server. This process is a background child of someone
 *    else's app; an unreadable or half-written state file must degrade to the
 *    seed dataset with a warning on stderr, never take the tools down.
 * 2. Never lose a committed write. Saves go to a temp file and are renamed into
 *    place, so a crash mid-write leaves the previous state intact rather than a
 *    truncated file.
 * 3. Never leak state between unrelated runs. Tests point the data directory at
 *    a temp dir; `PROJECT_TANGO_PERSIST=0` disables persistence entirely.
 */

/** Bump when the shape of persisted state changes incompatibly. */
export const STATE_VERSION = 1;

export interface PersistedState {
  version: number;
  products: Product[];
  orders: Order[];
}

export interface StateStore {
  /** Human-readable description, logged once at startup. */
  readonly description: string;
  load(): PersistedState | undefined;
  save(state: PersistedState): void;

  /**
   * Exclusive read-modify-write, if the backend can provide one.
   *
   * `load()` + `save()` alone cannot be atomic across processes: each caller
   * holds its own copy of the whole document, so the last `save()` silently
   * discards the others' work. A backend that can lock — SQLite via `BEGIN
   * IMMEDIATE` — implements this instead, handing `fn` the state as of the
   * moment the lock was taken and committing only if `fn` returns one.
   *
   * Optional because not every backend can. When it is absent the provider
   * falls back to its in-process queue, which serialises callers inside one
   * server and is explicit that it does not reach across processes.
   *
   * Declared as a property rather than a method so an implementation can be
   * lifted off the object and called standalone, which is how the provider
   * reaches it.
   */
  readonly update?: <T>(
    fn: (current: PersistedState | undefined) => Promise<{ commit?: PersistedState; result: T }>
  ) => Promise<T>;

  /** Release any handle the backend holds. A server exits with it. */
  close?(): void;
}

type Logger = (message: string) => void;

const noopLogger: Logger = () => {};

/** Envelope check — a file that parses is not necessarily a state file we wrote. */
function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "number" &&
    Array.isArray(candidate.products) &&
    Array.isArray(candidate.orders)
  );
}

/**
 * A finite number — the check every numeric field below needs.
 *
 * `typeof x === "number"` is not enough. `JSON.parse("1e999")` is `Infinity`,
 * and `Infinity` passes `typeof`, so a hand-edited or foreign-written state file
 * carried a non-finite price straight into the catalog. `JSON.stringify` then
 * serialises it as `null`, so the tool's own text copy and its
 * `structuredContent` copy of the same answer disagreed, and the SDK rejected
 * the response outright: every analytics call failed with
 * `Output validation error: expected number, received Infinity`. One bad field
 * in one record took down all four read tools.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * A finite integer.
 *
 * Quantities and unit counts are declared `z.number().int()` in `schemas.ts`,
 * so a fractional quantity that reached the catalog failed output validation the
 * same way an `Infinity` did. Validating against the schemas' own contract here
 * is what keeps a restored record inside the shape the tools promise.
 */
const isInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value);

/**
 * Per-record shape checks.
 *
 * The envelope check alone is not enough: restored records are injected straight
 * into the catalog and read by tools that assume every field is present, so a
 * product missing `category` or `tags` produced `TypeError`s out of
 * `list_all_products` and `draft_product_copy`. Records are validated
 * individually and bad ones dropped, rather than rejecting the whole file —
 * one bad record must not discard the rest of a real catalog. A dropped product
 * then falls back to its seed row via the provider's reconcile step.
 *
 * Numbers are checked for finiteness, not just type, for the reason
 * `isFiniteNumber` documents: a record that parses is not necessarily a record
 * the response schemas will accept.
 */
/**
 * Per-record shape check.
 *
 * Exported so the SQLite store validates a migrated `state.json` with exactly
 * the same rules the JSON store did. Migration that skipped this would import a
 * malformed record into the database, where the NOT NULL columns would quietly
 * turn a missing field into an empty string instead of dropping the record.
 */
export function isProduct(value: unknown): value is Product {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.sku === "string" &&
    isFiniteNumber(p.price) &&
    isInteger(p.inventoryCount) &&
    typeof p.category === "string" &&
    Array.isArray(p.tags) &&
    p.tags.every((t) => typeof t === "string") &&
    typeof p.description === "string"
  );
}

/** Per-record shape check for orders. See `isProduct`. */
export function isOrder(value: unknown): value is Order {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.customerName === "string" &&
    isFiniteNumber(o.totalAmount) &&
    typeof o.date === "string" &&
    (o.status === "pending" || o.status === "shipped" || o.status === "delivered") &&
    Array.isArray(o.items) &&
    o.items.every((i) => {
      if (typeof i !== "object" || i === null) return false;
      const item = i as Record<string, unknown>;
      return typeof item.productId === "string" && isInteger(item.quantity);
    })
  );
}

/**
 * Filter a raw record list down to the ones this build can actually serve.
 *
 * Shared by the JSON store's recovery path and the SQLite store's migration, so
 * a `state.json` written by any version is held to one rule: bad records are
 * dropped individually and reported, never passed through to become a runtime
 * failure inside a tool. Skipping this on the migration path was a real bug —
 * SQLite's NOT NULL columns would have turned a missing field into an empty
 * string instead of dropping the record, which reads as valid data.
 */
export function validRecords<T>(
  records: unknown[],
  isValid: (value: unknown) => value is T
): { valid: T[]; dropped: number } {
  const valid = records.filter(isValid);
  return { valid, dropped: records.length - valid.length };
}

/**
 * In-memory store: the previous behaviour, kept as an explicit opt-out and used
 * when persistence is disabled. State lives only as long as the process.
 */
export function createMemoryStore(): StateStore {
  let current: PersistedState | undefined;

  return {
    description: "in-memory (state is discarded when the server stops)",
    // Cloned in both directions so this store behaves exactly like the file
    // store, whose loads return a fresh object from JSON.parse. Handing out the
    // live reference let a caller mutating the loaded state silently corrupt
    // what the store held, making behaviour depend on which store is configured.
    load: () => (current === undefined ? undefined : structuredClone(current)),
    save: (state) => {
      current = structuredClone(state);
    },
  };
}

/**
 * JSON-file store.
 *
 * Writes are atomic (temp file + rename) and the directory is created on demand,
 * so pointing this at a path that does not exist yet works.
 *
 * The temp name is unique per write (`state.json.tmp.<pid>.<n>`), which matters
 * when two server processes share one data directory: a shared temp name lets
 * two writers interleave their bytes into the same file, and the rename then
 * publishes torn JSON. With per-write temp files, every published `state.json`
 * is one process's complete snapshot — the worst a race can do is make the
 * last writer win, never corrupt the file.
 */
export function createFileStore(directory: string, log: Logger = noopLogger): StateStore {
  const file = join(directory, "state.json");
  let tempSequence = 0;

  return {
    description: `${file}`,

    load() {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        // Absent file is the normal first-run case, not an error worth logging.
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log(
          `Project Tango: state file at ${file} is not valid JSON — starting from the seed dataset. ` +
            `Delete the file to silence this.`
        );
        return undefined;
      }

      if (!isPersistedState(parsed)) {
        log(`Project Tango: state file at ${file} has an unexpected shape — starting from the seed dataset.`);
        return undefined;
      }

      if (parsed.version !== STATE_VERSION) {
        log(
          `Project Tango: state file at ${file} is version ${parsed.version} but this build expects ` +
            `${STATE_VERSION} — starting from the seed dataset. Delete the file to re-seed.`
        );
        return undefined;
      }

      const products = parsed.products.filter(isProduct);
      const orders = parsed.orders.filter(isOrder);
      const droppedProducts = parsed.products.length - products.length;
      const droppedOrders = parsed.orders.length - orders.length;

      if (droppedProducts > 0 || droppedOrders > 0) {
        log(
          `Project Tango: dropped ${droppedProducts} malformed product(s) and ${droppedOrders} ` +
            `malformed order(s) from ${file}; dropped products fall back to the seed catalog.`
        );
      }

      return { version: parsed.version, products, orders };
    },

    save(state) {
      const tempFile = join(directory, `state.json.tmp.${process.pid}.${tempSequence++}`);
      try {
        mkdirSync(directory, { recursive: true });
        // Rename is atomic on POSIX and NTFS, so a crash mid-write can never
        // leave a half-serialised state file in place of a good one.
        writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
        renameSync(tempFile, file);
      } catch (error) {
        // A failed rename leaves its temp file behind — clean it up so a
        // transient failure (Windows refuses a rename while another process
        // holds the destination) litters nothing. The previous state.json is
        // untouched either way: that is the last-writer-wins boundary
        // documented in the README, not corruption.
        try {
          unlinkSync(tempFile);
        } catch {
          // Either the rename actually consumed it or the write never got
          // that far; nothing to clean.
        }
        // A read-only home directory must not take the tools down; the order is
        // still applied in memory and reported to the caller as a success.
        log(`Project Tango: could not persist state to ${file}: ${(error as Error).message}`);
      }
    },
  };
}

/**
 * Pick a store from the environment.
 *
 * - `PROJECT_TANGO_PERSIST=0` — no persistence, original in-memory behaviour.
 * - `PROJECT_TANGO_DATA_DIR=…` — directory for the state database.
 * - `PROJECT_TANGO_STORE=json` — force the whole-snapshot JSON file instead of
 *   SQLite. Kept for a read-only filesystem or a runtime without `node:sqlite`;
 *   it is last-writer-wins across processes, which is why it is no longer the
 *   default.
 * - otherwise `~/.project-tango`. A fixed absolute path matters here because an
 *   MCP client launches this process from an arbitrary working directory, so a
 *   relative path would scatter state files depending on who started it.
 *
 * The order is a graceful-degradation chain: SQLite when the runtime has it, the
 * JSON file if it cannot be opened, and in-memory if persistence is off. A
 * store that cannot be created is a reason to warn, never a reason to refuse to
 * start.
 */
export async function resolveStateStore(
  env: NodeJS.ProcessEnv = process.env,
  log: Logger = noopLogger
): Promise<StateStore> {
  if (env.PROJECT_TANGO_PERSIST === "0") {
    return createMemoryStore();
  }

  const configured = env.PROJECT_TANGO_DATA_DIR?.trim();
  const directory = configured || join(homedir(), ".project-tango");

  if (env.PROJECT_TANGO_STORE?.trim().toLowerCase() === "json") {
    return createFileStore(directory, log);
  }

  // Loaded on demand, and through a typed dynamic import rather than
  // `createRequire`: a require call returns `any`, which would push the
  // store's real contract out of reach of the type checker exactly where this
  // decision is made. `storage.ts` and `sqliteStore.ts` reference each other,
  // so one of the two edges has to be late — this one.
  const sqlite = await loadSqliteStore(directory, log);
  if (sqlite) return sqlite;

  // Falling back to the JSON store here would be worse than having no
  // persistence at all: two servers sharing a directory would then be writing
  // `state.db` and `state.json` as separate catalogs, each believing it owned
  // the truth. Losing durability across a restart is recoverable; two processes
  // quietly disagreeing about the stock is not. In-memory at least keeps this
  // server internally consistent and says so.
  log(
    `Project Tango: no durable store available for ${directory}; this server will keep its state in ` +
      `memory only, and a restart will return it to the seed catalog.`
  );
  return createMemoryStore();
}

/**
 * Resolve the SQLite backend without making it a hard import cycle.
 *
 * A dynamic import keeps `storage.ts` free of a static dependency on the store
 * that imports it back, and keeps its return type fully checked.
 */
async function loadSqliteStore(
  directory: string,
  log: Logger
): Promise<StateStore | undefined> {
  const sqlite = await import("./sqliteStore.js");
  return sqlite.createSqliteStore(directory, log);
}