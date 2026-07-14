/**
 * engine.ts — Hybrid Storage Engine (v2.0.0 "Hybrid Engine")
 *
 * Architecture:
 *   SQLite (single source of truth for writes)
 *     └─► Prefix Trie (read-optimized in-memory cache)
 *           └─► Event Broker (reactive MCP notifications)
 *           └─► Saga (auto-rollback on write failures)
 *
 * Every DataProvider method is backed by SQLite, the trie is
 * kept in sync, and the event broker notifies subscribers of
 * state changes.  Writes are wrapped in a saga that can undo
 * partial state if a step fails.
 */

import type { DataProvider, Order, Product } from "./types.js";
import { PrefixTrie, type TrieSearchResult } from "./trie.js";
import {
  getDb,
  getAllProducts,
  getProductById,
  getProductBySku,
  getAllOrders,
  updateProductInventory as dbUpdateInventory,
  addOrder as dbAddOrder,
  seedIfEmpty,
} from "./database.js";

// ---------------------------------------------------------------------------
// Event Broker — Reactive MCP subscriptions
// ---------------------------------------------------------------------------

export type ResourceUri = `tango://${string}`;

export type EventKind =
  | "products:updated"
  | "products:created"
  | "inventory:changed"
  | "orders:created"
  | "orders:status_changed";

export interface EngineEvent {
  kind: EventKind;
  resourceUri: ResourceUri;
  productId?: string;
  orderId?: string;
  timestamp: number;
}

/**
 * Callback type for external consumers (the MCP server uses this
 * to send notifications/resources/updated messages).
 */
export type EventCallback = (event: EngineEvent) => void;

// ---------------------------------------------------------------------------
// Saga — Transaction Rollback
// ---------------------------------------------------------------------------

interface SagaStep {
  description: string;
  rollback: () => void;
}

class Saga {
  private steps: SagaStep[] = [];
  private committed = false;

  addStep(description: string, rollback: () => void): void {
    this.steps.push({ description, rollback });
  }

  commit(): void {
    this.committed = true;
    this.steps = [];
  }

  rollback(): void {
    // Execute rollbacks in reverse order
    for (let i = this.steps.length - 1; i >= 0; i--) {
      try {
        this.steps[i]!.rollback();
      } catch (err) {
        console.error(`Saga rollback failed for step "${this.steps[i]!.description}":`, err);
      }
    }
    this.steps = [];
  }

  get hasPending(): boolean {
    return this.steps.length > 0 && !this.committed;
  }
}

// ---------------------------------------------------------------------------
// HybridEngine
// ---------------------------------------------------------------------------

export class HybridEngine implements DataProvider {
  readonly trie: PrefixTrie;
  private subscribers = new Set<EventCallback>();
  constructor() {
    getDb();
    this.trie = new PrefixTrie();

    // Seed database if empty, then hydrate the trie
    seedIfEmpty();
    this.rebuildTrie();
  }

  // -------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------

  onEvent(cb: EventCallback): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private emit(kind: EventKind, resourceUri: ResourceUri, meta?: { productId?: string; orderId?: string }): void {
    const event: EngineEvent = {
      kind,
      resourceUri,
      timestamp: Date.now(),
      ...meta,
    };
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // subscriber threw — remove it so it doesn't block future events
        this.subscribers.delete(cb);
      }
    }
  }

  // -------------------------------------------------------------------
  // Trie management
  // -------------------------------------------------------------------

  private rebuildTrie(): void {
    const products = getAllProducts();
    for (const p of products) {
      this.trie.indexProduct(p.id, p.name, p.sku, p.category, p.tags);
    }
    console.error(`Trie rebuilt: ${this.trie.count} products indexed`);
  }

  /**
   * Search products by prefix query using the trie. Falls back to the
   * full product list for non-prefix filters (category, price range).
   */
  searchProducts(query: string, maxResults = 20): TrieSearchResult[] {
    return this.trie.search(query).slice(0, maxResults);
  }

  // -------------------------------------------------------------------
  // DataProvider implementation
  // -------------------------------------------------------------------

  async getProducts(): Promise<Product[]> {
    return getAllProducts();
  }

  async getOrders(): Promise<Order[]> {
    return getAllOrders();
  }

  async getProductById(id: string): Promise<Product | undefined> {
    return getProductById(id);
  }

  async getProductBySku(sku: string): Promise<Product | undefined> {
    return getProductBySku(sku);
  }

  async updateProductInventory(id: string, newCount: number): Promise<Product | undefined> {
    const before = await this.getProductById(id);
    if (!before) return undefined;

    // Write to SQLite
    const updated = dbUpdateInventory(id, newCount);
    if (updated) {
      // Sync the trie
      this.trie.removeProduct(id);
      this.trie.indexProduct(updated.id, updated.name, updated.sku, updated.category, updated.tags);
      // Notify subscribers
      this.emit("inventory:changed", `tango://products/${id}` as ResourceUri, { productId: id });
      this.emit("products:updated", "tango://products" as ResourceUri, { productId: id });
    }
    return updated;
  }

  async addOrder(order: Order): Promise<Order> {
    const saga = new Saga();

    // ── Step 1: Reserve inventory ────────────────────────────────────
    const inventoryBefore = new Map<string, number>();
    for (const item of order.items) {
      const product = await this.getProductById(item.productId);
      if (!product) {
        saga.rollback();
        throw new Error(`Product not found: ${item.productId}`);
      }
      if (product.inventoryCount < item.quantity) {
        saga.rollback();
        throw new Error(
          `Insufficient stock for "${product.name}": have ${product.inventoryCount}, need ${item.quantity}`,
        );
      }
      inventoryBefore.set(item.productId, product.inventoryCount);
      saga.addStep(`reserve inventory for ${item.productId}`, () => {
        // Restore inventory in SQLite + trie
        const oldCount = inventoryBefore.get(item.productId);
        if (oldCount !== undefined) {
          dbUpdateInventory(item.productId, oldCount);
          const restored = getProductById(item.productId);
          if (restored) {
            this.trie.removeProduct(restored.id);
            this.trie.indexProduct(restored.id, restored.name, restored.sku, restored.category, restored.tags);
          }
        }
      });
    }

    // ── Step 2: Decrement inventory ──────────────────────────────────
    for (const item of order.items) {
      const product = await this.getProductById(item.productId);
      if (!product) {
        saga.rollback();
        throw new Error(`Product vanished during order: ${item.productId}`);
      }
      const newCount = product.inventoryCount - item.quantity;
      dbUpdateInventory(item.productId, newCount);

      // Sync trie for updated product
      const updated = getProductById(item.productId);
      if (updated) {
        this.trie.removeProduct(updated.id);
        this.trie.indexProduct(updated.id, updated.name, updated.sku, updated.category, updated.tags);
      }
    }

    // ── Step 3: Write order to SQLite ────────────────────────────────
    try {
      dbAddOrder(order);
    } catch (err) {
      saga.rollback();
      throw err;
    }

    // ── Commit the saga ──────────────────────────────────────────────
    saga.commit();

    // Notify subscribers
    this.emit("orders:created", `tango://orders/${order.id}` as ResourceUri, { orderId: order.id });
    this.emit("inventory:changed", "tango://products" as ResourceUri);

    return order;
  }

  // -------------------------------------------------------------------
  // Convenience — product IDs from trie
  // -------------------------------------------------------------------

  /** Returns product IDs matching a search prefix (for the search_products tool). */
  searchProductIds(query: string): string[] {
    return this.searchProducts(query).map((r) => r.productId);
  }

  /** Returns all product IDs from the trie. */
  allProductIds(): string[] {
    return this.trie.allProductIds();
  }

  // -------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.subscribers.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: HybridEngine | null = null;

export function getEngine(): HybridEngine {
  if (!_instance) {
    _instance = new HybridEngine();
  }
  return _instance;
}

export function resetEngine(): void {
  _instance = null;
}
