import type { Order, Product } from "./types.js";
import { seedProducts } from "./seedCatalog.js";

/**
 * ---------------------------------------------------------------------------
 * Order history
 * ---------------------------------------------------------------------------
 * Generated rather than hand-written, for two reasons.
 *
 * Volume: `smart_restock_predictor` divides units sold by a 30-day denominator
 * and projects across a 21-day supply window. With only a handful of hand-listed
 * orders that works out to ~0.03 units/day, so nearly every product recommends a
 * reorder of 0 or 1 and the tool demonstrates nothing. The generated history
 * puts each product's velocity in a range where the recommendation is an actual
 * decision an operator could act on.
 *
 * Consistency: `totalAmount` is computed from live catalog prices rather than
 * hard-coded, so an order can never drift out of sync with its line items if a
 * price is edited.
 *
 * The generator is a seeded LCG, so the dataset is byte-identical on every run
 * and tests can assert exact figures rather than loose ranges.
 */
const MS_PER_DAY = 86_400_000;

/**
 * Relative demand weight per product id.
 *
 * The six deliberately under-stocked items carry the highest weights, so they
 * also carry the strongest recent sales. That is the whole point of the seed
 * data: it reproduces the real failure mode where an item is both popular and
 * running out, which is exactly what the restock predictor exists to catch.
 *
 * This lives here rather than in `seedCatalog.ts` because it is an input to the
 * order generator, not a property of a product — the catalog stays a plain list
 * of products with no generator tuning mixed in.
 */
const DEMAND_WEIGHT: Record<string, number> = {
  prod_001: 7, // AeroBuds — healthy stock
  prod_002: 9, // PulseFit watch — critical
  prod_003: 6, // SSD — healthy
  prod_004: 10, // Keyboard — sold out
  prod_005: 5, // Webcam — healthy
  prod_006: 9, // Merino sweater — critical
  prod_007: 5, // Denim jacket — healthy
  prod_008: 9, // Running shoes — low
  prod_009: 6, // Cotton tees — healthy
  prod_010: 4, // Pour-over set — healthy
  prod_011: 9, // Dutch oven — critical
  prod_012: 4, // Linen throw — healthy
  prod_013: 8, // Diffuser — low
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Deterministic 32-bit LCG — same seed, same sequence, every run. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const CUSTOMER_NAMES = [
  "Maya Chen", "Daniel Osei", "Priya Ramanathan", "Lucas Ferreira", "Sofia Kowalski",
  "Amara Diallo", "Tomas Novak", "Ingrid Larsen", "Hiro Tanaka", "Elena Rossi",
  "Kwame Mensah", "Sofia Alvarez", "Yusuf Demir", "Freya Lindqvist", "Rohan Kapoor",
  "Chloe Dubois", "Nikolai Petrov", "Aisha Rahman", "Marco Bianchi", "Leah Goldberg",
] as const;
const SALES_HISTORY_DAYS = 30;

function generateOrders(catalog: Product[], seed: number): Order[] {
  const random = createRandom(seed);
  // Priced from the catalog passed in, not the module-level seed: taking the
  // catalog for line items but the seed for prices would silently generate
  // orders at stale prices the moment a caller passed a different catalog.
  const priceById = new Map(catalog.map((p) => [p.id, p.price]));

  // Weighted product pool, expanded once so sampling is a simple index lookup.
  const weightedIds = catalog.flatMap((p) =>
    Array.from({ length: DEMAND_WEIGHT[p.id] ?? 1 }, () => p.id)
  );

  const pickProductId = (): string =>
    weightedIds[Math.floor(random() * weightedIds.length)] ?? "prod_001";

  const pickStatus = (daysBack: number): Order["status"] => {
    const roll = random();
    // Recent orders skew pending/shipped; older ones have settled as delivered.
    if (daysBack <= 3) return roll < 0.6 ? "pending" : "shipped";
    if (daysBack <= 10) return roll < 0.35 ? "pending" : roll < 0.7 ? "shipped" : "delivered";
    return roll < 0.12 ? "shipped" : "delivered";
  };

  const generated: Order[] = [];
  let sequence = 1000;

  for (let daysBack = SALES_HISTORY_DAYS - 1; daysBack >= 0; daysBack--) {
    // 3-5 orders a day, trending slightly busier toward the present.
    const ordersToday = 3 + Math.floor(random() * 3) + (daysBack < 10 ? 1 : 0);

    for (let n = 0; n < ordersToday; n++) {
      const lineCount = 1 + Math.floor(random() * 3);
      const items = Array.from({ length: lineCount }, () => ({
        productId: pickProductId(),
        quantity: 1 + Math.floor(random() * 3),
      }));

      const totalAmount =
        Math.round(
          items.reduce(
            (sum, item) => sum + (priceById.get(item.productId) ?? 0) * item.quantity,
            0
          ) * 100
        ) / 100;

      generated.push({
        id: `ord_${++sequence}`,
        customerName: CUSTOMER_NAMES[Math.floor(random() * CUSTOMER_NAMES.length)] ?? "Guest",
        items,
        totalAmount,
        status: pickStatus(daysBack),
        date: daysAgo(daysBack),
      });
    }
  }

  return generated;
}

/** Seed order history, regenerated deterministically on every run. */
export const seedOrders: Order[] = generateOrders(seedProducts, 20261003);
