import type { DataProvider, Order, OrderItem, Product } from "./types.js";

// ---------------------------------------------------------------------------
// Deep-clone helpers — every read method returns copies so that callers
// cannot mutate the provider's internal state through live references.
// ---------------------------------------------------------------------------

function cloneProduct(p: Product): Product {
  return {
    ...p,
    tags: [...p.tags],
  };
}

function cloneOrder(o: Order): Order {
  return {
    ...o,
    items: o.items.map((i): OrderItem => ({ ...i })),
  };
}

/**
 * A rich, realistic starter catalog spanning tech, apparel, and home goods.
 *
 * Several items are deliberately seeded with critically low stock
 * (inventoryCount < 3) so that `get_low_stock_alerts` and
 * `smart_restock_predictor` have real signal to work with out of the box.
 */
const products: Product[] = [
  {
    id: "prod_001",
    name: "AeroBuds Pro Wireless Earbuds",
    sku: "TCH-AB-001",
    price: 129.99,
    inventoryCount: 42,
    category: "tech",
    tags: ["audio", "wireless", "bluetooth", "noise-cancelling"],
    description: "Active noise-cancelling wireless earbuds with 30-hour total battery life.",
  },
  {
    id: "prod_002",
    name: "PulseFit Smart Watch Series 4",
    sku: "TCH-PF-004",
    price: 249.0,
    inventoryCount: 2,
    category: "tech",
    tags: ["wearable", "fitness", "health-tracking", "gps"],
    description: "GPS-enabled fitness watch with heart-rate, SpO2, and sleep tracking.",
  },
  {
    id: "prod_003",
    name: "DataVault Portable SSD 1TB",
    sku: "TCH-DV-1TB",
    price: 89.5,
    inventoryCount: 15,
    category: "tech",
    tags: ["storage", "usb-c", "portable"],
    description: "Rugged 1TB portable SSD with USB-C and read speeds up to 1050MB/s.",
  },
  {
    id: "prod_004",
    name: "TypeCraft Mechanical Keyboard",
    sku: "TCH-TC-KB2",
    price: 149.0,
    inventoryCount: 0,
    category: "tech",
    tags: ["peripherals", "mechanical", "hot-swappable"],
    description: "Hot-swappable mechanical keyboard with per-key RGB and tactile brown switches.",
  },
  {
    id: "prod_005",
    name: "ClearView 4K Webcam",
    sku: "TCH-CV-4K1",
    price: 79.99,
    inventoryCount: 23,
    category: "tech",
    tags: ["video", "streaming", "4k"],
    description: "4K UHD webcam with auto-focus and a built-in privacy shutter.",
  },
  {
    id: "prod_006",
    name: "Highland Merino Wool Sweater",
    sku: "APL-HM-SWT",
    price: 98.0,
    inventoryCount: 1,
    category: "apparel",
    tags: ["wool", "outerwear", "winter"],
    description: "Ethically sourced 100% merino wool sweater, machine washable.",
  },
  {
    id: "prod_007",
    name: "Ironclad Classic Denim Jacket",
    sku: "APL-IC-DNJ",
    price: 84.0,
    inventoryCount: 18,
    category: "apparel",
    tags: ["denim", "outerwear", "casual"],
    description: "Timeless straight-cut denim jacket in stonewash indigo.",
  },
  {
    id: "prod_008",
    name: "Stridewell Performance Running Shoes",
    sku: "APL-SW-RUN",
    price: 112.5,
    inventoryCount: 4,
    category: "apparel",
    tags: ["footwear", "running", "athletic"],
    description: "Lightweight running shoes with responsive foam midsole and breathable mesh upper.",
  },
  {
    id: "prod_009",
    name: "PureLoom Organic Cotton Tee (3-Pack)",
    sku: "APL-PL-TEE3",
    price: 39.99,
    inventoryCount: 60,
    category: "apparel",
    tags: ["cotton", "basics", "organic"],
    description: "Certified organic cotton crew-neck tees, pack of three, pre-shrunk.",
  },
  {
    id: "prod_010",
    name: "Solstice Ceramic Pour-Over Coffee Set",
    sku: "HOM-SC-POS",
    price: 54.0,
    inventoryCount: 9,
    category: "home",
    tags: ["kitchen", "coffee", "ceramic"],
    description: "Hand-glazed ceramic pour-over dripper with matching 500ml carafe.",
  },
  {
    id: "prod_011",
    name: "Hearthstone Enameled Cast Iron Dutch Oven",
    sku: "HOM-HS-DO6",
    price: 139.0,
    inventoryCount: 2,
    category: "home",
    tags: ["kitchen", "cookware", "cast-iron"],
    description: "6-quart enameled cast iron dutch oven, oven-safe to 500°F.",
  },
  {
    id: "prod_012",
    name: "Driftwood Linen Throw Blanket",
    sku: "HOM-DW-LTB",
    price: 64.0,
    inventoryCount: 27,
    category: "home",
    tags: ["textiles", "linen", "living-room"],
    description: "Stonewashed 100% linen throw blanket, 50x60 inches.",
  },
  {
    id: "prod_013",
    name: "Vaporly Ultrasonic Aromatherapy Diffuser",
    sku: "HOM-VP-AD2",
    price: 45.5,
    inventoryCount: 3,
    category: "home",
    tags: ["wellness", "aromatherapy", "electronics"],
    description: "Whisper-quiet ultrasonic diffuser with 7-color ambient LED ring.",
  },
];

/**
 * Five recent orders referencing the catalog above. Quantities here drive
 * `analyze_sales_metrics` and the demand-velocity math in
 * `smart_restock_predictor`, so the low-stock items above have real,
 * traceable sales history rather than arbitrary numbers.
 */
const orders: Order[] = [
  {
    id: "ord_1001",
    customerName: "Maya Chen",
    items: [
      { productId: "prod_002", quantity: 1 },
      { productId: "prod_001", quantity: 1 },
    ],
    totalAmount: 378.99,
    status: "delivered",
    date: "2026-06-14",
  },
  {
    id: "ord_1002",
    customerName: "Daniel Osei",
    items: [
      { productId: "prod_006", quantity: 2 },
      { productId: "prod_009", quantity: 1 },
    ],
    totalAmount: 235.99,
    status: "delivered",
    date: "2026-06-20",
  },
  {
    id: "ord_1003",
    customerName: "Priya Ramanathan",
    items: [
      { productId: "prod_004", quantity: 1 },
      { productId: "prod_005", quantity: 1 },
    ],
    totalAmount: 228.99,
    status: "shipped",
    date: "2026-06-28",
  },
  {
    id: "ord_1004",
    customerName: "Lucas Ferreira",
    items: [
      { productId: "prod_011", quantity: 1 },
      { productId: "prod_010", quantity: 1 },
      { productId: "prod_013", quantity: 1 },
    ],
    totalAmount: 238.5,
    status: "pending",
    date: "2026-07-02",
  },
  {
    id: "ord_1005",
    customerName: "Sofia Kowalski",
    items: [
      { productId: "prod_008", quantity: 2 },
      { productId: "prod_002", quantity: 1 },
    ],
    totalAmount: 474.0,
    status: "pending",
    date: "2026-07-06",
  },
];

/**
 * In-memory, mutable implementation of `DataProvider`.
 *
 * This is the "instant, zero-configuration" half of the mock-to-real
 * pipeline: every tool in src/index.ts is written against the `DataProvider`
 * interface, so replacing `mockDataProvider` with a `ShopifyDataProvider` /
 * `StripeDataProvider` that talks to real APIs requires no changes to tool
 * logic — only a new class implementing the same 6 methods.
 */
class MockDataProvider implements DataProvider {
  private products: Product[];
  private orders: Order[];

  constructor(seedProducts: Product[], seedOrders: Order[]) {
    // Deep-copy the seed data so mutations from simulate_order_placement
    // never leak back into the module-level constants above.
    this.products = seedProducts.map((p) => ({ ...p, tags: [...p.tags] }));
    this.orders = seedOrders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
  }

  async getProducts(): Promise<Product[]> {
    return this.products.map(cloneProduct);
  }

  async getOrders(): Promise<Order[]> {
    return this.orders.map(cloneOrder);
  }

  async getProductById(id: string): Promise<Product | undefined> {
    const found = this.products.find((p) => p.id === id);
    return found ? cloneProduct(found) : undefined;
  }

  async getProductBySku(sku: string): Promise<Product | undefined> {
    const found = this.products.find((p) => p.sku.toLowerCase() === sku.toLowerCase());
    return found ? cloneProduct(found) : undefined;
  }

  async updateProductInventory(id: string, newCount: number): Promise<Product | undefined> {
    const product = this.products.find((p) => p.id === id);
    if (!product) return undefined;
    product.inventoryCount = newCount;
    return cloneProduct(product);
  }

  async addOrder(order: Order): Promise<Order> {
    // Clone before storing so the caller cannot mutate internal state
    // through the original reference after the call returns.
    const stored = cloneOrder(order);
    this.orders.push(stored);
    return stored;
  }
}

/**
 * Singleton mock provider used by default in src/index.ts. Swap this import
 * for a real provider implementation when you're ready to go live — see the
 * `DataProvider` interface in src/types.ts.
 */
export const mockDataProvider: DataProvider = new MockDataProvider(products, orders);
