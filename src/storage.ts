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
 * Per-record shape checks.
 *
 * The envelope check alone is not enough: restored records are injected straight
 * into the catalog and read by tools that assume every field is present, so a
 * product missing `category` or `tags` produced `TypeError`s out of
 * `list_all_products` and `draft_product_copy`. Records are validated
 * individually and bad ones dropped, rather than rejecting the whole file —
 * one bad record must not discard the rest of a real catalog. A dropped product
 * then falls back to its seed row via the provider's reconcile step.
 */
function isProduct(value: unknown): value is Product {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.sku === "string" &&
    typeof p.price === "number" &&
    typeof p.inventoryCount === "number" &&
    typeof p.category === "string" &&
    Array.isArray(p.tags) &&
    p.tags.every((t) => typeof t === "string") &&
    typeof p.description === "string"
  );
}

function isOrder(value: unknown): value is Order {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.customerName === "string" &&
    typeof o.totalAmount === "number" &&
    typeof o.date === "string" &&
    (o.status === "pending" || o.status === "shipped" || o.status === "delivered") &&
    Array.isArray(o.items) &&
    o.items.every(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as Record<string, unknown>).productId === "string" &&
        typeof (i as Record<string, unknown>).quantity === "number"
    )
  );
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
 * - `PROJECT_TANGO_DATA_DIR=…` — directory for `state.json`.
 * - otherwise `~/.project-tango`. A fixed absolute path matters here because an
 *   MCP client launches this process from an arbitrary working directory, so a
 *   relative path would scatter state files depending on who started it.
 */
export function resolveStateStore(env: NodeJS.ProcessEnv = process.env, log: Logger = noopLogger): StateStore {
  if (env.PROJECT_TANGO_PERSIST === "0") {
    return createMemoryStore();
  }

  const configured = env.PROJECT_TANGO_DATA_DIR?.trim();
  return createFileStore(configured || join(homedir(), ".project-tango"), log);
}