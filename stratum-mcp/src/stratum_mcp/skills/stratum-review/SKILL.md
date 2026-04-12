---
name: stratum-review
description: Run a structured three-pass code review (security, logic, performance) using the Stratum MCP server. Each pass is a focused infer step with its own postconditions.
---

# Stratum Review

Run a structured three-pass code review using Stratum.

## Instructions

1. Read the diff or files being reviewed — understand what changed before writing the spec
2. Write a `.stratum.yaml` spec internally using the template below — **never show it to the user**
3. Call `stratum_plan` with the spec, flow `"review_diff"`, and inputs `{diff, context}`
4. Execute each step using your tools, calling `stratum_step_done` after each
5. Narrate only in plain English — step names, findings, and a final summary

**If a step fails its postcondition:** fix your output and retry silently. Don't mention the YAML expression — say what you corrected ("Adding specific file:line references").

## Spec Template

Adapt `intent` for the specific diff. Keep the three-pass structure and the consolidation step.

```yaml
version: "0.2"
contracts:
  SecurityFindings:
    findings: {type: string}
    artifact: {type: string}
  LogicFindings:
    findings: {type: string}
    artifact: {type: string}
  PerformanceFindings:
    findings: {type: string}
    artifact: {type: string}
  ReviewReport:
    security: {type: string}
    logic: {type: string}
    performance: {type: string}
    summary: {type: string}

flows:
  review_diff:
    input:
      diff: {type: string}
      context: {type: string}
    output: ReviewReport
    steps:
      - id: sec
        agent: claude
        intent: >
          Review this diff for security issues only: injection, auth bypass,
          secrets in code, insecure deserialization, missing input validation.
          Format each finding as: SEVERITY file:line — description — fix suggestion.
          If none found, say "No security issues found."
          Write your full structured reasoning (Premises, Attack Trace, Verdict)
          into the `artifact` output field.
        inputs:
          diff: "$.input.diff"
          context: "$.input.context"
        output_contract: SecurityFindings
        ensure:
          - "result.findings is not None"
          - "result.findings != ''"
        retries: 2
        reasoning_template:
          require_citations: true
          sections:
            - id: premises
              label: "Premises"
              description: "List every entry point, user input, external data source, auth check, and secret in the changed files. Cite file:line."
            - id: trace
              label: "Attack Trace"
              description: "For each entry point [P<n>], trace untrusted data through the call chain to its sink. Note each sanitization/validation step or lack thereof."
            - id: verdict
              label: "Verdict"
              description: "List vulnerabilities found with severity. Each must cite the entry point premise and the specific trace gap."

      - id: logic
        agent: claude
        depends_on: [sec]
        intent: >
          Review this diff for logic errors only: off-by-one, null handling,
          incorrect state transitions, race conditions, unhandled edge cases.
          Do not flag security issues. Format each finding as: SEVERITY file:line — description — fix suggestion.
          If none found, say "No logic issues found."
          Write your full structured reasoning (Premises, Correctness Trace, Verdict)
          into the `artifact` output field.
        inputs:
          diff: "$.input.diff"
          context: "$.input.context"
        output_contract: LogicFindings
        ensure:
          - "result.findings is not None"
          - "result.findings != ''"
        retries: 2
        reasoning_template:
          require_citations: true
          sections:
            - id: premises
              label: "Premises"
              description: "List each function's stated contract (params, return, side effects) and each branch/edge case in the changed code. Cite file:line."
            - id: trace
              label: "Correctness Trace"
              description: "For each function [P<n>], walk through: null/empty inputs, boundary values, error paths, concurrent access. Does the implementation match the contract?"
            - id: verdict
              label: "Verdict"
              description: "List logic bugs and contract violations. Each must reference the specific premise and the input that breaks it."

      - id: perf
        agent: claude
        depends_on: [logic]
        intent: >
          Review this diff for performance issues only: N+1 queries, unnecessary
          allocations, blocking calls in async context, O(n²) where O(n) is possible.
          Only flag genuine concerns, not theoretical micro-optimizations.
          Format each finding as: SEVERITY file:line — description — fix suggestion.
          If none found, say "No performance issues found."
          Write your full structured reasoning (Premises, Scaling Trace, Verdict)
          into the `artifact` output field.
        inputs:
          diff: "$.input.diff"
          context: "$.input.context"
        output_contract: PerformanceFindings
        retries: 2
        reasoning_template:
          require_citations: true
          sections:
            - id: premises
              label: "Premises"
              description: "List each loop, query, allocation, I/O call, and data structure choice in the changed code. Cite file:line. Note expected data scale if available."
            - id: trace
              label: "Scaling Trace"
              description: "For each premise, analyze: time complexity, memory growth, N+1 patterns, unnecessary copies, missing indices. State the scaling factor."
            - id: verdict
              label: "Verdict"
              description: "List performance risks with estimated impact at scale. Each must cite the specific operation [P<n>] and its complexity."

      - id: report
        agent: claude
        depends_on: [perf]
        intent: >
          Consolidate security, logic, and performance findings into a review report.
          Deduplicate any findings that appear in multiple passes.
          Rank the top issues by severity. Write a one-sentence summary.
        inputs:
          security: "$.steps.sec.output.findings"
          logic: "$.steps.logic.output.findings"
          performance: "$.steps.perf.output.findings"
        output_contract: ReviewReport
        ensure:
          - "result.summary != ''"
        retries: 2
```

## Narration Pattern

```
Running security pass...
Running logic pass...
Running performance pass...

**Security:** [findings or "None"]
**Logic:** [findings or "None"]
**Performance:** [findings or "None"]

**Summary:** [one sentence]
```

After completion, call `stratum_audit` and note any steps that required retries.

## Memory

**Before writing the spec:** Read the project's `MEMORY.md` (at `.claude/memory/MEMORY.md` or the root). Find any lines tagged `[stratum-review]`. Incorporate them into the relevant `intent` fields — they encode project-specific patterns discovered in previous review sessions.

**After `stratum_audit`:** For each step with `attempts > 1`, ask: does the retry reason reveal something specific about this codebase (a recurring pattern, a module with known fragility, a class of issue this project tends to have)? If yes, append a one-liner to `MEMORY.md`:

```
[stratum-review] <pattern> — e.g. "auth middleware bypasses rate limiting for /internal routes"
[stratum-review] security: f-string SQL construction in db/queries.py — always check for injection
[stratum-review] logic: budget clone is not deep-copied — concurrent flows can race on token counter
```

Only write entries that would change how you write the spec next time. Skip generic observations like "output was vague" — those aren't project-specific.
