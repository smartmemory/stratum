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

**CORRECTED 2026-09-15 — the model id was NOT the cause.** The first diagnosis blamed the
identifier (`ts/src/judge/pricing.ts:22` notes the registry carries spark as the
subscription-billed `chatgpt/gpt-5.3-codex-spark`) and then blamed the auth mode. Both were
wrong. Decoding `~/.codex/auth.json` showed the real cause: the cached token carries
`chatgpt_plan_type: "pro"` but `chatgpt_subscription_active_until: 2026-08-18` — expired 28 days
before the call — with `chatgpt_subscription_last_checked: 2026-07-27` and an `id_token` that
itself expired 2026-09-05. A lapsed cached entitlement, fixed by re-authenticating; the account
does hold a Pro subscription.

The vendor message is what misled: "not supported when using Codex with a ChatGPT account" reads
as a permanent statement about the auth MODE, when it reflects a transient entitlement state.
A generally-available model (terra) succeeded from the same CLI seconds later, which is the
control that should have been run first.

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
