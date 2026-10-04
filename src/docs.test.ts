import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findOrders, normaliseOrderLookupFilters } from "./orderAnalytics.js";
import { TOOL } from "./toolNames.js";

/**
 * The README, pinned against reality.
 *
 * Documentation drift is a correctness bug the test suite could not see: the
 * test count was stale for several passes, and the dataset figures are exact
 * claims a reader will quote. These tests read the README as text and compare
 * it with the code and data it describes, so a change that invalidates a claim
 * fails here instead of shipping quietly.
 */

// mockData resolves its state store at import time — pin persistence off
// BEFORE it loads (hence the dynamic import below; static imports hoist above
// this line), so no test run can ever touch `~/.project-tango`.
process.env.PROJECT_TANGO_PERSIST = "0";
const { mockDataProvider } = await import("./mockData.js");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("README figures", () => {
  it("quotes the broad-find figures the server actually serves", async () => {
    const claim = readme.match(/`"a"` matches (\d+) of the (\d+) orders, about (\d+) KB of JSON/);
    assert.ok(claim, "README no longer states the broad-find figures (or the wording changed)");

    // claim = [full match, group1, group2, group3]; index 0 maps to NaN but
    // is skipped by the destructuring hole.
    const [, claimedMatches, claimedOrders, claimedKB] = claim.map(Number);

    const products = await mockDataProvider.getProducts();
    const orders = await mockDataProvider.getOrders();
    const result = findOrders(orders, products, normaliseOrderLookupFilters({ customerName: "a" }));

    assert.equal(result.count, claimedMatches, "README's match count no longer matches the dataset");
    assert.equal(orders.length, claimedOrders, "README's dataset size no longer matches the seed");
    assert.equal(
      Math.round(JSON.stringify(result).length / 1024),
      claimedKB,
      "README's payload size no longer matches what the tool returns"
    );
  });

  it("states a test count", () => {
    // The count itself is verified against the runner in CI (the test file
    // cannot count its own suite without circularity); here the claim just has
    // to exist and be plausible, so its removal is caught locally too.
    const claim = readme.match(/^(\d+) tests,/m);
    assert.ok(claim, "README must state how many tests the suite runs");
    assert.ok(Number(claim[1]) >= 100, `implausible test count: ${claim[1]}`);
  });
});

describe("README structure", () => {
  const treeTokens = [...readme.matchAll(/(?:├──|└──)\s+(\S+)/g)].map((m) => m[1]!);

  it("lists files that actually exist", () => {
    assert.ok(treeTokens.length >= 10, "the project-structure tree looks empty");

    for (const token of treeTokens) {
      const clean = token.replace(/\/$/, "");
      if (clean.includes("*")) {
        // Wildcard entries like `*.test.ts` assert a family exists.
        const pattern = new RegExp(
          `^${clean.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
        );
        assert.ok(
          readdirSync(join(ROOT, "src")).some((f) => pattern.test(f)),
          `README lists \`${token}\`, but no file in src/ matches it`
        );
        continue;
      }
      assert.ok(
        existsSync(join(ROOT, clean)) || existsSync(join(ROOT, "src", clean)),
        `README structure lists \`${token}\`, but it does not exist`
      );
    }
  });

  it("lists every module in src/, so new files cannot hide from the docs", () => {
    const listed = new Set(treeTokens);
    const modules = readdirSync(join(ROOT, "src")).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testHelpers.ts"
    );

    for (const file of modules) {
      assert.ok(listed.has(file), `src/${file} exists but the README structure tree omits it`);
    }
  });

  it("documents every tool, the prompt and the resource", () => {
    for (const name of Object.values(TOOL)) {
      assert.ok(readme.includes(`\`${name}\``), `README never mentions the ${name} tool`);
    }
    assert.ok(readme.includes("`weekly_inventory_review`"), "README never names the prompt");
    assert.ok(readme.includes("`tango://catalog`"), "README never names the resource");
  });
});
