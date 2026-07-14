/**
 * trie.ts — In-memory prefix trie for near-instant product search.
 *
 * Indexes every normalized token (product name, SKU, category, tags) so
 * prefix searches resolve in O(k) where k = query length, regardless of
 * catalog size. The trie is rebuilt from SQLite on startup and kept in
 * sync via atomic updates.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrieEntry {
  /** IDs of all products that contain the indexed token. */
  productIds: Set<string>;
}

export interface TrieSearchResult {
  productId: string;
  /** The matched token (useful for highlighting). */
  match: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Splits a string into normalized, lower-case search tokens.
 * Handles product names ("AeroBuds Pro"), SKUs ("TCH-AB-001"),
 * categories ("tech"), and tags.
 */
function tokenize(text: string): string[] {
  // Split on whitespace, hyphens, underscores, slashes
  const raw = text.toLowerCase().split(/[\s\-_/]+/);
  return raw.filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Trie Node
// ---------------------------------------------------------------------------

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  /** Product IDs that end at this node (i.e. a complete token). */
  productIds: Set<string> = new Set();
}

// ---------------------------------------------------------------------------
// Prefix Trie
// ---------------------------------------------------------------------------

export class PrefixTrie {
  private root = new TrieNode();
  /** Maps product IDs to the set of tokens they own (for removal). */
  private productTokens = new Map<string, Set<string>>();
  private size = 0;

  // -----------------------------------------------------------------------
  // Mutation
  // -----------------------------------------------------------------------

  /**
   * Index all searchable fields of a product.
   * Call this when a product is added or updated.
   */
  indexProduct(productId: string, name: string, sku: string, category: string, tags: string[]): void {
    // Remove any existing index for this product first
    this.removeProduct(productId);

    const tokens = new Set<string>();

    // Index the full name as a phrase
    const nameTokens = tokenize(name);
    for (const token of nameTokens) {
      tokens.add(token);
      this.insert(token, productId);
    }

    // Index the full name itself as a searchable phrase
    const fullName = name.toLowerCase().trim();
    if (fullName.length > 0) {
      tokens.add(fullName);
      this.insert(fullName, productId);
    }

    // Index SKU
    const skuLower = sku.toLowerCase().trim();
    if (skuLower.length > 0) {
      tokens.add(skuLower);
      this.insert(skuLower, productId);
      // Also index SKU as individual segments
      const skuParts = skuLower.split(/[-_]/);
      for (const part of skuParts) {
        if (part.length > 0 && !tokens.has(part)) {
          tokens.add(part);
          this.insert(part, productId);
        }
      }
    }

    // Index category
    const catLower = category.toLowerCase().trim();
    if (catLower.length > 0) {
      tokens.add(catLower);
      this.insert(catLower, productId);
    }

    // Index each tag
    for (const tag of tags) {
      const tagLower = tag.toLowerCase().trim();
      if (tagLower.length > 0) {
        tokens.add(tagLower);
        this.insert(tagLower, productId);
        // Also index individual words within multi-word tags
        const tagWords = tokenize(tagLower);
        for (const word of tagWords) {
          if (word.length > 0 && !tokens.has(word)) {
            tokens.add(word);
            this.insert(word, productId);
          }
        }
      }
    }

    this.productTokens.set(productId, tokens);
    this.size++;
  }

  /**
   * Remove all tokens for a product (e.g. when deleted or re-indexing).
   */
  removeProduct(productId: string): void {
    const tokens = this.productTokens.get(productId);
    if (!tokens) return;

    for (const token of tokens) {
      this.remove(token, productId);
    }
    this.productTokens.delete(productId);
    this.size = Math.max(0, this.size - 1);
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  /**
   * Searches for all product IDs whose indexed tokens match the given prefix.
   * Returns results sorted by relevance score (higher = better match).
   */
  search(prefix: string): TrieSearchResult[] {
    if (!prefix || prefix.trim().length === 0) return [];

    const query = prefix.toLowerCase().trim();
    const node = this.traverse(query);
    if (!node) return [];

    // Collect all product IDs from this node and its descendants
    const matches = new Map<string, { productIds: Set<string> }>();
    this.collect(node, query, matches);

    // Flatten into scored results
    const resultMap = new Map<string, { score: number; match: string }>();

    for (const [matchedToken, { productIds }] of matches) {
      // Score: exact prefix match = 100, contains prefix = 50
      const isExact = matchedToken === query;
      const baseScore = isExact ? 100 : 50;

      for (const pid of productIds) {
        const existing = resultMap.get(pid);
        const newScore = (existing?.score ?? 0) + baseScore;
        // Keep the highest-scoring match token for display
        const matchToUse = isExact && !existing
          ? matchedToken
          : (existing?.match ?? matchedToken);
        resultMap.set(pid, { score: newScore, match: matchToUse });
      }
    }

    return [...resultMap.entries()]
      .map(([productId, { score, match }]) => ({ productId, score, match }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Returns all indexed product IDs (for full catalog scans).
   */
  allProductIds(): string[] {
    return [...this.productTokens.keys()];
  }

  /**
   * Number of indexed products.
   */
  get count(): number {
    return this.size;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private insert(token: string, productId: string): void {
    let node = this.root;
    for (const char of token) {
      let child = node.children.get(char);
      if (!child) {
        child = new TrieNode();
        node.children.set(char, child);
      }
      node = child;
    }
    node.productIds.add(productId);
  }

  private remove(token: string, productId: string): void {
    let node = this.root;
    for (const char of token) {
      const child = node.children.get(char);
      if (!child) return;
      node = child;
    }
    node.productIds.delete(productId);
  }

  /**
   * Walk the trie following the prefix characters.
   * Returns the node at the end of the prefix, or undefined if not found.
   */
  private traverse(prefix: string): TrieNode | undefined {
    let node = this.root;
    for (const char of prefix) {
      const child = node.children.get(char);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  /**
   * Recursively collects all product IDs from a node and its descendants.
   */
  private collect(
    node: TrieNode,
    currentPrefix: string,
    results: Map<string, { productIds: Set<string> }>,
  ): void {
    if (node.productIds.size > 0) {
      results.set(currentPrefix, { productIds: node.productIds });
    }
    for (const [char, child] of node.children) {
      this.collect(child, currentPrefix + char, results);
    }
  }

  // -----------------------------------------------------------------------
  // Debug / inspection
  // -----------------------------------------------------------------------

  /** Returns a rough count of nodes in the trie. */
  nodeCount(): number {
    let count = 0;
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      count++;
      for (const child of node.children.values()) {
        stack.push(child);
      }
    }
    return count;
  }
}
