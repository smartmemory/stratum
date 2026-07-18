# Design-gate review round 4 (codex gpt-5.6-terra/high) — REVISE

r3 finding (duplicate terminal writes) RESOLVED: claimFinalization serializes correctly, no deadlock. ONE residual finding in the same seam:

1. **High — cancel joining a pre-existing claim misreports its outcome.** Interleaving: error handler claims finalization, its appendFile still pending; cancel's scans see no sentinel; cancel calls claimFinalization(rc=130), RECEIVES THE ERROR CLAIM (doesn't own it), awaits it, then unconditionally returns 'cancelled' — but the sole committed sentinel is rc=1, so poll returns 'error'. (design.md:434, :466)
   Fix: make the claim carry terminal ownership/outcome (or an explicit finalization state machine). If cancel joins an existing claim: await it, rescan, return already_complete/already_error per the committed record. Return 'cancelled' ONLY when cancellation owns the rc=130 finalization. Add this exact pending-error-claim/cancel interleaving to the test plan.
