---
name: Feature
about: A behavioural outcome to build. Says what becomes true, not how to build it.
title: ""
labels: ""
assignees: ""
---

<!--
This repo is built by coding agents. An issue is a spec: it defines the outcome and the
behaviours that prove it, and stops there. Implementation is the agent's job — prescribing
it here throws away the agent's read of the codebase and hides the reasoning from review.

Delete any section that genuinely does not apply. Do not delete "Behaviours" or "Done when".
-->

## Outcome

<!--
One or two sentences, written from outside the system: what becomes true for the user.
If you can only describe it in terms of files, functions, or tables, it is not an outcome
yet — keep pulling until you can say what changes for the person using this.
-->

## Why now

<!--
The SPEC requirement or milestone this serves, linked. What stays broken without it, and
why it is worth doing at this point in the build order rather than later.
-->

## Behaviours

<!--
The observable behaviours that prove the outcome. Each one must be checkable from outside
the system — these become the tests that ship in the same PR.

Write "when X, then Y". Not "add a function that…".

Good:  When extraction fails, the capture echo says so rather than staying silent.
Bad:   Add a try/catch in the worker that sets extraction_status to 'failed'.
-->

- [ ]
- [ ]
- [ ]

## Explicitly out of scope

<!--
What a reasonable reader would assume is included but is not — and where it lands instead
(a named milestone, another issue, the SPEC parking lot). This section is what stops an
agent from building ahead.
-->

## Invariants in play

<!--
From AGENTS.md. Name the ones this work can violate, and how it avoids doing so. Delete
the rest. Violating one of these is a design failure, not a style issue.

1. Zero-decision capture   2. Dumps immutable        3. Echo + "wrong" affordance
4. Data stays local        5. Hybrid retrieval       6. Thresholds in config
7. Dashboard derived-only  8. Instrumentation logged
-->

## Open questions

<!--
Anything that would change the shape of the work. Resolve these before starting — a
question answered halfway through is a rewrite.
-->

## Done when

- [ ] Every behaviour above is covered by a test that ships in the same PR
- [ ] New dependency, new interface, changed threshold semantics, or any SPEC deviation is appended to `docs/DECISIONS.md`
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass
- [ ] Nothing outside "Behaviours" was built
