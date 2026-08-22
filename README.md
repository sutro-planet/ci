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
