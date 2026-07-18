# Plan-gate review round 4 (codex gpt-5.6-terra/high) — REVISE

Both r3 fixes verified present (STRATUM_TEST_WORKER stub in Step 3, consistent 7c/7d refs, vi.mock Worker seam for D9, normal-lifecycle mirrored). ONE remaining P1 + one cleanup:

1. **P1 — immediate-complete stub cannot produce a running worker.** 7c requires an in-flight cancel "with worker completing after cancel returns" and both 7c/7d require a guaranteed 'running' poll — but the documented stub writes its records and rc=0 sentinel immediately, so those tests race the completion path. (blueprint.md:589, :925, :931, :998) Fix: either (a) extend the env seam with a held-worker behavior (e.g. STRATUM_TEST_WORKER=hold → worker waits for a release file/signal before writing the sentinel), or (b) explicitly use the vi.mock Worker-constructor seam for the running/cancel-in-flight cases too. Pick one and spec it where the tests reference it.
2. **Cleanup — remove the superseded workerData-query TODO (blueprint.md:869)**, which still contradicts the chosen seam.
