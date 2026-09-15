# Design review r4 (Codex gpt-6-astra, run 1c14816ab0ed, 2026-09-15)

I’ll read the revised design only and check whether the notification and cleanup rules close round 3.

1. **Low — editorial consistency:** “Terminal retention window” still says “every subscription the sidecar accepted gets exactly one notice,” omitting **non-replaced** and **attempt**. The invariant also says *every* cleanup follows linger, while signal shutdown explicitly has **no linger** and startup failure removes partial files immediately. Align these summaries with the explicit protocol and lifecycle rules.

REVIEW CLEAN

The round-3 architectural finding is closed: acceptance, replacement, rejection, best-effort attempts, and shutdown draining are explicitly defined. `peer.json` is included in the write-set invariant, and normal terminal cleanup follows the retention window.

No architectural must-fix or should-fix findings remain.