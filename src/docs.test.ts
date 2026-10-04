import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

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

/**
 * The changelog, pinned against the repository it describes.
 *
 * A release history is the easiest document in a repo to let rot: it is written
 * once, at the end of a long piece of work, and then nothing checks it again. So
 * the claims that are cheap to verify mechanically are verified here — a version
 * heading with no matching tag, or a release page URL pointing at a tag that
 * does not exist, is a broken promise to anyone reading the file.
 */
describe("CHANGELOG", () => {
  /** Versions as `[3.0.1]` headings, newest first as written. */
  const documented = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);

  it("has at least one release documented", () => {
    assert.ok(documented.length > 0, "CHANGELOG.md documents no releases");
  });

  it("documents every release on this branch's lineage", () => {
    // Only tags reachable from `main` get a version heading: `v2.0.0` is not on
    // this lineage (asserted below), and giving it a heading here would imply it
    // is a release of the code in this branch.
    const tags = execFileSync("git", ["tag", "-l", "--merged", "main", "v*"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((t) => t.trim().replace(/^v/, ""))
      .filter(Boolean);

    for (const version of tags) {
      assert.ok(documented.includes(version), `tag v${version} is on main but the CHANGELOG omits it`);
    }
  });

  it("mentions any tag that is not on this lineage, rather than dropping it", () => {
    const all = execFileSync("git", ["tag", "-l", "v*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    const merged = new Set(
      execFileSync("git", ["tag", "-l", "--merged", "main", "v*"], { cwd: ROOT, encoding: "utf8" })
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
    );

    const orphans = all.filter((t) => !merged.has(t));
    assert.ok(orphans.length > 0, "this test is vacuous unless some tag is off-lineage");
    for (const tag of orphans) {
      assert.ok(changelog.includes(tag), `tag ${tag} exists but the CHANGELOG never mentions it`);
    }
  });

  it("links each release to a page that exists for its tag", () => {
    for (const version of documented) {
      const link = changelog.match(new RegExp(`^\\[${version.replace(/\./g, "\\.")}\\]:\\s*(\\S+)$`, "m"));
      assert.ok(link, `CHANGELOG has no link definition for [${version}]`);
      // Defaulted rather than asserted: `noUncheckedIndexedAccess` makes the
      // capture `string | undefined`, and a non-null assertion there is exactly
      // what the type-aware lint rules exist to flag.
      const [, url = ""] = link;
      assert.notEqual(url, "", `the [${version}] link definition has no URL`);
      assert.match(
        url,
        new RegExp(`/releases/tag/v${version.replace(/\./g, "\\.")}$`),
        `[${version}] links to ${url}, which is not that version's release`
      );
    }
  });

  it("documents the current version", () => {
    // The changelog is the first place a reader looks for "what am I running",
    // so the shipped version must be in it. Read from package.json rather than
    // hardcoded, which makes the bump itself the trigger.
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    assert.ok(
      documented.includes(version),
      `package.json says ${version}, which the CHANGELOG does not document`
    );
  });

  it("states the release date a tag was actually cut on", () => {
    for (const version of documented) {
      const cut = execFileSync("git", ["log", "-1", "--format=%aI", `v${version}`], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      const date = new Date(cut).toISOString().slice(0, 10);
      assert.ok(
        changelog.includes(`## [${version}] — ${date}`),
        `[${version}] was tagged on ${date}, which the CHANGELOG does not state`
      );
    }
  });

  it("keeps the divergent v2.0.0 lineage documented rather than silently dropped", () => {
    // `v2.0.0` is not an ancestor of main. If that ever changes — by merging or
    // by deleting the tag — this document's central caveat becomes a lie, so it
    // is asserted rather than trusted.
    const merged = (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", "v2.0.0", "main"], {
          cwd: ROOT,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    })();

    assert.equal(
      merged,
      false,
      "v2.0.0 is now an ancestor of main — the CHANGELOG's divergence note must be rewritten"
    );
    // Matched against prose with blockquote markers stripped and whitespace
    // collapsed: the note is hard-wrapped inside a `>` blockquote, so the
    // phrase a reader sees is split across lines and prefixed by `> `.
    const flattened = changelog
      .replace(/^>\s?/gm, "")
      .replace(/\s+/g, " ");
    assert.match(flattened, /not an ancestor of `main`/i);
    assert.match(flattened, /Divergent lineage/);
  });
});
