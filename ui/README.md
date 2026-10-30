# @smartmemory/stratum-ui

Runs and gates viewer for Stratum, as a components package plus a standalone shell (STRAT-UI-APP-1).

- `src/` is the package: `RunsList`, `RunDetail`, `GatesInbox`, `DataClientProvider`. Components never fetch; they call the `DataClient` in `src/data-client.ts`. Styles are plain CSS (`@smartmemory/stratum-ui/styles.css`, `sui-` prefix) themed through the host's shadcn tokens (`--background`, `--card`, `--border`, ...) and `--stratum-*` status tokens.
- `src/builder/` is the flow builder (`@smartmemory/stratum-ui/builder`, Base44 screens wired to the engine by STRAT-UI-BUILDER-1). It needs Tailwind in the host. Its state IS the engine spec document (`lib/spec.ts`): each step keeps exactly one kind key and is never re-encoded, so import then export is deep-equal. Validate calls the optional `DataClient.validateSpec` (the engine's own `validateSpec`; errors are pinned to the node their `path` names); Dry plan calls the optional `DataClient.planFlow`. A host without those methods gets disabled buttons. There is no run button.
- `server/` is a read-only local server: it reads run files from the flows dir and resolves gates through the `stratum` CLI with the round's `--token`. For the builder it serves `POST /api/validate` and `POST /api/plan` from the built engine (`--engine-dist`, default `../ts/dist`; 501 when absent). The plan is dry: a throwaway state dir under `--plan-scratch` (default the OS temp dir), deleted afterwards, with agent dispatch refused and no evaluate runner.
- `shell/` is the Vite app (hash routes `#/runs`, `#/runs/<id>`, `#/gates`, `#/builder`).

## Run

```sh
npm install
npm run build:shell
node server/serve.mjs --port <port> --static dist-shell \
  [--flows-dir ~/.stratum/ts/flows] [--stratum-bin ../ts/dist/cli/stratum.js] \
  [--engine-dist ../ts/dist] [--plan-scratch <dir>]
```

Dev: start the server, then `STRATUM_UI_API_PORT=<server port> STRATUM_UI_DEV_PORT=<port> npm run dev`.

The server binds 127.0.0.1 only. Gate buttons act on real runs: point `--flows-dir` at a scratch dir to try them.

## Live updates

`DataClient.subscribe?(runId, cb)` is optional. The standalone server serves it as server-sent events (`GET /api/runs/:id/live`) from one 1 s stat poll per process (`server/watch.mjs`): only subscribed run files are stat'ed, nothing is registered with the OS, and the timer is cleared on exit. A client without `subscribe` (Compose's may not have one) makes `RunDetail` poll every `pollMs` (5 s) instead.

## Using @smartmemory/stratum-ui

Install it next to React 18 or 19 (peer dependencies `react` and `react-dom` `>=18 <20`; the package never bundles React):

```sh
npm install @smartmemory/stratum-ui
```

```jsx
import { DataClientProvider, RunsList, RunDetail, GatesInbox } from "@smartmemory/stratum-ui";
import "@smartmemory/stratum-ui/styles.css"; // once, anywhere in the host

<DataClientProvider client={myDataClient}>
  <RunsList onOpenRun={(id) => ...} />
</DataClientProvider>
```

- `myDataClient` implements `DataClient` (`@smartmemory/stratum-ui/data-client` has the types and `CONTRACT_VERSION`). Components never fetch; the host decides where run data comes from.
- `@smartmemory/stratum-ui/builder` is the flow builder. It uses Tailwind classes, so the host runs Tailwind over `node_modules/@smartmemory/stratum-ui/dist/builder.js`.
- `@smartmemory/stratum-ui/server` is the read-only Node handler (`createHandler({ flowsDir, stratumBin, ... })`, plain `.mjs`, no build), for a host that mounts the same `/api/*` routes the standalone server serves (Compose mounts it under `/api/stratum-ui`).

Publish (local, by the owner): `npm run build` (Vite library build into `dist/` plus declarations), check `npm pack --dry-run` (dist, server, README, LICENSE only), then `npm publish --access public`. `npm run build:shell` builds the standalone shell into `dist-shell/`, which is never published.

## Test

```sh
npx tsc --noEmit
npx vitest run --maxWorkers=4
```
