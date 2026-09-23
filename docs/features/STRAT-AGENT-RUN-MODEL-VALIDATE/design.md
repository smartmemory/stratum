# STRAT-AGENT-RUN-MODEL-VALIDATE — validate dispatch model at the MCP boundary

**Status:** PLANNED · **Created:** 2026-09-15 · **Complexity:** S

## Why

`stratum_agent_run` declares its dispatch parameters as free-form strings
(`ts/contracts/mcp-surface.json`):

```json
"model?": "string", "effort?": "string", "sandboxMode?": "string", "agent": "string"
```

Nothing validates `model` against the canonical set anywhere in the dispatch path. A wrong or
misspelled model is accepted, a dispatch is spent, and the caller gets an opaque vendor error
back instead of a usable one.

Observed 2026-09-15: a dispatch passed `model: "gpt-5.3-codex-spark"` and failed with

```
400 invalid_request_error: The 'gpt-5.3-codex-spark' model is not supported
when using Codex with a ChatGPT account.
```

**CORRECTED TWICE 2026-09-15 — record of both wrong diagnoses, then the evidence.**

Diagnosis 1 (wrong): the model identifier. `ts/src/judge/pricing.ts:22` notes the registry
carries spark as the subscription-billed `chatgpt/gpt-5.3-codex-spark`, so the bare name looked
like the fault.

Diagnosis 2 (wrong): a lapsed entitlement. `~/.codex/auth.json` carries
`chatgpt_plan_type: "pro"` with `chatgpt_subscription_active_until: 2026-08-18` and
`last_checked: 2026-07-27`. That date is a STALE SNAPSHOT of a billing period that has since
renewed — not an expiry. The refutation was already in hand and went unnoticed: astra, sol and
terra all dispatched successfully the same session. A lapsed subscription cannot fail one model
and serve three others.

What the evidence actually shows (`~/.codex/sessions`, 2026-09-15):

| Probe | Result |
|---|---|
| Sessions with spark as the ACTUAL model | 294, 2026-04-27 → 2026-09-12 |
| The 2026-09-12 spark session | 3 spark model refs, 0 request errors — it worked |
| codex CLI 0.153.3 | installed 2026-09-05, unchanged since |
| Auth token `last_refresh` | 2026-09-05, unchanged since |
| `codex doctor` | auth configured, healthy, mode `chatgpt` |

**Spark worked on 2026-09-12 with this exact CLI and these exact credentials, and is refused on
2026-09-15.** Same client, same auth, three days apart. That leaves a server-side change at
OpenAI as the only explanation consistent with the data. The vendor string
("not supported when using Codex with a ChatGPT account") reads as a permanent statement about
the auth MODE, which is what drew two successive wrong conclusions out of it.

Unresolved: whether this is a permanent withdrawal of spark from subscription auth or a
transient gate. Decisive test would be a dispatch under API-key auth, which this machine has no
key for (`OPENAI_API_KEY` is unset; `auth_mode: chatgpt`).

**This is still the motivating case for validation, for a different reason.** The dispatch path
offers the caller nothing to distinguish "you typed an invalid model" from "this model exists but
your credentials lapsed" — both surface as the same opaque vendor 400. Validating the identifier
locally separates the two: a name that fails the allowlist is the caller's typo, and a name that
passes the allowlist but is refused upstream is an account/credential problem worth saying so.

A second, related sharp edge: stratum parses `<model>/<effort>`, so passing a model identifier
that legitimately contains a slash (`chatgpt/gpt-5.3-codex-spark`) is read as
model `chatgpt` + effort `gpt-5.3-codex-spark`, and returns
`Codex effort conflicts with the effort suffix in model` — an error that describes the parser's
confusion rather than the caller's mistake.

## Scope

- [ ] Validate `model` at the `stratum_agent_run` boundary against the runtime allowlist, and
      reject with an error that NAMES the accepted values.
- [ ] Validate `effort` against `low|medium|high|xhigh|max|ultra`, including that max/ultra are
      only valid on the models that support them.
- [ ] Make the `<model>/<effort>` split unambiguous for identifiers that contain a slash —
      split on the LAST slash only if the trailing segment is a known effort, otherwise treat
      the whole string as the model.
- [ ] Decide and document whether provider-prefixed ids (`chatgpt/...`) are a supported input
      form, or whether the auth mode selects the billing variant internally.

## Non-goals / explicit ruling

**Do NOT freeze the model list into `mcp-surface.json` as a value enum.** The surface is a
released, frozen contract; baking the model list into it would mean every new vendor model
requires a surface version bump and a release before it can be dispatched, and model names churn
far faster than contract releases. The surface stays permissive (`"model?": "string"`);
enforcement belongs at the runtime boundary where the allowlist already lives.

Note the surface DSL could not express it anyway today: `|` there denotes union types
(`string|null`), not enumerated values — unlike the flow-contract DSL, which does support
`complete|skipped|failed`.

## Source of truth

`ts/src/judge/pricing.ts::MODEL_PRICING` currently carries the canonical five
(`gpt-5.3-codex-spark`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra`), and
`ts/src/judge/judged.ts` pins the tier defaults. Whichever of these becomes the allowlist,
pricing and validation must not drift apart — a model dispatchable but unpriced silently
produces uncosted rows.

---

## Design decisions (2026-09-23, `/compose build --quick`)

Prior art checked: `ts/src/connectors/codex.ts:681` `codexModelWithEffort` already validates the
*effort* (`reasoningEffort(selected)`) and is the single choke point for foreground
(`codex.ts:225`), background (`background.ts:180`) and flow-step Codex dispatch; the default comes
from `CODEX_MODEL ?? "gpt-5.6-terra/high"` (`codex.ts:143`). No model allowlist exists anywhere
(grep `MODEL_PRICING` outside `pricing.ts`: none). `modelIdentity` (`base.ts:84`) splits on the
FIRST slash; `baseModel` (`pricing.ts`) splits on the LAST — they disagree.

**D1 — The allowlist is `MODEL_PRICING`'s keys minus a `RETIRED_MODELS` set.** One table, so a
dispatchable model is always a priced model (the drift this doc warned about). Spark stays priced
(historical rows) but is in `RETIRED_MODELS`; dispatching it fails with a named "retired upstream
2026-09-16" error, distinct from "unknown model".

**D2 — Add `gpt-6-sol` (2/10) and `gpt-6-luna` (0.10/0.50) to `MODEL_PRICING`.** Both are in active
use (routing default/mechanical tiers since 2026-09-22) and would otherwise be rejected on day one.
Source: OpenAI's 2026-09-22 announcement as recorded in `~/.claude/rules/subagent-model-routing.md`
(unverified against LiteLLM — registry check is STRAT-LEARN-COST-1's job). cacheRead set at the
0.1x convention (0.2 / 0.01), marked INFERRED in the comment like spark's. Also correct the stale
`judged.ts:22` comment claiming `gpt-6-luna` 400s (two dispatches on 2026-09-23 ran on it).
`STAKES_MODEL` tier choices are NOT changed.

**D3 — Validate in `codexModelWithEffort`, not in the MCP handler.** Covers every Codex path
including `CODEX_MODEL` typos. The error names the rejected id and lists the accepted ids (sorted).
Claude-agent `model` is passed through unvalidated: stratum has no Claude model table, and the SDK
accepts aliases (`sonnet`, `opus`) that a static list would wrongly reject. `agent` itself is
validated to `codex | claude` at the MCP boundary (today it is a bare cast, `server.ts:223,339`).

**D4 — Slash parsing: split on the LAST slash, and only when the suffix is a known effort.**
`modelIdentity` and `baseModel` converge on one rule. `chatgpt/gpt-5.3-codex-spark` then parses as
a whole model id and fails D1 cleanly as unknown instead of as an "effort conflict".

**D5 — Provider-prefixed ids (`chatgpt/...`) are not a supported input form.** The Codex auth mode
selects billing; callers pass the bare model id. The unknown-model error says so when the rejected
id contains a slash.

**D6 — Effort-per-model (max/ultra only on some models) is OUT of v1.** The only source for that
matrix is an unverified note; encoding it would reject valid calls on a guess. `reasoningEffort`
keeps validating the effort vocabulary; the vendor stays authoritative on per-model support.
Filed as a follow-up in the doc, not a ticket.

**D7 — One effort vocabulary: `minimal|low|medium|high|xhigh`** (design-gate round 1, finding 1).
That is what stratum accepts today, duplicated at `codex.ts:538` (`reasoningEffort`) and
`runner.ts:171`. The Scope bullet above that says `low|medium|high|xhigh|max|ultra` is SUPERSEDED:
it drops `minimal` (currently valid) and adds `max|ultra`, which stratum already rejects locally.
v1 hoists the existing five into ONE exported constant used by both sites and by D4's suffix
check, so `gpt-5.6-terra/minimal` keeps parsing as model+effort. `max|ultra` stay rejected (status
quo, no regression); widening the vocabulary is the D6 follow-up.

**D8 — Background validates before any persistent write** (finding 2). `startBackgroundRun`
creates the run dir and writes stream/stderr/prompt files (`background.ts:~170-178`) before
resolving the model at `:180`. The model resolution + validation moves above `newRunDir`, so a
rejected model leaves no orphan run directory or prompt file.

**D9 — Test fixtures migrate** (finding 3). Successful-dispatch tests using retired spark
(`tests/connectors/codex.test.ts` ~:43,118,138,144, ~:220, ~:350) or unlisted `gpt-5`
(`codex.test.ts` ~:51-67, `runner.test.ts:124`) move to allowlisted ids. Pure argv-shape tests of
`codexExecArgs` may keep any id only if `codexExecArgs` itself does not validate (it doesn't —
validation is in `codexModelWithEffort`); prefer migrating anyway for clarity. Spark PRICING
coverage stays; add explicit retired-model and unknown-model rejection tests.

**Escalation check (--quick guardrail):** source files `pricing.ts`, `judged.ts` (comment),
`codex.ts`, `base.ts`, `background.ts`, `runner.ts`, one line in `server.ts`, plus test fixture
migrations. Still one component (connectors + its pricing table), no contract change
(`mcp-surface.json` stays permissive per the ruling above). Quick path holds.
