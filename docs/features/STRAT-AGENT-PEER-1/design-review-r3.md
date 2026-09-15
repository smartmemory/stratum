# Design review r3 (Codex gpt-6-astra, run 3b547034dec1, 2026-09-15)

I’ll read only the revised design and check whether the three fixes leave any architectural gaps.

1. **should-fix — The “every accepted subscription gets exactly one notice” guarantee still conflicts with the protocol and shutdown rules.** Subscriptions use “dedupe on `from`, latest wins,” so a second subscription can silently replace an accepted `msg_id`; the cap of 32 has no defined acceptance/overflow behavior. Callbacks are also best effort, and cleanup at the linger deadline does not specify draining accepted requests or in-flight callbacks. Define acceptance, replacement/rejection, and shutdown behavior explicitly; promise exactly one **notification attempt** per accepted subscription unless stronger delivery semantics are provided.

**Assessment of fixes 1–3:** The retention window addresses fast completion and late subscription during the window, but the acceptance guarantee needs the clarification above. Deterministic naming plus sidecar-owned `peer.json` closes the fatal `meta.json` publication problem, with the added failure test covering isolation. The controlled-release child closes the golden flow’s fixed-sleep race; immediate terminal responses cover subscriptions processed after release.

Minor editorial cleanup remains: the write-only invariant excludes the newly authorized `peer.json`, and several lifecycle descriptions still say cleanup occurs immediately at completion. Align these with the revised wiring.