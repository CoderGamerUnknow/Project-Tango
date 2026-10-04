import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { STATE_VERSION, isOrder, isProduct, validRecords, type PersistedState, type StateStore } from "./storage.js";

/**
 * SQLite-backed durable state.
 *
 * Ported from the `v2.0.0` lineage, which carried a SQLite store that `main`
 * never received — `main` shipped a whole-snapshot JSON file instead. That
 * choice is what produced the "two processes, last writer wins" caveat the
 * README used to carry: with only `load()`/`save()` there is no way to make a
 * read-modify-write atomic *across processes*, because each process holds its
 * own copy of the whole document and the last `save()` overwrites the other.
 *
 * SQLite fixes that at the level of the storage engine rather than by
 * convention. `BEGIN IMMEDIATE` takes a write lock before the first read, so a
 * transaction cannot read a snapshot another writer has already moved past —
 * the interleaving that oversells stock. The lock is released on COMMIT or
 * ROLLBACK, including when the process dies, so a crashed server cannot wedge
 * the store for the next one.
 *
 * `node:sqlite` ships with Node, so this adds no dependency. The version check
 * keeps that promise honest: on an older runtime the store reports itself
 * unavailable and the caller falls back, rather than failing at the first write.
 *
 * Everything else the JSON store promised still holds. An unreadable database
 * degrades to the seed dataset with a warning on stderr, never taking the
 * tools down, because this process is a background child of someone else's app.
 */

/** Lowest Node runtime with a usable built-in `node:sqlite`. */
export const MIN_NODE_FOR_SQLITE = "22.5.0";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  sku             TEXT    NOT NULL,
  price           REAL    NOT NULL,
  inventory_count INTEGER NOT NULL,
  category        TEXT    NOT NULL,
  tags            TEXT    NOT NULL,
  description     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  customer_name TEXT    NOT NULL,
  total_amount  REAL    NOT NULL,
  status        TEXT    NOT NULL,
  date          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id   TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  product_id TEXT    NOT NULL,
  quantity   INTEGER NOT NULL,
  PRIMARY KEY (order_id, position)
);

CREATE INDEX IF NOT EXISTS idx_products_sku      ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(date);
`;

/** `true` when this runtime ships a usable built-in SQLite. */
export function sqliteAvailable(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

/** How many times to retry an open that lost a race for the lock. */
const OPEN_ATTEMPTS = 40;

/** Backoff between open retries, capped so a long wait still feels bounded. */
const OPEN_RETRY_MS = 250;

/**
 * Open the database and bring it to the shape this store expects.
 *
 * Split out because both halves are retryable and the retry is the whole point:
 * `PRAGMA journal_mode = WAL` needs a brief exclusive lock and returns
 * `SQLITE_BUSY` *immediately*, ignoring `busy_timeout` entirely. Two servers
 * starting together therefore raced, and the loser silently fell back to a
 * weaker backend — which reintroduced the exact overselling this store exists
 * to prevent. Starting while another server runs is normal, not an error, so it
 * is waited out.
 */
function openWithRetry(
  file: string,
  log: (message: string) => void
): DatabaseSync | undefined {
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file);
      db.exec("PRAGMA busy_timeout = 5000");
      // WAL lets a reader run while a writer holds the lock, so a catalog read
      // never blocks behind an order being placed in another process.
      db.exec("PRAGMA journal_mode = WAL");
      // Enforce the declared foreign key; SQLite ignores it unless asked, and it
      // is what keeps an order from existing without its line items.
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(SCHEMA);
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Nothing usable to close.
      }
      const message = (error as Error).message;
      const locked = /lock|busy/i.test(message);
      if (locked && attempt < OPEN_ATTEMPTS) {
        // Wait synchronously: this runs before the server is serving, so there
        // is no event loop turn to yield to.
        sleep(Math.min(OPEN_RETRY_MS * attempt, 1000));
        continue;
      }
      log(
        `Project Tango: could not open ${file} (${message}` +
          `${locked ? ` after ${OPEN_ATTEMPTS} attempts` : ""}); this server will keep its state in memory only.`
      );
      return undefined;
    }
  }
  return undefined;
}

/** Block for `ms`. Startup is single-threaded, so a sync wait is correct here. */
function sleep(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Open (or create) the store in `directory`.
 *
 * Returns `undefined` when the runtime has no SQLite, or the file cannot be
 * opened even after waiting out a lock. The caller must treat that as
 * "in-memory only" — never as licence to use a *different on-disk backend*,
 * because two servers writing `state.db` and `state.json` in the same directory
 * would silently split the catalog in two.
 */
export function createSqliteStore(
  directory: string,
  log: (message: string) => void = () => {}
): StateStore | undefined {
  if (!sqliteAvailable()) {
    log(
      `Project Tango: this runtime (Node ${process.versions.node}) has no built-in SQLite ` +
        `(needs ${MIN_NODE_FOR_SQLITE}+), so this server will keep its state in memory only.`
    );
    return undefined;
  }

  const file = join(directory, "state.db");
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    log(
      `Project Tango: could not create ${directory} (${(error as Error).message}); ` +
        `this server will keep its state in memory only.`
    );
    return undefined;
  }

  const db = openWithRetry(file, log);
  if (!db) return undefined;

  // Prepared once, because this runs before every read: re-parsing the pragma
  // per call measured 11.5us against 5.5us for the prepared form (and ~677us for
  // a full reload), so the freshness check stays two orders of magnitude below
  // the work it saves.
  const dataVersion = db.prepare("PRAGMA data_version");

  const readAll = (): PersistedState => {
    const products = db
      .prepare("SELECT id, name, sku, price, inventory_count, category, tags, description FROM products")
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        let tags: string[] = [];
        try {
          const parsed: unknown = JSON.parse(String(r.tags));
          if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) tags = parsed;
        } catch {
          // A malformed tags blob costs that product its tags, not the catalog.
        }
        return {
          id: String(r.id),
          name: String(r.name),
          sku: String(r.sku),
          price: Number(r.price),
          inventoryCount: Number(r.inventory_count),
          category: String(r.category),
          tags,
          description: String(r.description),
        };
      });

    const itemsByOrder = new Map<string, Array<{ productId: string; quantity: number }>>();
    for (const row of db
      .prepare("SELECT order_id, product_id, quantity FROM order_items ORDER BY order_id, position")
      .all()) {
      const r = row as Record<string, unknown>;
      const orderId = String(r.order_id);
      const list = itemsByOrder.get(orderId) ?? [];
      list.push({ productId: String(r.product_id), quantity: Number(r.quantity) });
      itemsByOrder.set(orderId, list);
    }

    const orders = db
      .prepare("SELECT id, customer_name, total_amount, status, date FROM orders")
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        const id = String(r.id);
        return {
          id,
          customerName: String(r.customer_name),
          items: itemsByOrder.get(id) ?? [],
          totalAmount: Number(r.total_amount),
          status: String(r.status) as PersistedState["orders"][number]["status"],
          date: String(r.date),
        };
      });

    // Only reached when the store holds state, so a version row is guaranteed:
    // `isPristine` is what decides that, and it keys off exactly this row.
    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as {
      value: string;
    };
    return { version: Number(versionRow.value), products, orders };
  };

  const writeAll = (state: PersistedState): void => {
    db.exec("DELETE FROM order_items; DELETE FROM orders; DELETE FROM products;");
    const insertProduct = db.prepare(
      "INSERT INTO products (id, name, sku, price, inventory_count, category, tags, description) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const p of state.products) {
      insertProduct.run(
        p.id,
        p.name,
        p.sku,
        p.price,
        p.inventoryCount,
        p.category,
        JSON.stringify(p.tags),
        p.description
      );
    }
    const insertOrder = db.prepare(
      "INSERT INTO orders (id, customer_name, total_amount, status, date) VALUES (?, ?, ?, ?, ?)"
    );
    const insertItem = db.prepare(
      "INSERT INTO order_items (order_id, position, product_id, quantity) VALUES (?, ?, ?, ?)"
    );
    for (const o of state.orders) {
      insertOrder.run(o.id, o.customerName, o.totalAmount, o.status, o.date);
      o.items.forEach((item, index) => insertItem.run(o.id, index, item.productId, item.quantity));
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(state.version));
  };

  /**
   * Has anything ever been written here?
   *
   * The schema is created on open, so "the database has tables" says nothing
   * about whether it holds state. Reporting an untouched database as a restored
   * empty state made the provider take its restore path and serve zero orders
   * instead of the seed — so the absence of state has to be reported as
   * `undefined`, exactly as the JSON store reports a missing file.
   *
   * Selected by value, not `count(*)`: an aggregate without `GROUP BY` always
   * produces a row (`{c: 0}`) even when nothing matches, which would have made
   * this permanently false and reintroduced the bug it is checking for.
   */
  const isPristine = (): boolean =>
    db.prepare("SELECT value FROM meta WHERE key = 'version'").get() === undefined;

  /**
   * Import a `state.json` written by the previous JSON store, once.
   *
   * Without this, upgrading would silently reset everyone's catalog: the old
   * file would be ignored and the seed dataset restored, which is the quiet
   * data loss this project refuses elsewhere. The old file is *renamed*, not
   * deleted, so a rollback to the previous build still finds its state.
   */
  const importLegacyJson = (): void => {
    const legacy = join(directory, "state.json");
    if (!existsSync(legacy)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(legacy, "utf8"));
    } catch {
      // Unparseable: leave it exactly where it is and say nothing further. The
      // JSON store logged about this already; re-logging here would be noise.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const candidate = parsed as { products?: unknown; orders?: unknown };
    if (!Array.isArray(candidate.products) || !Array.isArray(candidate.orders)) return;

    const products = validRecords(candidate.products, isProduct);
    const orders = validRecords(candidate.orders, isOrder);
    if (products.valid.length === 0 && orders.valid.length === 0) return;
    if (!isPristine()) return;

    if (products.dropped > 0 || orders.dropped > 0) {
      log(
        `Project Tango: dropped ${products.dropped} malformed product(s) and ${orders.dropped} malformed ` +
          `order(s) while importing the previous state.json.`
      );
    }

    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        writeAll({ version: STATE_VERSION, products: products.valid, orders: orders.valid });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      renameSync(legacy, `${legacy}.migrated`);
      log(
        `Project Tango: imported ${products.valid.length} product(s) and ${orders.valid.length} order(s) from the ` +
          `previous state.json into ${file}. The old file is kept as state.json.migrated.`
      );
    } catch (error) {
      log(`Project Tango: could not import the previous state.json (${(error as Error).message}).`);
    }
  };

  importLegacyJson();

  return {
    description: `${file} (SQLite, WAL)`,

    load() {
      try {
        // A database nobody has written to yet is the same thing the JSON store
        // reports for a missing file: no state, so the caller seeds.
        if (isPristine()) return undefined;
        return readAll();
      } catch (error) {
        log(
          `Project Tango: could not read ${file} (${(error as Error).message}) — starting from the seed dataset.`
        );
        return undefined;
      }
    },

    save(state) {
      try {
        // One transaction for the whole snapshot: a crash midway cannot leave
        // orders without their line items.
        db.exec("BEGIN IMMEDIATE");
        try {
          writeAll(state);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        log(`Project Tango: could not persist state to ${file}: ${(error as Error).message}`);
      }
    },

    /**
     * Has another *process* committed since we last looked?
     *
     * `PRAGMA data_version` is defined to change when any other connection
     * commits and not when this one does, which is precisely what a cache needs:
     * our own writes are already in memory, so they must not trigger a reload,
     * while another server's order must.
     *
     * Cheap enough to call before every read — one prepared statement, no table
     * scan — which is what keeps a long-running server from serving a catalog
     * another process has already replaced.
     */
    changeToken: () => {
      const row = dataVersion.get() as { data_version: number | bigint } | undefined;
      return `sqlite:${row?.data_version ?? 0}`;
    },

    /**
     * Exclusive read-modify-write across processes.
     *
     * `BEGIN IMMEDIATE` acquires the write lock *before* `current` is read, so
     * the state handed to `fn` cannot be one another writer has already moved
     * past. That is what turns the old last-writer-wins caveat into a real
     * guarantee: two servers placing orders against one data directory now
     * serialise instead of clobbering each other.
     */
    async update<T>(
      fn: (current: PersistedState | undefined) => Promise<{ commit?: PersistedState; result: T }>
    ): Promise<T> {
      db.exec("BEGIN IMMEDIATE");
      try {
        // `undefined` when nothing has ever been written, matching `load()`: a
        // pristine store holds no state, and the caller's own seeded in-memory
        // state is still the truth. Reading an untouched database as an empty
        // one made the first transaction wipe the catalog it was working on.
        const current = isPristine() ? undefined : readAll();
        const outcome = await fn(current);
        if (outcome.commit) writeAll(outcome.commit);
        db.exec("COMMIT");
        return outcome.result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already rolled back, or the transaction never opened.
        }
        throw error;
      }
    },

    /** Release the database handle. A server exits with it; tests use it. */
    close() {
      try {
        // Fold the write-ahead log back into the database file first. Without
        // this the `-wal`/`-shm` sidecars linger after close, and on Windows a
        // handle still held on them blocks the containing directory from being
        // removed — which makes every test that opens a store leave litter or
        // fail its cleanup.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // A checkpoint failure must not stop the handle being released.
      }
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}