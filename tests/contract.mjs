#!/usr/bin/env node
/**
 * Contract tests for this repository's own surfaces.
 *
 * These exist because extraction moved security-relevant lines OUT of the
 * consumers' self-testing perimeter: a consumer can now assert only that it
 * calls a SHA-pinned reference, not that the checkout drops credentials or
 * that anything actually lints. Those assertions have to live where the steps
 * now live, or the property is simply lost.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const validate = readFileSync(join(root, ".github/workflows/validate.yml"), "utf8");
const action = readFileSync(join(root, "actions/actionlint/action.yml"), "utf8");
const runner = readFileSync(join(root, "actions/actionlint/run.sh"), "utf8");

/** Comment lines are documentation, not references: this repository's own
 * files carry `uses:` examples and mention `-ignore` in prose, and scanning
 * them as code produced two false failures on the first run. */
function codeOnly(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- what consumers can no longer assert for themselves -------------------
check(
  "validate checkout never persists credentials",
  /uses: actions\/checkout@[0-9a-f]{40}[\s\S]*?persist-credentials: false/.test(validate),
);
check(
  "validate grants only contents: read",
  /^permissions:\n  contents: read$/m.test(validate),
);
check("validate actually lints", validate.includes("actions/actionlint@"));
check(
  "validate actually checks the changed range",
  validate.includes('git diff --check "$BASE_SHA" "$HEAD_SHA"'),
);

// --- pinning, including this repository's reference to itself -------------
for (const [file, name] of [
  [codeOnly(validate), "validate.yml"],
  [codeOnly(action), "actionlint/action.yml"],
]) {
  for (const line of file.match(/uses:\s*\S+/g) ?? []) {
    check(`${name} pins ${line}`, /uses:\s*[\w./-]+@[0-9a-f]{40}$/.test(line));
  }
}
check(
  "validate pins its own action by SHA, not a branch",
  /uses: sutro-planet\/ci\/actions\/actionlint@[0-9a-f]{40}/.test(codeOnly(validate)),
  "a floating self-reference would drift even for a caller that pinned the workflow",
);

// --- the download this repository is trusted to verify --------------------
check("the release download is checksum-verified", runner.includes("checksum mismatch"));
check(
  "a checksum mismatch is fatal",
  /actual_checksum" != "\$checksum" \]; then[\s\S]*?exit 1/.test(runner),
);
check(
  "the ignore pattern suppresses exactly one known-stale diagnostic",
  (codeOnly(runner).match(/-ignore /g) ?? []).length === 1 &&
    codeOnly(runner).includes(`-ignore 'unexpected key "queue" for "concurrency" section'`),
);

// --- inputs, not constants: the rule that keeps consumers unblocked -------
for (const input of ["runner:", "timeout-minutes:", "contract-test-command:"]) {
  check(`${input} is an input`, validate.includes(`      ${input}`));
}

// --- no consumer names leak into shared infrastructure --------------------
const shared = [validate, action, runner, readFileSync(join(root, "README.md"), "utf8")].join("\n");
for (const leak of ["kingdoms", "meet-u", "story-orbit", "portal-interactive"]) {
  check(`no consumer-specific name: ${leak}`, !shared.toLowerCase().includes(leak));
}

// --- the agent tooling this repository also publishes ---------------------
const worktree = readFileSync(join(root, "scripts/worktree.mjs"), "utf8");
check(
  "the worktree tool derives its repository from the caller, not its own path",
  worktree.includes('execFileSync("git", ["rev-parse", "--show-toplevel"]'),
  "installed globally, the tool's own location says nothing about the target repo",
);
check(
  "it names new trees from the primary worktree, not a hardcoded prefix",
  worktree.includes("basename(primary)"),
);
check(
  "finished threads are detected by PR state, not ancestry alone",
  worktree.includes("gh") && worktree.includes("--head") && worktree.includes("squash"),
  "these repositories squash-merge: a merged branch is never an ancestor of main",
);
check("a dirty tree is never pruned", worktree.includes("!isDirty(tree.path)"));
check(
  "there is a scoped removal, not only a machine-wide sweep",
  worktree.includes("function cmdRemove(") && worktree.includes('case "remove":'),
  "a sweep judged by PR state can delete a live session's tree mid-handoff",
);
check(
  "scoped removal refuses the primary checkout and dirty trees",
  worktree.includes("that is the primary checkout") &&
    worktree.includes("has uncommitted changes; commit, push, or move them"),
);
check(
  "prune converges instead of stopping after one pass",
  /for \(let pass = 0; pass < \d+; pass \+= 1\)/.test(worktree),
  "removing a nested worktree can make its parent prunable — one pass missed it",
);
check(
  "the primary checkout is never pruned",
  worktree.includes("tree.path !== primaryPath"),
);

const workflows = readdirSync(join(root, ".github/workflows")).sort();
console.log(`workflows: ${workflows.join(", ")}`);
console.log(failures === 0 ? "contract: OK" : `contract: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
