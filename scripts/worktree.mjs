#!/usr/bin/env node
/**
 * Worktree helper for repositories worked by several agent sessions at once.
 * The primary checkout is a coordination surface, every thread gets its own
 * tree, and a finished tree is removed — an abandoned worktree pins a stale
 * commit that a later session reads as current.
 *
 *   sutro-worktree new <issue> <branch>   create ../<repo>-<issue> from origin/main
 *   sutro-worktree list                   every worktree, with what is stale about it
 *   sutro-worktree remove [path]          remove ONE tree — yours, by default
 *   sutro-worktree prune [--yes]          machine-wide sweep; maintainer housekeeping
 *
 * `remove` is the routine one. `prune` acts on every session's trees at once
 * and judges "finished" by pull-request state, which is not the same as a
 * handoff being complete — verification, acceptance notes and issue closure
 * all happen after merge. Sweeping on that criterion can delete a live
 * session's checkout mid-handoff.
 *
 * It exists because the raw commands are easy to fumble, and fumbling this one
 * means editing another session's tree. Run it from anywhere inside the target
 * repository: everything is derived from the working directory, so one install
 * serves every repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// The tool may be installed globally, so its own path says nothing about
// which repository it is acting on. Everything below derives from the caller's
// working directory instead.
const HERE = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
  } catch {
    console.error("not inside a git repository");
    process.exit(1);
  }
})();

function git(args, options = {}) {
  // `stdio: "inherit"` streams to the terminal and returns null rather than a
  // string, so trimming unconditionally crashed `new` AFTER it had already
  // created the worktree — leaving a directory the next run then refused to
  // touch. Return "" for the streamed case.
  const out = execFileSync("git", args, { encoding: "utf8", cwd: HERE, ...options });
  return out === null ? "" : out.trim();
}

/** Commits this branch has that origin/main does not. */
function commitsAhead(branch) {
  return Number(git(["rev-list", "--count", `origin/main..${branch}`]));
}

/**
 * Whether the thread is finished. Ancestry alone cannot answer it: this repo
 * squash-merges, so a merged branch's head is never an ancestor of main —
 * `feat/102-…` sat merged and undetected until this used the PR instead.
 * gh is the authority; ancestry is the offline fallback.
 */
function threadClosed(branch) {
  try {
    const prs = JSON.parse(
      execFileSync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--json", "state,number"],
        {
          encoding: "utf8",
          cwd: HERE,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
    if (prs.length > 0) {
      const pr = prs[0];
      return pr.state === "OPEN" ? null : `PR #${pr.number} is ${pr.state.toLowerCase()}`;
    }
  } catch {
    // gh missing, unauthenticated, or offline — fall through to ancestry.
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: HERE });
    return "already in origin/main";
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `git worktree list --porcelain`, as records. */
function worktrees() {
  const out = [];
  let current = null;
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, detached: false };
      out.push(current);
    } else if (line === "detached" && current) {
      current.detached = true;
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  return out;
}

function isDirty(path) {
  try {
    return git(["status", "--porcelain"], { cwd: path }).length > 0;
  } catch {
    return true; // unreadable tree: treat as dirty, never auto-remove
  }
}

/** What is wrong with this tree, or null when it is doing its job. The
 * primary checkout is the first entry git reports, not wherever this script
 * happens to live — it is routinely run from inside a worktree. */
function staleness(tree, primaryPath) {
  if (tree.path === primaryPath) {
    return tree.branch === "main"
      ? null
      : `primary checkout is on ${tree.branch ?? "a detached HEAD"}, not main`;
  }
  if (tree.detached) return "detached HEAD — no branch to finish";
  if (!tree.branch) return "no branch";
  try {
    git(["rev-parse", "--verify", tree.branch]);
  } catch {
    return `branch ${tree.branch} no longer exists`;
  }
  const closed = threadClosed(tree.branch);
  if (commitsAhead(tree.branch) === 0) {
    // Nothing of its own: either just created — leave it alone while someone
    // is working — or merged by a strategy that keeps ancestry. Say which:
    // "PR #127 merged" is a reason a human can act on, where "no commits" is
    // a fact they then have to go and interpret.
    if (isDirty(tree.path)) return null;
    return closed ? `${tree.branch}: ${closed}` : "no commits and nothing in progress";
  }
  return closed ? `${tree.branch}: ${closed}` : null;
}

function cmdNew(issue, branch) {
  if (!/^[1-9][0-9]*$/.test(issue ?? "") || !branch) {
    fail("usage: worktree.mjs new <issue-number> <branch>");
  }
  // `../<primary-directory-name>-<issue>`, so the convention holds in any
  // repository without the tool knowing its name.
  const primary = worktrees()[0].path;
  const path = resolve(primary, "..", `${basename(primary)}-${issue}`);
  if (existsSync(path))
    fail(`${path} already exists — pick another issue number or remove it first`);
  console.log("fetching origin…");
  git(["fetch", "origin", "--quiet"]);
  git(["worktree", "add", path, "-b", branch, "origin/main"], { stdio: "inherit" });
  console.log(`\nworktree ready:\n  cd ${path}`);
  if (!existsSync(join(path, "node_modules"))) {
    // A symlink to the primary tree's modules is NOT gitignored (the pattern
    // is `node_modules/`, directories only) and would show up as untracked.
    console.log("  npm ci          # the tree has no node_modules yet");
  }
}

function cmdList() {
  const trees = worktrees();
  const primaryPath = trees[0].path;
  for (const tree of trees) {
    const note = staleness(tree, primaryPath);
    const dirty = isDirty(tree.path) ? " · dirty" : "";
    const label = tree.detached ? "(detached)" : (tree.branch ?? "(no branch)");
    const primary = tree.path === primaryPath ? " [primary]" : "";
    console.log(
      `${note ? "!" : " "} ${tree.path}${primary}\n    ${label}${dirty}${note ? ` — ${note}` : ""}`,
    );
  }
}

/** Remove one worktree — by default the one you are standing in. The routine
 * cleanup: an agent finishes its own thread and takes its own tree with it,
 * touching nobody else's. */
function cmdRemove(pathArg) {
  const trees = worktrees();
  const primaryPath = trees[0].path;
  const target = resolve(pathArg ?? process.cwd());
  const tree =
    trees.find((candidate) => target === candidate.path || target.startsWith(`${candidate.path}/`));
  if (!tree) fail(`${target} is not inside a registered worktree`);
  if (tree.path === primaryPath) {
    fail("that is the primary checkout — it is the coordination surface, not a thread's tree");
  }
  if (isDirty(tree.path)) {
    fail(`${tree.path} has uncommitted changes; commit, push, or move them before removing`);
  }
  // Not a refusal: an agent may legitimately abandon a thread. But an open PR
  // usually means the handoff is not finished, and the point of this command
  // is that the caller decides for their own tree only.
  const open = tree.branch && threadClosed(tree.branch) === null && commitsAhead(tree.branch) > 0;
  if (open) console.log(`note: ${tree.branch} has no merged/closed PR — removing anyway`);
  git(["worktree", "remove", tree.path]);
  console.log(`removed ${tree.path}`);
  if (target !== tree.path || process.cwd().startsWith(tree.path)) {
    console.log("you were standing in it — cd somewhere else before running git again");
  }
}

function cmdPrune(confirm) {
  // Repeated passes, because removing a nested worktree can make its PARENT
  // prunable: while the child's directory still existed it counted as
  // untracked content, so the parent read as dirty. A single pass left one
  // behind on the first real run of this tool.
  let removedAny = false;
  for (let pass = 0; pass < 5; pass += 1) {
    const trees = worktrees();
    const primaryPath = trees[0].path;
    const removable = trees.filter(
      (tree) =>
        tree.path !== primaryPath && staleness(tree, primaryPath) !== null && !isDirty(tree.path),
    );
    if (removable.length === 0) break;
    for (const tree of removable) {
      if (!confirm) {
        console.log(`would remove ${tree.path} (${tree.branch ?? "detached"})`);
        continue;
      }
      git(["worktree", "remove", tree.path]);
      console.log(`removed ${tree.path}`);
      removedAny = true;
    }
    if (!confirm) break; // a dry run cannot change what the next pass sees
  }
  if (!confirm) {
    console.log("\nre-run with --yes to remove them");
  } else if (!removedAny) {
    console.log("nothing to prune (dirty trees and unfinished threads are never removed)");
  }
}

const [, , command, ...rest] = process.argv;
switch (command) {
  case "new":
    cmdNew(rest[0], rest[1]);
    break;
  case "list":
    cmdList();
    break;
  case "remove":
    cmdRemove(rest[0]);
    break;
  case "prune":
    cmdPrune(rest.includes("--yes"));
    break;
  default:
    fail("usage: sutro-worktree new <issue> <branch> | list | remove [path] | prune [--yes]");
}
