import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MockDataProvider } from "./mockData.js";
import { seedOrders } from "./orderGenerator.js";
import { seedProducts } from "./seedCatalog.js";
import { createMemoryStore, type PersistedState, type StateStore } from "./storage.js";
import type { Order } from "./types.js";

/**
 * Provider-level tests: isolation and durability of `MockDataProvider`.
 *
 * These sit in their own layer deliberately. The tools only ever mutate through
 * `transact()`, so two provider behaviours are invisible from the MCP surface:
 *
 *  - a read path that hands back a live reference — a caller mutating what it
 *    received would corrupt provider state, and the write would bypass the
 *    `revision` counter, so the next save would persist it silently;
 *  - a method that mutates but forgets to save outside a transaction.
 *
 * Importing `./mockData.js` only *loads* state (a read of a file that may not
 * exist); it never writes. Every test below builds its own provider against a
 * `createMemoryStore()`, so `~/.project-tango` is never touched.
 */
function makeProvider(): MockDataProvider {
  return new MockDataProvider(seedProducts, seedOrders, createMemoryStore());
}

describe("read isolation", () => {
  it("hands back a copy of the catalog, so mutating a returned product cannot corrupt state", async () => {
    const provider = makeProvider();
    const products = await provider.getProducts();
    const first = products[0]!;

    first.inventoryCount = 999;
    first.tags.push("injected");

    const after = await provider.getProducts();
    assert.equal(after.length, seedProducts.length);
    assert.equal(after[0]!.inventoryCount, seedProducts[0]!.inventoryCount);
    assert.ok(!after[0]!.tags.includes("injected"));
  });

  it("hands back a copy of the array, so pushing to it cannot grow the catalog", async () => {
    const provider = makeProvider();
    const products = await provider.getProducts();

    products.push({ ...products[0]!, id: "prod_ghost" });
    products.splice(0, 1);

    const after = await provider.getProducts();
    assert.equal(after.length, seedProducts.length);
    assert.ok(after.some((p) => p.id === "prod_001"));
    assert.ok(!after.some((p) => p.id === "prod_ghost"));
  });

  it("hands back a copy from getProductBySku", async () => {
    const provider = makeProvider();
    const product = await provider.getProductBySku("TCH-AB-001");
    assert.ok(product);

    product.inventoryCount = 999;
    product.tags.push("injected");

    const fresh = await provider.getProductBySku("TCH-AB-001");
    assert.equal(fresh!.inventoryCount, 42);
    assert.ok(!fresh!.tags.includes("injected"));
  });

  it("hands back copies of orders, including every line item", async () => {
    const provider = makeProvider();
    const orders = await provider.getOrders();
    const first = orders[0]!;

    first.items[0]!.quantity = 999;
    first.items.push({ productId: "prod_001", quantity: 50 });
    first.status = "delivered";

    const after = await provider.getOrders();
    assert.equal(after.length, seedOrders.length);
    assert.equal(after[0]!.items.length, seedOrders[0]!.items.length);
    assert.equal(after[0]!.items[0]!.quantity, seedOrders[0]!.items[0]!.quantity);
    assert.equal(after[0]!.status, seedOrders[0]!.status);
  });

  it("returns a copy from updateProductInventory, so mutating it cannot edit stored stock", async () => {
    const provider = makeProvider();
    const updated = await provider.updateProductInventory("prod_001", 7);
    assert.equal(updated!.inventoryCount, 7);

    updated!.inventoryCount = 999;
    updated!.tags.push("injected");

    const fresh = await provider.getProductBySku("TCH-AB-001");
    assert.equal(fresh!.inventoryCount, 7);
    assert.ok(!fresh!.tags.includes("injected"));
  });

  it("stores a copy of an order, so mutating it after addOrder cannot edit history", async () => {
    const provider = makeProvider();
    const order: Order = {
      id: "ord_test",
      customerName: "Probe",
      items: [{ productId: "prod_001", quantity: 1 }],
      totalAmount: 129.99,
      status: "pending",
      date: "2026-10-03",
    };

    const stored = await provider.addOrder(order);
    order.items[0]!.quantity = 999; // caller's own object
    stored.items[0]!.quantity = 999; // what the caller was handed

    const after = await provider.getOrders();
    assert.equal(after.length, seedOrders.length + 1);
    assert.equal(after[after.length - 1]!.items[0]!.quantity, 1);
  });
});

describe("durability", () => {
  /** Wraps a store and counts saves, so a missing or spurious write is observable. */
  function countingStore(): StateStore & { saves: number } {
    const inner = createMemoryStore();
    const store = {
      description: inner.description,
      load: () => inner.load(),
      save: (state: Parameters<StateStore["save"]>[0]) => {
        store.saves += 1;
        inner.save(state);
      },
      saves: 0,
    };
    return store;
  }

  it("persists an inventory update made outside a transaction", async () => {
    // Regression: only `addOrder` wrote to the store, so a direct inventory
    // change lived in memory and vanished on restart.
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    await provider.updateProductInventory("prod_001", 7);

    assert.equal(store.saves, 1);
    assert.equal(
      store.load()!.products.find((p) => p.id === "prod_001")!.inventoryCount,
      7
    );
  });

  it("writes nothing for a transaction that changes nothing", async () => {
    // A rejected order runs a transaction that mutates nothing and must not
    // leave a state file behind.
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    const result = await provider.transact(() => Promise.resolve("no-op"));

    assert.equal(result, "no-op");
    assert.equal(store.saves, 0);
    assert.equal(store.load(), undefined);
  });

  it("discards everything a throwing transaction did, in memory and on disk", async () => {
    // Regression: a `finally`-based commit saved even when `fn` threw, so a
    // failure halfway through an order wrote the half-applied state to disk —
    // exactly the "silent partial write" the README says is impossible.
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);
    const stockBefore = (await provider.getProductBySku("TCH-AB-001"))!.inventoryCount;

    await assert.rejects(
      provider.transact(async (p) => {
        await p.updateProductInventory("prod_001", 1); // mutates + bumps revision
        await p.addOrder({
          id: "ord_doomed",
          customerName: "Probe",
          items: [{ productId: "prod_001", quantity: 1 }],
          totalAmount: 129.99,
          status: "pending",
          date: "2026-10-03",
        });
        throw new Error("provider failed halfway");
      }),
      /provider failed halfway/
    );

    // Memory restored...
    assert.equal((await provider.getProductBySku("TCH-AB-001"))!.inventoryCount, stockBefore);
    assert.equal((await provider.getOrders()).length, seedOrders.length);
    // ...and nothing was persisted for the failed transaction.
    assert.equal(store.saves, 0);
    assert.equal(store.load(), undefined);
  });

  it("keeps the queue usable after a failed transaction", async () => {
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    await assert.rejects(
      provider.transact(() => Promise.reject(new Error("boom"))),
      /boom/
    );

    // Failures settle the chain rather than poisoning it.
    const after = await provider.transact(async (p) => {
      await p.updateProductInventory("prod_001", 3);
      return "ok";
    });

    assert.equal(after, "ok");
    assert.equal(store.saves, 1);
    assert.equal(
      store.load()!.products.find((p) => p.id === "prod_001")!.inventoryCount,
      3
    );
  });

  it("leaves successful state intact when a later transaction fails", async () => {
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    await provider.transact(async (p) => {
      await p.updateProductInventory("prod_001", 7);
    });

    await assert.rejects(
      provider.transact(async (p) => {
        await p.updateProductInventory("prod_002", 99);
        throw new Error("later failure");
      }),
      /later failure/
    );

    assert.equal(
      store.load()!.products.find((p) => p.id === "prod_001")!.inventoryCount,
      7,
      "the committed transaction survives"
    );
    assert.equal(
      store.load()!.products.find((p) => p.id === "prod_002")!.inventoryCount,
      2,
      "the failed one leaves no trace"
    );
  });

  it("persists exactly once per transaction, not once per line item", async () => {
    const store = countingStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    await provider.transact(async (p) => {
      await p.updateProductInventory("prod_001", 7);
      await p.updateProductInventory("prod_002", 1);
      await p.addOrder({
        id: "ord_bundle",
        customerName: "Probe",
        items: [{ productId: "prod_001", quantity: 1 }],
        totalAmount: 129.99,
        status: "pending",
        date: "2026-10-03",
      });
    });

    assert.equal(store.saves, 1);
  });
});

describe("cross-process freshness", () => {
  /**
   * A store that can be moved behind the provider's back.
   *
   * The token is what a real backend uses to say "someone else committed", and
   * it is deliberately the *only* signal: if a provider reloads on anything else,
   * these tests would still pass, so the token is also counted here.
   */
  function switchableStore(): StateStore & { publish(state: PersistedState): void; reloads: number } {
    const inner = createMemoryStore();
    let state: PersistedState | undefined;
    let token = "0";
    const store = {
      description: inner.description,
      load: () => (state === undefined ? undefined : structuredClone(state)),
      save: (next: PersistedState) => {
        state = structuredClone(next);
      },
      changeToken: () => token,
      publish: (next: PersistedState) => {
        state = structuredClone(next);
        token = String(Number(token) + 1);
      },
      reloads: 0,
    };
    const counted = store.load;
    store.load = () => {
      store.reloads += 1;
      return counted();
    };
    return store;
  }

  it("picks up another process's commit on the next read", async () => {
    const store = switchableStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);
    assert.equal((await provider.getProductBySku("TCH-AB-001"))!.inventoryCount, 42);

    store.publish({
      version: 1,
      products: seedProducts.map((p) => (p.id === "prod_001" ? { ...p, inventoryCount: 5 } : p)),
      orders: seedOrders,
    });

    assert.equal(
      (await provider.getProductBySku("TCH-AB-001"))!.inventoryCount,
      5,
      "a read must not serve the copy this process started with"
    );
  });

  it("does not re-read the store when nothing changed", async () => {
    const store = switchableStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);
    await provider.getProducts();
    const reloadsAfterStartup = store.reloads;

    await provider.getProducts();
    await provider.getOrders();
    await provider.getProductBySku("TCH-AB-001");

    assert.equal(
      store.reloads,
      reloadsAfterStartup,
      "an unchanged token must not cost a full reload on every read"
    );
  });

  it("never reloads over a transaction that has not committed yet", async () => {
    // A read issued while a transaction is mid-flight is in a different async
    // context, so `transactionContext` cannot protect it — the in-flight counter
    // is what stops the reload from discarding the uncommitted state.
    const store = switchableStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    const seen: number[] = [];
    await provider.transact(async (p) => {
      await p.updateProductInventory("prod_001", 7);
      // Another process commits while this transaction is open.
      store.publish({
        version: 1,
        products: seedProducts.map((s) => (s.id === "prod_001" ? { ...s, inventoryCount: 99 } : s)),
        orders: seedOrders,
      });
      seen.push((await p.getProductBySku("TCH-AB-001"))!.inventoryCount);
    });

    assert.deepEqual(seen, [7], "the transaction must keep seeing its own uncommitted value");
  });

  it("sees the other process's commit once the transaction is over", async () => {
    const store = switchableStore();
    const provider = new MockDataProvider(seedProducts, seedOrders, store);

    await provider.transact(async (p) => {
      store.publish({
        version: 1,
        products: seedProducts.map((s) => (s.id === "prod_001" ? { ...s, inventoryCount: 99 } : s)),
        orders: seedOrders,
      });
      await p.getProductBySku("TCH-AB-001");
    });

    assert.equal(
      (await provider.getProductBySku("TCH-AB-001"))!.inventoryCount,
      99,
      "the deferral must end with the transaction, not disable freshness"
    );
  });

  it("keeps serving its own copy when the store cannot report a change token", async () => {
    // A deliberately token-less store: `changeToken` is optional on the
    // contract, and a backend that cannot detect another writer must keep the
    // behaviour this project always had rather than re-reading on every call.
    let state: PersistedState | undefined;
    const tokenless: StateStore = {
      description: "tokenless test store",
      load: () => (state === undefined ? undefined : structuredClone(state)),
      save: (next) => {
        state = structuredClone(next);
      },
    };
    assert.equal(tokenless.changeToken, undefined, "this store must not report a token");

    const provider = new MockDataProvider(seedProducts, seedOrders, tokenless);
    tokenless.save({
      version: 1,
      products: seedProducts.map((p) => ({ ...p, inventoryCount: 1 })),
      orders: seedOrders,
    });

    assert.equal(
      (await provider.getProductBySku("TCH-AB-001"))!.inventoryCount,
      42,
      "without a token the provider must not reload, and so keeps serving its own copy"
    );
  });
});
