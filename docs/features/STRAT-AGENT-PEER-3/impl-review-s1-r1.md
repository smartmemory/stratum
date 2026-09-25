NOT CLEAN

Scope: uncommitted SLICE 1 changes only; repository files left unchanged. No full suite or paid/live model probes run.

1. **MEDIUM — Identity gate accepts malformed, unrecognized identity shapes.**

   Evidence: `ts/src/connectors/codex-appserver-contract.ts:10-16` requires a pinned version followed by almost arbitrary parenthesized text; it does not validate the observed platform/client suffix structure and rejects only CR/LF control characters. Executing the actual function after TypeScript transpilation returned `0.155.1` for all of:

   - `client/0.155.1 (garbage)`
   - `client/0.155.1 (x) trailing junk`
   - `client/0.155.1 (Mac OS; arm64) (different-client; 9.9.9)`
   - `client/0.155.1 (` + NUL + `)`

   Unknown versions are rejected correctly, and the version is correctly taken after the first slash rather than from the final client-version field. However, the malformed-identity acceptance violates S1's fail-closed requirement. Existing negative cases at `ts/tests/connectors/codex-appserver-contract.test.ts:53-60` miss these inputs.

   Suggested fix: validate an explicit supported user-agent grammar based on the observed `<clientName>/<CLI version> (<platform>; <arch>) ... (<clientName>; <clientVersion>)` form, reject control characters and malformed groups, and check the repeated client identity (preferably against initialize clientInfo). Allow documented platform/terminal variation without accepting arbitrary tails. Add the above negative cases alongside real positive probe strings. This remains a compatibility check, not proof against schema changes within the same version.

2. **LOW — Unused raw bindings and type-only emit add avoidable repository/package weight.**

   Evidence: `ts/contracts/codex-appserver/0.155.1/manifest.json:4-24` selects 19 roots; the dependency walker at `ts/scripts/pin-codex-appserver.mjs:38-48` reaches **308 generated files**, plus `pinned-version.ts`. Thus **413 of the 721 raw bindings are outside even the selected closure**. Keeping their raw contents is unnecessary for compiling/checking this contract; a closure plus generation metadata and hash manifest suffices.

   The adapted 308-file closure is justified by the current roots, particularly full `ServerRequest` and `ServerNotification` unions. Removing those two roots shrinks it to 107 files, but that would omit explicitly required S1 unions; do not make that reduction silently.

   The quoted 3.0 MB/1.2 MB sizes are filesystem allocation, not payload bytes: measured contents are **494,363 bytes across 722 raw files** and **156,764 bytes across 309 adapted files**. Raw fixtures are not shipped. However, `ts/tsconfig.build.json:4-10` emits every source `.ts`, and `ts/package.json:20-22` ships `dist`. An isolated compiler emit produced **618 protocol `.js`/`.js.map` files totaling 104,926 bytes**. The 308 type-only modules emit empty-module stubs, e.g. `ThreadStartParams.js` contains a generated comment, `export {};`, and a source-map reference. These are dead runtime artifacts, not 1.2 MB of runtime code.

   Suggested fix: retain the exact raw closure with provenance/hashes, and emit adapted type bindings as declaration files (or explicitly remove verified type-only emitted artifacts during packaging). Keep `pinned-version.ts` as the small runtime module. Update inventory checks accordingly.

Other requested checks:

- **AC02 passes for the reviewed inputs.** Extracted the actual old `codexExecArgs` from `git show HEAD:ts/src/connectors/codex.ts` and evaluated it against all 144 literal fixtures: `count: 144, mismatches: [], defaultMatch: true`. Fixtures at `ts/tests/connectors/codex-policy.test.ts:7-153` are literal arrays, not computed by the new encoder. The new encoder preserves ordering, JSON quoting, effort placement and final stdin marker; the wrapper also preserves defaults and sandboxMode precedence.
- **App-server encoding matches §4 and generated types.** `codex-policy.ts:30-42` rejects on-failure; places model/cwd/approvalPolicy on thread and effort/sandboxPolicy on turn; forces read-only network false; copies workspace roots/network and sets both temp exclusions false; omits absent effort. Full-access authorization remains at the existing dispatch boundary. Live temp-policy parity remains unverified here, as explicitly deferred by the plan.
- **Pin integrity passes.** `node ts/scripts/pin-codex-appserver.mjs --check` returned `{"version":"0.155.1","rawFiles":721,"adaptedFiles":309}`. Independently regenerated default bindings into a fresh temporary directory: all **721 file hashes exactly match** the manifest. Production imports use local source/emitted modules; no runtime dependency on tests, the raw fixture directory, or `/tmp` was found.
- **Test quality:** argv fixtures are strong independent regression evidence; raw/adapted mutation tests exercise actual integrity checks. Typed unattended replies correctly include elicitation `_meta:null` and input `text_elements:[]`. Error-method tests at `codex-appserver-contract.test.ts:89-91` merely repeat the same constant assertion without using the method; they do not verify dispatch. That behavioral work belongs to S2. Adapter inventory/missing-dependency/unsupported-manifest/write branches and probe spawn-error/signal/escalation/descendant-cleanup paths lack focused coverage. No additional functional dead code was found; the presently uncalled identity gate is an intentional S2 integration seam.

Verification:

- Focused policy, contract and existing Codex tests: **347/347 passed**.
- `npm --prefix ts run typecheck`: **passed**.
- Isolated `tsc -p ts/tsconfig.build.json --outDir /tmp/...`: **passed**; repository dist was not rebuilt.
- Background Claude peer tests: **6 passed, 4 failed** waiting for peer discovery at `background-claude-peer.test.ts:39`. A separate Unix-socket capability check returned `EPERM listen EPERM: operation not permitted`. Peer-enabled behavior therefore remains blocked in this review environment; the emitted-JS peer-disabled case passed. These failures are not evidence of an S1 regression.
