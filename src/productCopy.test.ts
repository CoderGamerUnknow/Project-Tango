import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildProductCopy } from "./productCopy.js";
import { makeProduct } from "./testHelpers.js";

/**
 * Marketing copy generation and its per-tag voice selection.
 */

describe("buildProductCopy", () => {
  it("uses the category-specific voice", () => {
    const copy = buildProductCopy(
      makeProduct({ id: "p1", category: "home", name: "Kettle" }),
      3
    );
    assert.ok(copy.copy.headline.includes("everyday rituals"));
  });

  it("falls back to a generic voice for an unknown category", () => {
    const copy = buildProductCopy(makeProduct({ id: "p1", category: "garden" }), 3);
    assert.ok(copy.copy.headline.includes("built with care"));
  });

  it("flags low stock in the bullet points", () => {
    const scarce = buildProductCopy(makeProduct({ id: "p1", inventoryCount: 1 }), 3);
    const healthy = buildProductCopy(makeProduct({ id: "p2", inventoryCount: 30 }), 3);

    assert.ok(scarce.copy.bulletPoints.some((b) => b.includes("Limited stock")));
    assert.ok(healthy.copy.bulletPoints.some((b) => b.includes("In stock")));
  });

  it("de-duplicates SEO tags", () => {
    const copy = buildProductCopy(
      makeProduct({ id: "p1", category: "tech", name: "Widget", tags: ["tech", "gadget", "tech"] }),
      3
    );

    assert.equal(new Set(copy.seoTags).size, copy.seoTags.length);
    assert.ok(copy.seoTags.includes("gadget"));
    assert.ok(copy.seoTags.includes("widget"));
  });

  it("gives two products in the same category different copy", () => {
    // Regression: every tech product used to get the identical voice string,
    // so the copy differed only where the product name was spliced in.
    const earbuds = buildProductCopy(
      makeProduct({ id: "p1", name: "AeroBuds", category: "tech", tags: ["audio", "noise-cancelling"] }),
      3
    );
    const keyboard = buildProductCopy(
      makeProduct({ id: "p2", name: "TypeCraft", category: "tech", tags: ["mechanical", "hot-swappable"] }),
      3
    );

    assert.notEqual(earbuds.copy.headline, keyboard.copy.headline);
    assert.notEqual(earbuds.copy.longDescription, keyboard.copy.longDescription);
    assert.match(earbuds.copy.headline, /commute/);
    assert.match(keyboard.copy.headline, /keystroke/);
  });

  it("uses each tag fragment once — in the headline or the body, never both", () => {
    const copy = buildProductCopy(
      makeProduct({
        id: "p1",
        name: "AeroBuds",
        category: "tech",
        tags: ["audio", "wireless", "noise-cancelling"],
      }),
      3
    );

    const headlineFragment = "tuned for the commute";
    assert.ok(copy.copy.headline.includes(headlineFragment));
    assert.ok(
      !copy.copy.longDescription.includes(headlineFragment),
      "the headline's fragment must not be echoed in the body"
    );
    // The remaining fragments do appear in the body, capitalised as sentences.
    assert.match(copy.copy.longDescription, /With no cable to snag/);
    assert.match(copy.copy.longDescription, /So the open-plan office/);
    // Category voice is retained for the sentence that introduces it.
    assert.match(copy.copy.longDescription, /is engineered for people/);
  });

  it("skips the tag clause when no tag has a fragment, rather than inventing one", () => {
    const copy = buildProductCopy(
      makeProduct({ id: "p1", name: "Mystery", category: "tech", tags: ["gadget", "thingamajig"] }),
      3
    );

    assert.ok(copy.copy.headline.includes("engineered for people"));
    assert.ok(copy.copy.longDescription.endsWith("not just a place in your cart."));
    assert.ok(!copy.copy.longDescription.includes("undefined"));
  });
});
