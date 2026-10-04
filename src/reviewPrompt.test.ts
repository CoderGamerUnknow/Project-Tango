import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderWeeklyReview } from "./reviewPrompt.js";
import { TOOL } from "./toolNames.js";

/**
 * The rendered review, asserted directly — see `tools.test.ts` for the same
 * checks through a live session, and `server.test.ts` for the registration
 * that serves it.
 */
describe("renderWeeklyReview", () => {
  it("sequences the analytics tools with their exact empty arguments", () => {
    const text = renderWeeklyReview({});

    const positions = [TOOL.lowStockAlerts, TOOL.restockPredictor, TOOL.salesMetrics].map((t) =>
      text.indexOf(`\`${t}\``)
    );
    assert.ok(positions.every((p) => p >= 0), `missing step in: ${text}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));

    // Unscoped, no catalog listing is needed and no scope is claimed.
    assert.doesNotMatch(text, new RegExp(TOOL.listAllProducts));
    assert.doesNotMatch(text, /Scope:/);
    assert.match(text, /`get_low_stock_alerts` \{\}/);
  });

  it("gives every step the category when scoped — including all three analytics tools", () => {
    const text = renderWeeklyReview({ category: "tech" });

    assert.match(text, /in the "tech" category/);
    for (const tool of [
      TOOL.listAllProducts,
      TOOL.lowStockAlerts,
      TOOL.restockPredictor,
      TOOL.salesMetrics,
    ]) {
      assert.ok(
        text.includes(`\`${tool}\` {"category":"tech"}`),
        `${tool} must receive the category argument`
      );
    }

    // The scope note states the truth now that every step is scoped, and the
    // old disclaimer (and the gap it apologized for) is gone.
    assert.match(text, /every step below is filtered to the "tech" category/);
    assert.doesNotMatch(text, /only step 1/i);
    assert.doesNotMatch(text, /whole catalog/i);
  });

  it("treats a blank category as no category at all", () => {
    const text = renderWeeklyReview({ category: "   " });

    // Not a trace of scoping: no title fragment, no note, no arguments.
    assert.doesNotMatch(text, /category/);
    assert.doesNotMatch(text, /Scope:/);
    assert.match(text, /`get_low_stock_alerts` \{\}/);
    assert.doesNotMatch(text, new RegExp(TOOL.listAllProducts));
  });

  it("keeps the reporting contract a dump would not have", () => {
    const text = renderWeeklyReview({});

    assert.match(text, /Call these tools in order, with these arguments/);
    assert.match(text, /days of cover/);
    assert.match(text, /recommended reorder quantity/);
    assert.match(text, /rising or falling/);
    assert.match(text, /stated plainly rather than guessed/);
  });
});
