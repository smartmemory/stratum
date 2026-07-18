# Design-gate review round 3 (codex gpt-5.6-terra/high) — REVISE

All 4 r2 findings verified RESOLVED ({"$array":"string"} grammar; post-terminate rescan; discriminant validation; registry deletion). ONE remaining finding:

1. **High — terminal sentinel writes still not serialized.** The error handler appends error+sentinel directly while the exit handler independently does scan-then-append; if exit runs before the error append completes, both append a sentinel. Two concurrent cancels can likewise both rescan "no sentinel" and both append rc=130. scanStream() takes the LAST sentinel, so the terminal outcome is timing-dependent. Fix: define ONE per-run finalization promise/lock (e.g. chain on the ClaudeBgEntry: finalize work through a single serialized promise) used by error, exit, AND cancel paths — it must commit at most one terminal record, then delete the registry entry. (design.md:317, :331, :418, :451; last-sentinel parsing background.ts:207)
