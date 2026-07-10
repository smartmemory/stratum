# Stratum Vision

**Recorded 2026-07-10, restated by the project owner.** This is the founding
intent of the project, written down so it survives sessions and contributors.
Mechanism docs (README, feature designs) describe how Stratum works. This doc
records what Stratum is for.

## The original idea

Stratum is a spec language for keeping LLMs and their harnesses on rails.

The loop it exists to serve:

1. A user asks an agent for something, in plain language, like always.
2. The harness writes a typed spec internally. The user never sees it.
3. The spec compiles down to Stratum and runs. The server tracks state,
   checks postconditions, and forces structured retries when a step's output
   does not hold up.
4. The user gets the answer.

The product is the delta in step 4: stronger results than freeform execution.
Lower hallucination rates, fewer silently dropped requirements, fewer
confident wrong turns. There is almost no visible surface. Nothing new to
learn. Just better answers from the same conversation.

## What follows from this

- **The primary user is the model, not a human.** Spec authoring ergonomics,
  compile quality, the postcondition vocabulary, and token-cheap spec syntax
  matter more than human-facing dashboards or golden paths. A human should be
  able to audit a run. A model should be able to author one in a few hundred
  tokens.
- **Invisibility is a feature, not a gap.** The CLAUDE.md execution model
  ("write the spec, never show it, narrate plain English") is the vision
  operationalized. UX proposals that add visible ceremony run against the
  grain.
- **The claim must be measurable.** "Stronger results than freeform" is an
  empirical statement. The proof loop is an A/B harness: same tasks, railed
  vs freeform, scored on correctness, hallucination, and requirement
  coverage. Until that exists the core claim is anecdote.
- **Synergies are part of the thesis.** Token savings (structured retries
  beat re-prompting, and spec-guided context loading beats re-discovery) and
  SmartMemory (recall feeding spec context, run outcomes feeding memory) are
  multipliers on the same loop, not separate products.

## What Stratum is not

- Not a human-facing workflow builder. Humans consume audits and gates, and
  approve or kill. They do not hand-author specs.
- Not a library to be absorbed into a single consumer. Compose is the biggest
  consumer, not the owner. The kernel stays independent so any harness or
  host can compile down to it. A TypeScript port serves stack homogeneity and
  is welcome, but as a standalone engine, not as an internal module of one
  product.

## Relationship to the workflow-engine direction

The daemon, triggers, and out-of-session gates direction (see
`forge/docs/product/2026-07-10-stratum-compose-product-review.md`) is a
carrier for the same loop: it lets railed execution happen on schedules and
events instead of only inside a live session. It extends the vision. It does
not replace it.
