/**
 * Prefix-indexed search ranking.
 *
 * Ported from the `v2.0.0` lineage's `src/trie.ts`, with the scoring decision
 * changed after measuring it. That version replaced substring search with
 * prefix-only matching and called it an improvement; on this catalog it is not:
 * a query for `"tch"` finds 7 products by substring and only 5 by token prefix,
 * because substring matching reaches inside `"tech"` and `"stitch"` while a
 * prefix only matches from the start of a token. Shipping that as a replacement
 * would have silently *reduced* recall to look like a speed-up.
 *
 * So the index here ranks rather than filters. `rankProducts` keeps
 * `filterProducts`' substring recall as the candidate set — nothing that used to
 * match stops matching — and uses the trie purely to order those candidates, so
 * a product whose own token is the query outranks one that merely contains it.
 *
 * The index is built once per catalog and reused across queries; a 13-product
 * catalog is small enough that this is about not scanning, and the trie makes
 * that explicit rather than incidental.
 */

/** A product id, the token that matched it, and how well it matched. */
export interface IndexedMatch {
  productId: string;
  /** The indexed token that matched — useful for explaining a result. */
  match: string;
  score: number;
  /**
   * How closely the query matched, strongest first.
   *
   * Three tiers, because "exact token" alone is not enough to rank sensibly: a
   * product named "Cable" and one named "Cable Management Tray" both carry a
   * `cable` token, so a token-level comparison calls them equally good and then
   * lets the longer name win on accumulated prefix matches. Callers mean the
   * product that is *called* "Cable".
   *
   * - `field` — the query is a whole indexed field (a name, SKU, category or tag).
   * - `token` — the query is one word of a longer field.
   * - `prefix` — the query starts a token but is not one.
   */
  tier: "field" | "token" | "prefix";
}

const TIER_RANK: Record<IndexedMatch["tier"], number> = { field: 2, token: 1, prefix: 0 };

/**
 * Split a field into normalized tokens.
 *
 * Hyphens, underscores, slashes and whitespace all separate tokens, so `"TCH-AB-001"`
 * yields `tch`, `ab`, `001`. This is what makes `"tch"` find the SKU and the
 * category alike.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((t) => t.length > 0);
}

/** A trie node: children per character, plus the products ending here. */
interface TrieNode {
  children: Map<string, TrieNode>;
  productIds: Set<string>;
}

const newNode = (): TrieNode => ({ children: new Map(), productIds: new Set() });

/** A product as far as indexing is concerned. */
export interface IndexableProduct {
  id: string;
  name: string;
  sku: string;
  category: string;
  tags: string[];
}

/**
 * Every token that should be searchable for a product.
 *
 * Both whole fields and their parts are indexed: `"AeroBuds Pro"` is reachable
 * by `aero`, by `pro`, and by the full phrase, which is what lets a caller type
 * any one of those. The SKU contributes both its full form and its segments, so
 * `"tch-ab-001"` and `"001"` both find it.
 */
function tokensFor(product: IndexableProduct): string[] {
  const tokens = new Set<string>();
  const add = (value: string) => {
    const clean = value.toLowerCase().trim();
    if (!clean) return;
    tokens.add(clean);
    for (const part of tokenize(clean)) tokens.add(part);
  };

  add(product.name);
  add(product.sku);
  add(product.category);
  for (const tag of product.tags) add(tag);

  return [...tokens];
}

/**
 * Whole indexed fields for a product: its name, SKU, category and each tag.
 *
 * Kept separate from the token set because a match against one of these is a
 * stronger signal than a match against a word inside one — without the
 * distinction, `"Cable"` and `"Cable Management Tray"` rank equally on the
 * query `cable`, and the longer name then wins on accumulated prefix matches.
 */
function wholeFieldsOf(product: IndexableProduct): string[] {
  return [product.name, product.sku, product.category, ...product.tags]
    .map((v) => v.toLowerCase().trim())
    .filter((v) => v.length > 0);
}

/**
 * An in-memory prefix index over product tokens.
 *
 * Prefix traversal costs O(query length) rather than a scan per field, and the
 * per-product token list is kept alongside so a product can be re-indexed
 * without a full rebuild.
 */
export class ProductIndex {
  private root: TrieNode = newNode();
  private readonly tokensByProduct = new Map<string, string[]>();
  /** Whole indexed fields per product, so "Cable" ranks above "Cable Tray". */
  private readonly fieldsByProduct = new Map<string, Set<string>>();

  constructor(products: IndexableProduct[] = []) {
    for (const product of products) this.index(product);
  }

  /** Index one product, replacing any previous entry for its id. */
  index(product: IndexableProduct): void {
    this.remove(product.id);
    const tokens = tokensFor(product);
    for (const token of tokens) this.insert(token, product.id);
    this.tokensByProduct.set(product.id, tokens);
    this.fieldsByProduct.set(product.id, new Set(wholeFieldsOf(product)));
  }

  /** Drop a product from the index. */
  remove(productId: string): void {
    const tokens = this.tokensByProduct.get(productId);
    if (!tokens) return;
    for (const token of tokens) this.delete(token, productId);
    this.tokensByProduct.delete(productId);
    this.fieldsByProduct.delete(productId);
  }

  /**
   * Prefix matches for `query`, best first.
   *
   * Ranked on match tier first — whole field, then exact token, then prefix —
   * and on breadth of match within a tier. This is a ranking signal, not a
   * filter: callers still decide the candidate set, so a product that only
   * matches mid-token is never dropped.
   */
  search(query: string): IndexedMatch[] {
    const clean = query.toLowerCase().trim();
    if (!clean) return [];

    const node = this.traverse(clean);
    if (!node) return [];

    // Subtree walk from the query node: every token at or below it is a match.
    const scores = new Map<string, { score: number; match: string; tier: IndexedMatch["tier"] }>();
    const stack: Array<{ node: TrieNode; prefix: string }> = [{ node, prefix: clean }];
    while (stack.length > 0) {
      const { node: current, prefix } = stack.pop()!;
      const isQuery = prefix === clean;
      for (const productId of current.productIds) {
        const existing = scores.get(productId);
        const score = (existing?.score ?? 0) + (isQuery ? 100 : 50);
        const match = isQuery ? prefix : (existing?.match ?? prefix);
        // A whole-field match is the strongest signal, so it is never demoted
        // by a longer prefix match discovered later in the walk.
        const tier = this.fieldsByProduct.get(productId)?.has(clean)
          ? "field"
          : isQuery
            ? "token"
            : "prefix";
        const best = existing && TIER_RANK[existing.tier] > TIER_RANK[tier] ? existing.tier : tier;
        scores.set(productId, { score, match, tier: best });
      }
      for (const [char, child] of current.children) {
        stack.push({ node: child, prefix: prefix + char });
      }
    }

    return [...scores.entries()]
      .map(([productId, { score, match, tier }]) => ({ productId, score, match, tier }))
      .sort((a, b) => {
        if (a.tier !== b.tier) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
        if (a.score !== b.score) return b.score - a.score;
        // Product id breaks ties so ranking is deterministic across runs — a
        // tie that resolved by Map insertion order would make output order
        // depend on the order products happened to be added.
        return a.productId.localeCompare(b.productId);
      });
  }

  /** Number of indexed products. */
  get size(): number {
    return this.tokensByProduct.size;
  }

  private insert(token: string, productId: string): void {
    let node = this.root;
    for (const char of token) {
      let child = node.children.get(char);
      if (!child) {
        child = newNode();
        node.children.set(char, child);
      }
      node = child;
    }
    node.productIds.add(productId);
  }

  private delete(token: string, productId: string): void {
    let node = this.root;
    for (const char of token) {
      const child = node.children.get(char);
      if (!child) return;
      node = child;
    }
    node.productIds.delete(productId);
  }

  private traverse(prefix: string): TrieNode | undefined {
    let node: TrieNode = this.root;
    for (const char of prefix) {
      const child = node.children.get(char);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }
}