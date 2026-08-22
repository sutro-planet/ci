# ci

Shared CI harness for this organization's repositories: reusable workflows and
composite actions that several repositories were otherwise maintaining as
independent copies.

## Why this exists

Three repositories ran the same CI, copy-pasted between them and then patched
independently. The copying was one-directional and lossy: fixes did not flow
back, and each copy ended up carrying a different subset of them. One file made
the cost concrete — three copies of the actionlint runner, each with a real fix
the other two lacked, and none with all three:

| fix | A | B | C |
| --- | --- | --- | --- |
| portable checksum (`sha256sum` or `shasum`) + readable mismatch | ✅ | ❌ | ✅ |
| suppress the stale `concurrency.queue` schema diagnostic | ❌ | ✅ | ❌ |

Worse than the duplication: a security fix written against one repository's
workflow, in another repository, never came back — so the gap it closed stayed
open in the repository the fix was written for.

Anything here is meant to be the *only* copy. If a fix belongs to more than one
consumer, it belongs in this repository.

## What is here

| path | kind | purpose |
| --- | --- | --- |
| `actions/actionlint` | composite action | checksum-verified actionlint, no root required |
| `.github/workflows/validate.yml` | reusable workflow | changed-range whitespace + actionlint + an optional contract-test command |
| `actions/publish-review` | composite action | validate a reviewer's structured result and post it as a SHA-labelled comment |
| `scripts/worktree.mjs` | agent tooling | one worktree per thread, and removing the finished ones |

## Agent tooling

`sutro-worktree` is a local command, not CI: repositories worked by several
agent sessions accumulate worktrees, and an abandoned one pins a stale commit
that a later session reads as current. One repository was found holding 51
finished worktrees against 2 live ones.

```sh
npm install -g github:sutro-planet/ci#<commit>   # once per machine, pinned
cd any-consumer-repository
sutro-worktree list                       # what is stale, and why
sutro-worktree new 42 feat/42-thing       # ../<repo>-42 from a fresh origin/main
sutro-worktree remove                     # the tree you are standing in — the routine one
sutro-worktree prune --yes                # machine-wide sweep; maintainer housekeeping
```

**`remove` is what an agent runs; `prune` is not.** A sweep judges "finished"
by pull-request state, and a merged pull request is not a finished handoff —
verification, acceptance notes and issue closure all happen after merge. Run
machine-wide and non-interactively, it can delete another session's checkout
mid-handoff. `remove` touches one tree, refuses the primary checkout, and
refuses anything dirty.

Pin the install. The tool deletes working trees, and an unpinned global
install floats to whatever the default branch became.

Everything is derived from the working directory — repository root, naming
prefix, and remote — so one install serves every repository.

**Finished is decided by pull-request state, not ancestry.** These repositories
squash-merge, so a merged branch's head is never an ancestor of `main`; by
ancestry one repository looked like 9 stale worktrees where it actually had 51.

## Consuming it

```yaml
jobs:
  validate:
    # The fork guard stays with you: only the caller knows its own fork policy.
    if: github.event_name != 'pull_request' ||
        github.event.pull_request.head.repo.full_name == github.repository
    uses: sutro-planet/ci/.github/workflows/validate.yml@<full-commit-sha>
    with:
      contract-test-command: npm run test:contracts
```

Pin by full commit SHA, the same rule consumers apply to third-party actions.
This repository pins its own internal references the same way, so a caller
pinning the workflow pins everything it reaches.

## Design rules

1. **The mechanism is shared; the numbers are not.** Concurrency ceilings,
   timeouts, and test commands differ per repository for real reasons — one
   consumer's previews are heavier than another's. Anything a consumer might
   reasonably set differently is an input, never a constant.
2. **Nothing consumer-specific leaks in.** No repository names, hostnames,
   cluster identifiers, or design-document paths. If a workflow cannot be
   written without naming a consumer, it is not shared infrastructure yet.
3. **A change here is a change everywhere.** Consumers pin by SHA, so nothing
   moves under them — but the point of the repository is that the *next* pin
   carries every fix, not one repository's subset.
