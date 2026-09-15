# Implementation review r1 (Codex gpt-6-astra, run 798d549bbde5, 2026-09-15)

I’ll read the spec, implementation, diff, and test fixtures, then check lifecycle and registry ownership paths. I won’t run tests or launch processes.

The sidecar echoes `from_mode` and keeps its registry paths tied to its own PID. I’m checking shutdown ordering and legacy test isolation next; both can fail despite the new tests using temporary directories.