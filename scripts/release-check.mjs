#!/usr/bin/env node
/**
 * Pre-release gate.
 *
 * Every condition here has actually broken a release of this project:
 *
 *   1. The tag has to exist and be on `main`. A tag pushed to a commit the
 *      changelog lineage checks cannot see fails CI at `docs.test.ts` with
 *      `fatal: malformed object name main` — which is how the v3.1.1 and
 *      v3.1.2 tag runs went red while the same commit on `main` passed.
 *   2. The tag's date has to match the changelog heading. `docs.test.ts`
 *      compares them, but only once CI has already run, minutes after the
 *      release is published.
 *   3. `package.json` and the version the server reports have to agree. A
 *      mismatch ships a tarball whose binary announces a different version to
 *      every client that connects.
 *   4. The release notes have to exist and be non-trivial, because a release
 *      published without them is worse than no release.
 *
 * Run it before tagging:
 *
 *     node scripts/release-check.mjs 3.1.3
 *
 * It is deliberately a local script rather than a workflow step: a gate you
 * have to remember to run is a gate that gets skipped, so it also runs in CI
 * (see `.github/workflows/ci.yml`, where it checks the tagged commit) — but the
 * useful moment is *before* the tag exists, which only a local run can cover.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function check(condition, problem, note) {
  if (!condition) problems.push(problem);
  else if (note) notes.push(note);
  return condition;
}

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-check.mjs <version>");
  console.error("   e.g. node scripts/release-check.mjs 3.1.3");
  process.exit(2);
}

const tag = `v${version}`;

// --- 1. the version is declared, consistently, in every place that states it ---
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check(
  pkg.version === version,
  `package.json says ${pkg.version}, but you are releasing ${version}`,
  `package.json: ${pkg.version}`
);

const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const declared = server.match(/SERVER_VERSION\s*=\s*"([\d.]+)"/)?.[1];
check(
  declared === version,
  `src/server.ts declares SERVER_VERSION = ${declared ?? "(none)"}, expected ${version}`,
  `src/server.ts: ${declared}`
);

const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
check(
  lock.version === version && lock.packages[""]?.version === version,
  `package-lock.json is out of step (${lock.version}/${lock.packages[""]?.version}); ` +
    `run \`npm install --package-lock-only\` before tagging`,
  `package-lock.json: ${lock.version}`
);

// --- 2. the changelog documents this version, dated, and links it ---
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const heading = changelog.match(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] — (\\d{4}-\\d{2}-\\d{2})$`, "m"));
check(heading, `CHANGELOG.md has no \`## [${version}] — YYYY-MM-DD\` heading`);
check(
  changelog.includes(`[${version}]: `),
  `CHANGELOG.md has no link definition for [${version}]`,
  `CHANGELOG heading: ${heading ? heading[1] : "missing"}`
);

// --- 3. the tag exists, is annotated, is on main, and its date matches ---
if (!existsSync(join(ROOT, ".git"))) {
  notes.push("not a git checkout — skipping the tag checks");
} else {
  let tags;
  try {
    tags = git("tag", "-l", tag);
  } catch {
    tags = "";
  }

  if (!tags) {
    // The normal case: this runs *before* the tag is cut.
    notes.push(`tag ${tag} does not exist yet — cut it before publishing`);
    console.log("Release check (pre-tag)\n");
  } else {
    console.log(`Release check (${tag})\n`);
    check(
      git("cat-file", "-t", tag) === "tag",
      `${tag} is a lightweight tag; the release history uses annotated tags ` +
        `(git tag -a ${tag} -m "Project Tango ${version}"), and docs.test.ts reads their date`
    );

    // The date the tag points at must be the date the changelog claims, or
    // docs.test.ts fails in CI on a commit that is already published.
    const tagDate = git("log", "-1", "--format=%aI", tag).slice(0, 10);
    check(
      heading && tagDate === heading[1],
      `${tag} is dated ${tagDate} but the changelog says ${heading?.[1] ?? "(none)"} — ` +
        `docs.test.ts compares these and will fail`,
      `tag date: ${tagDate}`
    );

    // A tag that is not reachable from main fails the changelog lineage checks.
    const merged = git("tag", "-l", "--merged", "main", tag);
    check(
      merged === tag,
      `${tag} is not merged into main; a tag run checks out a detached HEAD and ` +
        `docs.test.ts needs a local main ref to read`,
      "reachable from main"
    );

    // The tagged commit must be an ancestor of HEAD, not equal to it. A release
    // tag normally sits at the release commit while HEAD has moved on to
    // follow-up fixes — requiring equality would fail every tag that is a day
    // old, which is most of them. What actually matters is that the commit the
    // release describes is *in* the history being shipped, and has been pushed.
    const tagged = git("rev-list", "-1", tag);
    const contained = git("merge-base", "--is-ancestor", tag, "HEAD");
    check(
      contained === "",
      `${tag} (${tagged.slice(0, 7)}) is not an ancestor of HEAD — the tagged commit is ` +
        `not in this history, so the release describes something nobody has`,
      "tagged commit is in HEAD's history"
    );
  }
}

for (const note of notes) console.log(`  ok  ${note}`);
for (const problem of problems) console.log(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) — not ready to publish ${tag}.`);
  process.exit(1);
}
console.log(`\nReady to publish ${tag}.`);
console.log("  1. Publish the release with notes generated from the CHANGELOG section.");
console.log("  2. Wait for the tag's CI run to go green before announcing it.");
console.log("  3. Confirm the artifact workflow attached the tarball.");
process.exit(0);