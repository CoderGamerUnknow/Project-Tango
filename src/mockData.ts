import { AsyncLocalStorage } from "node:async_hooks";

import { seedOrders } from "./orderGenerator.js";
import { seedProducts } from "./seedCatalog.js";
import { resolveStateStore, STATE_VERSION, type PersistedState, type StateStore } from "./storage.js";
import type { DataProvider, Order, Product } from "./types.js";

/**
 * In-memory, durable-across-restarts implementation of `DataProvider`.
 *
 * This is the "instant, zero-configuration" half of the mock-to-real pipeline:
 * every tool in src/index.ts is written against the `DataProvider` interface, so
 * replacing `mockDataProvider` with a `ShopifyDataProvider` /
 * `StripeDataProvider` that talks to real APIs requires no changes to tool logic
 * — only a new class implementing the same interface. Reading this file should
 * be enough to understand the contract, which is why the catalog and the order
 * generator live in `seedCatalog.ts` and `orderGenerator.ts`.
 *
 * State is restored from the store on construction when one exists, so an
 * inventory decrement or simulated order from a previous session survives a
 * restart.
 *
 * Exported so the durability contract above can be tested directly: the tools
 * only ever mutate through `transact()`, so a method that forgot to persist
 * outside a transaction would be invisible from the MCP surface. The same goes
 * for the isolation contract: every read returns a copy (see `cloneProduct`),
 * so a test can prove a caller cannot corrupt provider state.
 */
/**
 * Copy a product, including its mutable `tags` array.
 *
 * Every read path hands one of these out instead of the stored record, so a
 * caller who mutates what it received cannot corrupt the catalog — and, because
 * those mutations never reach `this.products`, cannot bypass the `revision`
 * counter either. This mirrors what `storage.ts` already does ("Cloned in both
 * directions"): a provider that only cloned one way would behave differently
 * depending on which side did the mutating.
 */
function cloneProduct(product: Product): Product {
  return { ...product, tags: [...product.tags] };
}

/** Copy an order, including every line item. See `cloneProduct`. */
function cloneOrder(order: Order): Order {
  return { ...order, items: order.items.map((item) => ({ ...item })) };
}

export class MockDataProvider implements DataProvider {
  private products: Product[];
  private orders: Order[];
  private readonly store: StateStore;
  private readonly seedProducts: Product[];
  private readonly seedOrders: Order[];

  /**
   * Tail of the in-process transaction queue. Order placement reads stock,
   * awaits, then writes — with no exclusion, concurrent callers all validate
   * against the same pre-write snapshot and oversell (ten orders against three
   * units of stock once drove inventory to -7). Chaining every transaction onto
   * this promise makes each read-validate-write sequence atomic with respect to
   * the others. Failures settle the chain rather than poisoning it.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * Marks the async context of a transaction that is currently running.
   *
   * This has to be context-local rather than a counter on the instance. A
   * counter cannot tell a nested call (same transaction, must join it) apart
   * from a concurrent one (different transaction, must queue behind it): with a
   * counter, the second concurrent caller sees a non-zero depth and runs
   * immediately without queueing, which is exactly the interleaving that lets
   * two orders oversell the same stock. Context storage keeps re-entrancy and
   * concurrency distinct.
   */
  private readonly transactionContext = new AsyncLocalStorage<true>();

  /**
   * Bumped by every mutating method.
   *
   * A transaction compares this before and after running `fn` to decide whether
   * the commit has anything to persist. A rejected order runs a transaction that
   * changes nothing, and must not write a state file — which is also why the
   * check cannot simply be "the transaction finished".
   */
  private revision = 0;

  /**
   * Transactions currently running in *this* process, as a plain counter.
   *
   * A read can interleave with a transaction — the write queue only orders
   * transactions against each other — and a read that refreshed mid-transaction
   * would drop the half-applied changes it is looking at. `transactionContext`
   * cannot cover that case, because the reading call is in a different async
   * context than the one running the transaction.
   */
  private inFlight = 0;

  /** The `changeToken` value the in-memory catalog was last reconciled against. */
  private observedToken?: string;

  constructor(
    seedProducts: Product[],
    seedOrders: Order[],
    store: StateStore,
    log: (message: string) => void = () => {}
  ) {
    this.store = store;
    this.seedProducts = seedProducts;
    this.seedOrders = seedOrders;

    // Read the change token *before* the state, and remember it only if the
    // store was readable. The order matters: a commit landing between the two
    // must leave the token looking newer than the state we hold, so the next
    // read reloads. Taking the token afterwards would let a stale catalog
    // masquerade as current until something else changed.
    const token = store.changeToken?.();
    const restored = store.load();
    if (token !== undefined) this.observedToken = token;

    if (restored) {
      // Reconcile against the seed rather than replacing it wholesale. Wholesale
      // replacement made this catalog uneditable: once a state file existed,
      // adding or changing a product in the seed had no visible effect, and
      // nothing said so. Restored rows win on conflict — they carry the real
      // stock history — while seed-only rows are appended so catalog edits still
      // land.
      const restoredIds = new Set(restored.products.map((p) => p.id));
      const missingFromState = seedProducts.filter((p) => !restoredIds.has(p.id));

      this.products = [...restored.products, ...missingFromState.map(cloneProduct)];
      this.orders = restored.orders;

      log(
        `Project Tango: restored ${restored.products.length} product(s) and ${restored.orders.length} order(s) ` +
          `from ${store.description}.` +
          (missingFromState.length > 0
            ? ` Re-added ${missingFromState.length} seed product(s) absent from saved state; ` +
              `saved state takes precedence for products it contains.`
            : "")
      );
      return;
    }

    this.products = this.freshProducts();
    this.orders = this.freshOrders();
  }

  /** Deep-copies so mutations never leak back into the module-level constants. */
  private freshProducts(): Product[] {
    return this.seedProducts.map(cloneProduct);
  }

  private freshOrders(): Order[] {
    return this.seedOrders.map(cloneOrder);
  }

  private snapshot(): PersistedState {
    return { version: STATE_VERSION, products: this.products, orders: this.orders };
  }

  /**
   * Persist a mutation that was not made inside a transaction.
   *
   * `updateProductInventory` and `addOrder` are part of the public provider
   * contract, so a caller reaching them directly must get a durable write.
   * Inside a transaction the save is deferred to the commit, so placing an order
   * still writes the file once rather than once per line item.
   */
  private commitIfIdle(): void {
    if (this.transactionContext.getStore() !== true) {
      this.store.save(this.snapshot());
    }
  }

  getProducts(): Promise<Product[]> {
    this.refresh();
    return Promise.resolve(this.products.map(cloneProduct));
  }

  getOrders(): Promise<Order[]> {
    this.refresh();
    return Promise.resolve(this.orders.map(cloneOrder));
  }

  getProductBySku(sku: string): Promise<Product | undefined> {
    this.refresh();
    const product = this.products.find((p) => p.sku.toLowerCase() === sku.toLowerCase());
    return Promise.resolve(product ? cloneProduct(product) : undefined);
  }

  updateProductInventory(id: string, newCount: number): Promise<Product | undefined> {
    const product = this.products.find((p) => p.id === id);
    if (!product) return Promise.resolve(undefined);
    product.inventoryCount = newCount;
    this.revision += 1;
    this.commitIfIdle();
    // The stored record is mutated in place above; the copy is what leaves.
    return Promise.resolve(cloneProduct(product));
  }

  addOrder(order: Order): Promise<Order> {
    // Stored as a copy so a caller mutating its own `order` object afterwards
    // cannot edit stored history without bumping the revision.
    const stored = cloneOrder(order);
    this.orders.push(stored);
    this.revision += 1;
    this.commitIfIdle();
    return Promise.resolve(cloneOrder(stored));
  }

  /**
   * Runs `fn` as one atomic, durable commit.
   *
   * Atomicity: every transaction is chained onto the previous one, so the whole
   * read-validate-write is exclusive with respect to other transactions.
   *
   * Durability: the state file is written once here, after `fn` resolves, if any
   * mutating method ran inside it. Batching the save to the commit is what keeps
   * an order — which rewrites inventory per line and then adds the order — from
   * writing the file once per line item.
   *
   * Nesting: a transaction started inside another joins it rather than queueing
   * behind it. The outer call already holds the queue tail, so waiting for it
   * again would deadlock instead of running.
   *
   * Rollback: state is snapshotted before `fn` runs and restored if it throws,
   * and the save happens only on success. Without this, a provider method that
   * failed halfway through — say, a write that threw on line three of an order —
   * left the earlier mutations in memory, and the commit in the old `finally`
   * wrote that half-applied state to disk to match, which is precisely the
   * "silent partial write" the README promises cannot happen.
   */
  async transact<T>(fn: (provider: DataProvider) => Promise<T>): Promise<T> {
    // Re-entrant call from within this transaction: join it, and let the outer
    // commit own the write.
    if (this.transactionContext.getStore() === true) {
      return fn(this);
    }

    const run = async () => {
      // Held across the whole transaction, not just while `fn` runs, so a read
      // from another task cannot reload the store underneath it and discard the
      // half-applied state this transaction is building.
      this.inFlight += 1;
      try {
        return await this.runExclusive(fn);
      } finally {
        this.inFlight -= 1;
      }
    };

    const result = this.writeChain.then(run, run);
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * The body of a transaction, with the write queue already held.
   *
   * Split out so the in-flight counter wraps every exit path — a throwing
   * transaction must release it too, or the provider would refuse to refresh
   * for the rest of its life.
   */
  private async runExclusive<T>(fn: (provider: DataProvider) => Promise<T>): Promise<T> {
    // When the store can lock, the whole read-validate-write happens *inside*
    // that lock. Without it, each process validated against its own startup
    // snapshot and the last save won; with it, the state `fn` reads is the
    // state as of the moment the lock was taken, so two servers sharing a
    // data directory serialise instead of clobbering each other.
    if (this.store.update) {
      return this.store.update(async (current) => {
        // `current` is undefined on a store nothing has been written to yet.
        // Adopting then would replace the seeded catalog with nothing, so the
        // in-memory seed is left to stand until the store actually holds
        // state — and once another process has written, its state wins.
        if (current) this.adopt(current);

        const revisionBefore = this.revision;
        // Snapshot after adopting, so a rollback returns to what this
        // transaction started from rather than to the state before it.
        const productsBefore = this.products.map(cloneProduct);
        const ordersBefore = this.orders.map(cloneOrder);

        try {
          const result = await this.transactionContext.run(true, () => fn(this));
          // Commit only what this transaction actually changed, so a
          // validation that rejected the order writes nothing.
          const commit = this.revision !== revisionBefore ? this.snapshot() : undefined;
          return { commit, result };
        } catch (error) {
          this.products = productsBefore;
          this.orders = ordersBefore;
          this.revision = revisionBefore;
          throw error;
        }
      });
    }

    const revisionBefore = this.revision;
    // Deep copy: `updateProductInventory` mutates records in place, so an
    // array-level copy would still hand the rollback the same objects.
    const productsBefore = this.products.map(cloneProduct);
    const ordersBefore = this.orders.map(cloneOrder);

    try {
      const result = await this.transactionContext.run(true, () => fn(this));
      if (this.revision !== revisionBefore) {
        this.store.save(this.snapshot());
      }
      return result;
    } catch (error) {
      this.products = productsBefore;
      this.orders = ordersBefore;
      // The revision counts committed changes; the ones just discarded never
      // reached the store, so the counter rolls back with them.
      this.revision = revisionBefore;
      throw error;
    }
  }

  /**
   * Replace in-memory state with what the store just handed us.
   *
   * Records are cloned on the way in because the store's copy is shared: the
   * memory store hands out a deep copy already, but the file and SQLite stores
   * may return objects they still reference, and `updateProductInventory`
   * mutates records in place.
   *
   * Seed rows missing from the stored state are re-added, which is the same
   * reconciliation the constructor does and is not optional here. Stored state
   * can legitimately hold fewer products than the seed catalog — a `state.json`
   * written before a product was added to the seed, or one whose products were
   * pruned — and adopting it verbatim meant a server that *listed* thirteen
   * products would drop to whatever the file happened to contain the moment its
   * first transaction re-read the store. The order then failed with "no product
   * found with id prod_001" for a product the same server had just returned, and
   * the next commit persisted the loss. Reconciling on the way in keeps the
   * catalog whole, and because the commit writes what is in memory, the stored
   * state is repaired instead of eroded.
   */
  private adopt(state: PersistedState | undefined): void {
    if (!state) return;
    const stored = new Set(state.products.map((p) => p.id));
    const missingFromState = this.seedProducts.filter((p) => !stored.has(p.id));
    this.products = [...state.products.map(cloneProduct), ...missingFromState.map(cloneProduct)];
    this.orders = state.orders.map(cloneOrder);
  }

  /**
   * Pick up a commit another server made, if there is one.
   *
   * A running server keeps the catalog in memory, and MCP clients keep a server
   * running for a whole conversation — so without this, an agent that placed an
   * order in one window and asked about inventory in another would be told about
   * a catalog another process had already replaced. Writes never see a stale
   * snapshot (they re-read under the transaction lock), but reads did.
   *
   * Two guards keep it cheap and safe:
   *
   *  - it costs one `changeToken()` call, and reloads only when that token moved.
   *    A store with no token (or a backend that cannot detect another writer)
   *    simply never refreshes, which is the behaviour this project always had;
   *  - it never runs inside a transaction. Reloading then would replace the
   *    uncommitted state a running transaction is part-way through building,
   *    so the in-transaction view is left alone and picks up the next commit.
   */
  private refresh(): void {
    if (this.store.changeToken === undefined) return;
    if (this.transactionContext.getStore() === true) return;
    if (this.inFlight > 0) return;

    const token = this.store.changeToken();
    if (token === this.observedToken) return;

    this.observedToken = token;
    this.adopt(this.store.load());
  }

  reset(): Promise<{ products: number; orders: number }> {
    return this.transact(() => {
      const discarded = { products: this.products.length, orders: this.orders.length };
      this.products = this.freshProducts();
      this.orders = this.freshOrders();
      this.revision += 1;
      return Promise.resolve(discarded);
    });
  }
}

/**
 * Singleton mock provider used by default in src/index.ts. Swap this import
 * for a real provider implementation when you're ready to go live — see the
 * `DataProvider` interface in src/types.ts.
 *
 * Diagnostics go to stderr because stdout carries the MCP protocol.
 */
// Top-level await: the SQLite backend is loaded through a dynamic import to
// keep `storage.ts` free of a static cycle, so resolving the store is async.
const stateStore = await resolveStateStore(process.env, (message) => console.error(message));

/** Where this process is keeping state, reported in the startup line. */
export const stateStoreDescription = stateStore.description;

export const mockDataProvider: DataProvider = new MockDataProvider(
  seedProducts,
  seedOrders,
  stateStore,
  (message) => console.error(message)
);