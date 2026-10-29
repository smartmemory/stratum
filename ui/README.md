# @stratum/ui

Runs and gates viewer for Stratum, as a components package plus a standalone shell (STRAT-UI-APP-1).

- `src/` is the package: `RunsList`, `RunDetail`, `GatesInbox`, `DataClientProvider`. Components never fetch; they call the `DataClient` in `src/data-client.ts`. Styles are plain CSS (`@stratum/ui/styles.css`, `sui-` prefix) themed through the host's shadcn tokens (`--background`, `--card`, `--border`, ...) and `--stratum-*` status tokens.
- `src/builder/` is the Base44 flow builder, vendored as-is (`@stratum/ui/builder`). It needs Tailwind in the host. Not wired to the engine yet (STRAT-UI-BUILDER-1).
- `server/` is a read-only local server: it reads run files from the flows dir and resolves gates through the `stratum` CLI with the round's `--token`.
- `shell/` is the Vite app (hash routes `#/runs`, `#/runs/<id>`, `#/gates`, `#/builder`).

## Run

```sh
npm install
npm run build
node server/serve.mjs --port <port> --static dist \
  [--flows-dir ~/.stratum/ts/flows] [--stratum-bin ../ts/dist/cli/stratum.js]
```

Dev: start the server, then `STRATUM_UI_API_PORT=<server port> STRATUM_UI_DEV_PORT=<port> npm run dev`.

The server binds 127.0.0.1 only. Gate buttons act on real runs: point `--flows-dir` at a scratch dir to try them.

## Test

```sh
npx tsc --noEmit
npx vitest run --maxWorkers=4
```
