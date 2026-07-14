/**
 * database.ts — SQLite connection, schema, and data access layer.
 *
 * Implements the persistence half of the hybrid storage engine.
 * All writes go through SQLite; the in-memory trie is rebuilt from
 * this database on startup.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Order, OrderStatus, Product } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sku           TEXT NOT NULL UNIQUE,
  price         REAL NOT NULL,
  inventory_count INTEGER NOT NULL DEFAULT 0,
  category      TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  description   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  total_amount  REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','shipped','delivered')),
  date          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK(quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
`;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

interface SeedProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  inventoryCount: number;
  category: string;
  tags: string[];
  description: string;
}

interface SeedOrder {
  id: string;
  customerName: string;
  items: { productId: string; quantity: number }[];
  totalAmount: number;
  status: OrderStatus;
  date: string;
}

const SEED_PRODUCTS: SeedProduct[] = [
  { id: "prod_001", name: "AeroBuds Pro Wireless Earbuds",               sku: "TCH-AB-001",  price: 129.99, inventoryCount: 42, category: "tech",    tags: ["audio","wireless","bluetooth","noise-cancelling"],         description: "Active noise-cancelling wireless earbuds with 30-hour total battery life." },
  { id: "prod_002", name: "PulseFit Smart Watch Series 4",               sku: "TCH-PF-004",  price: 249.0,  inventoryCount: 2,  category: "tech",    tags: ["wearable","fitness","health-tracking","gps"],               description: "GPS-enabled fitness watch with heart-rate, SpO2, and sleep tracking." },
  { id: "prod_003", name: "DataVault Portable SSD 1TB",                  sku: "TCH-DV-1TB",  price: 89.5,   inventoryCount: 15, category: "tech",    tags: ["storage","usb-c","portable"],                               description: "Rugged 1TB portable SSD with USB-C and read speeds up to 1050MB/s." },
  { id: "prod_004", name: "TypeCraft Mechanical Keyboard",               sku: "TCH-TC-KB2",  price: 149.0,  inventoryCount: 0,  category: "tech",    tags: ["peripherals","mechanical","hot-swappable"],                  description: "Hot-swappable mechanical keyboard with per-key RGB and tactile brown switches." },
  { id: "prod_005", name: "ClearView 4K Webcam",                         sku: "TCH-CV-4K1",  price: 79.99,  inventoryCount: 23, category: "tech",    tags: ["video","streaming","4k"],                                    description: "4K UHD webcam with auto-focus and a built-in privacy shutter." },
  { id: "prod_006", name: "Highland Merino Wool Sweater",                sku: "APL-HM-SWT",  price: 98.0,   inventoryCount: 3,  category: "apparel", tags: ["wool","outerwear","winter"],                                 description: "Ethically sourced 100% merino wool sweater, machine washable." },
  { id: "prod_007", name: "Ironclad Classic Denim Jacket",               sku: "APL-IC-DNJ",  price: 84.0,   inventoryCount: 18, category: "apparel", tags: ["denim","outerwear","casual"],                                 description: "Timeless straight-cut denim jacket in stonewash indigo." },
  { id: "prod_008", name: "Stridewell Performance Running Shoes",        sku: "APL-SW-RUN",  price: 112.5,  inventoryCount: 4,  category: "apparel", tags: ["footwear","running","athletic"],                               description: "Lightweight running shoes with responsive foam midsole and breathable mesh upper." },
  { id: "prod_009", name: "PureLoom Organic Cotton Tee (3-Pack)",        sku: "APL-PL-TEE3", price: 39.99,  inventoryCount: 60, category: "apparel", tags: ["cotton","basics","organic"],                                  description: "Certified organic cotton crew-neck tees, pack of three, pre-shrunk." },
  { id: "prod_010", name: "Solstice Ceramic Pour-Over Coffee Set",       sku: "HOM-SC-POS",  price: 54.0,   inventoryCount: 9,  category: "home",    tags: ["kitchen","coffee","ceramic"],                                 description: "Hand-glazed ceramic pour-over dripper with matching 500ml carafe." },
  { id: "prod_011", name: "Hearthstone Enameled Cast Iron Dutch Oven",   sku: "HOM-HS-DO6",  price: 139.0,  inventoryCount: 2,  category: "home",    tags: ["kitchen","cookware","cast-iron"],                             description: "6-quart enameled cast iron dutch oven, oven-safe to 500°F." },
  { id: "prod_012", name: "Driftwood Linen Throw Blanket",               sku: "HOM-DW-LTB",  price: 64.0,   inventoryCount: 27, category: "home",    tags: ["textiles","linen","living-room"],                              description: "Stonewashed 100% linen throw blanket, 50x60 inches." },
  { id: "prod_013", name: "Vaporly Ultrasonic Aromatherapy Diffuser",    sku: "HOM-VP-AD2",  price: 45.5,   inventoryCount: 3,  category: "home",    tags: ["wellness","aromatherapy","electronics"],                       description: "Whisper-quiet ultrasonic diffuser with 7-color ambient LED ring." },
];

const SEED_ORDERS: SeedOrder[] = [
  { id: "ord_1001", customerName: "Maya Chen",        items: [{ productId: "prod_002", quantity: 1 }, { productId: "prod_001", quantity: 1 }], totalAmount: 378.99, status: "delivered", date: "2026-06-14" },
  { id: "ord_1002", customerName: "Daniel Osei",       items: [{ productId: "prod_006", quantity: 1 }, { productId: "prod_009", quantity: 1 }], totalAmount: 137.99, status: "delivered", date: "2026-06-20" },
  { id: "ord_1003", customerName: "Priya Ramanathan",  items: [{ productId: "prod_004", quantity: 1 }, { productId: "prod_005", quantity: 1 }], totalAmount: 228.99, status: "shipped",   date: "2026-06-28" },
  { id: "ord_1004", customerName: "Lucas Ferreira",    items: [{ productId: "prod_011", quantity: 1 }, { productId: "prod_010", quantity: 1 }, { productId: "prod_013", quantity: 1 }], totalAmount: 238.5,  status: "pending",   date: "2026-07-02" },
  { id: "ord_1005", customerName: "Sofia Kowalski",    items: [{ productId: "prod_008", quantity: 2 }, { productId: "prod_002", quantity: 1 }], totalAmount: 474.0,  status: "pending",   date: "2026-07-06" },
];

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const DB_DIR = path.resolve(process.cwd(), ".tango");
const DB_PATH = path.join(DB_DIR, "store.db");

let _db: Database.Database | null = null;

/**
 * Returns the singleton SQLite connection, creating it on first call.
 */
export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");    // faster concurrent reads
    _db.pragma("foreign_keys = ON");
    _db.pragma("busy_timeout = 5000");
    _db.exec(SCHEMA_SQL);
  }
  return _db;
}

/**
 * Closes the database connection (for graceful shutdown).
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Migrations (idempotent seed)
// ---------------------------------------------------------------------------

/**
 * Seeds the database with starter data if the products table is empty.
 * Safe to call on every startup — it's a no-op if data already exists.
 */
export function seedIfEmpty(): void {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM products").get() as { cnt: number };
  if (row.cnt > 0) return;

  const insertProduct = db.prepare(
    "INSERT INTO products (id, name, sku, price, inventory_count, category, tags, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, customer_name, total_amount, status, date) VALUES (?, ?, ?, ?, ?)",
  );
  const insertItem = db.prepare(
    "INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)",
  );

  const seed = db.transaction(() => {
    for (const p of SEED_PRODUCTS) {
      insertProduct.run(p.id, p.name, p.sku, p.price, p.inventoryCount, p.category, JSON.stringify(p.tags), p.description);
    }
    for (const o of SEED_ORDERS) {
      insertOrder.run(o.id, o.customerName, o.totalAmount, o.status, o.date);
      for (const item of o.items) {
        insertItem.run(o.id, item.productId, item.quantity);
      }
    }
  });

  seed();
  console.error(`Seeded database: ${SEED_PRODUCTS.length} products, ${SEED_ORDERS.length} orders`);
}

// ---------------------------------------------------------------------------
// Queries — Products
// ---------------------------------------------------------------------------

export function getAllProducts(): Product[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM products").all() as Array<{
    id: string;
    name: string;
    sku: string;
    price: number;
    inventory_count: number;
    category: string;
    tags: string;
    description: string;
  }>;
  return rows.map(rowToProduct);
}

export function getProductById(id: string): Product | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProduct(row as Parameters<typeof rowToProduct>[0]) : undefined;
}

export function getProductBySku(sku: string): Product | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM products WHERE LOWER(sku) = LOWER(?)").get(sku) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProduct(row as Parameters<typeof rowToProduct>[0]) : undefined;
}

export function updateProductInventory(id: string, newCount: number): Product | undefined {
  const db = getDb();
  db.prepare("UPDATE products SET inventory_count = ? WHERE id = ?").run(newCount, id);
  return getProductById(id);
}

// ---------------------------------------------------------------------------
// Queries — Orders
// ---------------------------------------------------------------------------

export function getAllOrders(): Order[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM orders ORDER BY date DESC").all() as Array<{
    id: string;
    customer_name: string;
    total_amount: number;
    status: string;
    date: string;
  }>;
  return rows.map((r) => rowToOrder(r, db));
}

export function addOrder(order: Order): Order {
  const db = getDb();
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, customer_name, total_amount, status, date) VALUES (?, ?, ?, ?, ?)",
  );
  const insertItem = db.prepare(
    "INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)",
  );

  const write = db.transaction(() => {
    insertOrder.run(order.id, order.customerName, order.totalAmount, order.status, order.date);
    for (const item of order.items) {
      insertItem.run(order.id, item.productId, item.quantity);
    }
  });

  write();
  return order;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToProduct(row: {
  id: string;
  name: string;
  sku: string;
  price: number;
  inventory_count: number;
  category: string;
  tags: string;
  description: string;
}): Product {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    price: row.price,
    inventoryCount: row.inventory_count,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    description: row.description,
  };
}

function rowToOrder(
  row: { id: string; customer_name: string; total_amount: number; status: string; date: string },
  db: Database.Database,
): Order {
  const itemRows = db
    .prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?")
    .all(row.id) as Array<{ product_id: string; quantity: number }>;

  return {
    id: row.id,
    customerName: row.customer_name,
    items: itemRows.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
    totalAmount: row.total_amount,
    status: row.status as OrderStatus,
    date: row.date,
  };
}
