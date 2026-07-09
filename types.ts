/**
 * Domain types for Project Tango.
 *
 * These interfaces define the e-commerce data model used across every tool.
 * They are intentionally provider-agnostic: nothing here assumes the data
 * comes from the in-memory mock engine vs. a live Shopify/Stripe integration.
 */

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  inventoryCount: number;
  category: string;
  tags: string[];
  description: string;
}

export interface OrderItem {
  productId: string;
  quantity: number;
}

export type OrderStatus = "pending" | "shipped" | "delivered";

export interface Order {
  id: string;
  customerName: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  /** ISO 8601 date string, e.g. "2026-06-14" */
  date: string;
}

export type AlertSeverity = "low" | "critical";

export interface InventoryAlert {
  productId: string;
  productName: string;
  currentStock: number;
  severity: AlertSeverity;
}

/**
 * DataProvider is the seam between Project Tango's tools and wherever the
 * underlying data actually lives.
 *
 * `MockDataProvider` (src/mockData.ts) implements this against an in-memory
 * dataset so the server works instantly with zero configuration. To go live,
 * implement this same interface against the Shopify Admin API and/or Stripe
 * API (e.g. `ShopifyDataProvider`) and swap the single instantiation in
 * `src/index.ts` — no tool code needs to change.
 */
export interface DataProvider {
  getProducts(): Promise<Product[]>;
  getOrders(): Promise<Order[]>;
  getProductById(id: string): Promise<Product | undefined>;
  getProductBySku(sku: string): Promise<Product | undefined>;
  /** Persists a new absolute inventory count for a product and returns the updated product. */
  updateProductInventory(id: string, newCount: number): Promise<Product | undefined>;
  /** Persists a new order and returns it as stored. */
  addOrder(order: Order): Promise<Order>;
}
