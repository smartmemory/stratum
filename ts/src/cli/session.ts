import { parseArgs } from "node:util";
import {
  type AdmitInput,
  cliExitFor,
  createSessionBackend,
  type Envelope,
  type JobsRegisterInput,
  type LaunchInput,
  MARKER_CAP_BYTES,
  type PickInput,
  type SessionBackend,
} from "../session/index.js";

/**
 * `stratum session <verb>` (SESSION-MGMT-1, contract `operations.*.cli`, `cli_exit_codes`).
 * U1 verbs: pick, jobs, register; U2: admit, launch, status, fleet, hop. Each prints the envelope (`--json`) or a short text form,
 * and exits 0 ok, 1 refused by policy, 2 usage, 3 waited/held, 4 backend problem, 5 partial.
 */

const USAGE = [
  "Usage: stratum session <verb> ... [--json]",
  "  pick --kind KIND [--author-vendor claude|codex] [--name NAME]       choose an account (read-only)",
  "  jobs [--session S]                                                  list the job registry (read-only)",
  "  register --session S --kind K --id ID [--report ABS] [--collect T] [--label L] [--pid N] [--log ABS]",
  "           [--work-kind K] [--vendor claude|codex] [--model M] [--account ID] [--priority P0..P3]   record a job (writes the registry)",
  "  admit --engine claude|codex --label L [--model M] [--account inherit|auto|ID] [--marker-file ABS]",
  "        [--launch-gate full|none] [--max-wait-s N]   may this launch start, on which account (marker text on stdin without --marker-file)",
  "  launch --session S --label L --engine claude|codex --model M --brief ABS --report ABS [--effort E] [--cwd ABS]",
  "         [--work-kind K] [--priority P0..P3] [--account inherit|auto|ID] [--max-wait-s N]   admit (full gate) then start a detached job",
  "  status                                                              accounts, pick recommendation and launch gate (read-only)",
  "  fleet                                                               alive detached Claude jobs vs the fleet cap (read-only)",
  "  hop --check NAME                                                    does session NAME need a hop (read-only)",
  "  hop NAME --dry-run [--to T] [--reason R]                            the hop plan, no tab or session change",
  "  hop NAME --live [--to T] [--reason R] [--force] [--allow-closed]    move session NAME to another account (a NAME starting with - goes after --)",
  "      exactly one of --check / --dry-run / --live: none is a usage error, never a default",
  "Exit: 0 ok, 1 refused by policy, 2 usage, 3 waited/held, 4 backend problem, 5 partial.",
].join("\n");

export async function sessionCommand(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    if (verb === "pick") return await pickVerb(rest);
    if (verb === "jobs") return await jobsVerb(rest);
    if (verb === "register") return await registerVerb(rest);
    if (verb === "admit") return await admitVerb(rest);
    if (verb === "launch") return await launchVerb(rest);
    if (verb === "status") return await readOnlyVerb(rest, (backend) => backend.status());
    if (verb === "fleet") return await readOnlyVerb(rest, (backend) => backend.fleet());
    if (verb === "policy") return await readOnlyVerb(rest, (b) => b.policy());
    if (verb === "hop") return await hopVerb(rest);
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message);
    throw error;
  }
  return usage(verb === undefined ? "missing verb" : `unknown verb ${JSON.stringify(verb)}`);
}

class UsageError extends Error {}

function usage(message: string): number {
  process.stderr.write(`stratum session: ${message}\n${USAGE}\n`);
  return 2;
}

type OptionSpec = Record<string, { type: "string" | "boolean" }>;

function parse(args: readonly string[], options: OptionSpec): Record<string, string | boolean | undefined> {
  try {
    const { values } = parseArgs({ args: [...args], options: { ...options, json: { type: "boolean" } }, strict: true, allowPositionals: false });
    return values as Record<string, string | boolean | undefined>;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function str(values: Record<string, string | boolean | undefined>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function emit(envelope: Envelope<unknown>, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (envelope.ok) {
    process.stdout.write(`ok ${envelope.op} (${envelope.backend})\n${JSON.stringify(envelope.data, null, 2)}\n`);
  } else {
    process.stdout.write(`REFUSED ${envelope.refusal.code}: ${envelope.refusal.reason}\n`);
  }
  return cliExitFor(envelope);
}

async function pickVerb(args: readonly string[]): Promise<number> {
  const values = parse(args, { kind: { type: "string" }, "author-vendor": { type: "string" }, name: { type: "string" } });
  const kind = str(values, "kind");
  if (kind === undefined) throw new UsageError("pick needs --kind");
  const authorVendor = str(values, "author-vendor");
  const name = str(values, "name");
  const input = {
    kind,
    ...(authorVendor !== undefined ? { authorVendor } : {}),
    ...(name !== undefined ? { name } : {}),
  } as PickInput;
  return emit(await createSessionBackend().pick(input), values.json === true);
}

async function jobsVerb(args: readonly string[]): Promise<number> {
  const values = parse(args, { session: { type: "string" } });
  const session = str(values, "session");
  return emit(await createSessionBackend().jobsList(session !== undefined ? { session } : {}), values.json === true);
}

const REGISTER_FLAGS = {
  session: "session", kind: "kind", id: "id", report: "report", collect: "collect", label: "label", pid: "pid", log: "log",
  "work-kind": "workKind", vendor: "vendor", model: "model", account: "account", priority: "priority",
} as const;

async function registerVerb(args: readonly string[]): Promise<number> {
  const values = parse(args, Object.fromEntries(Object.keys(REGISTER_FLAGS).map((flag) => [flag, { type: "string" as const }])));
  const input: Record<string, string | number> = {};
  for (const [flag, key] of Object.entries(REGISTER_FLAGS)) {
    const value = str(values, flag);
    if (value === undefined) continue;
    if (key === "pid") {
      if (!/^[1-9][0-9]*$/.test(value)) throw new UsageError("--pid must be a positive integer");
      input.pid = Number(value);
    } else {
      input[key] = value;
    }
  }
  for (const required of ["session", "kind", "id"]) if (input[required] === undefined) throw new UsageError(`register needs --${required}`);
  return emit(await createSessionBackend().jobsRegister(input as unknown as JobsRegisterInput), values.json === true);
}

/** `--max-wait-s N`: a finite number (the backend checks the range [1, 1800]). */
function maxWait(values: Record<string, string | boolean | undefined>): number | undefined {
  const raw = str(values, "max-wait-s");
  if (raw === undefined) return undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) throw new UsageError("--max-wait-s must be a number of seconds");
  return Number(raw);
}

/** The marker on stdin: never read from a TTY; at most the cap (the backend truncates to the head too). */
async function readMarker(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > MARKER_CAP_BYTES) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : text;
}

async function admitVerb(args: readonly string[]): Promise<number> {
  const values = parse(args, {
    engine: { type: "string" }, label: { type: "string" }, model: { type: "string" }, account: { type: "string" },
    "marker-file": { type: "string" }, "launch-gate": { type: "string" }, "max-wait-s": { type: "string" },
  });
  const engine = str(values, "engine");
  const label = str(values, "label");
  if (engine === undefined) throw new UsageError("admit needs --engine");
  if (label === undefined) throw new UsageError("admit needs --label");
  const markerFile = str(values, "marker-file");
  const markerText = markerFile === undefined ? await readMarker() : undefined;
  const optional: Record<string, string | number | undefined> = {
    model: str(values, "model"), account: str(values, "account"), launchGate: str(values, "launch-gate"),
    maxWaitS: maxWait(values), markerFile, markerText,
  };
  const input = {
    engine, label, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  } as unknown as AdmitInput;
  // contract `operations.admit.cli`: the CLI's own process env IS the candidate child env.
  const result = await createSessionBackend().admit(input, { childEnv: process.env });
  const { childEnv: _childEnv, ...envelope } = result;
  return emit(envelope as Envelope<unknown>, values.json === true);
}

/** A verb with no options besides --json. */
async function readOnlyVerb(args: readonly string[], call: (backend: SessionBackend) => Promise<Envelope<unknown>>): Promise<number> {
  const values = parse(args, {});
  return emit(await call(createSessionBackend()), values.json === true);
}

const LAUNCH_FLAGS = {
  session: "session", label: "label", engine: "engine", model: "model", effort: "effort", brief: "brief", report: "report", cwd: "cwd",
  "work-kind": "workKind", priority: "priority", account: "account",
} as const;

async function launchVerb(args: readonly string[]): Promise<number> {
  const values = parse(args, {
    ...Object.fromEntries(Object.keys(LAUNCH_FLAGS).map((flag) => [flag, { type: "string" as const }])), "max-wait-s": { type: "string" },
  });
  const input: Record<string, string | number> = {};
  for (const [flag, key] of Object.entries(LAUNCH_FLAGS)) {
    const value = str(values, flag);
    if (value !== undefined) input[key] = value;
  }
  for (const required of ["session", "label", "engine", "model", "brief", "report"]) {
    if (input[required] === undefined) throw new UsageError(`launch needs --${required}`);
  }
  const wait = maxWait(values);
  if (wait !== undefined) input.maxWaitS = wait;
  return emit(await createSessionBackend().launch(input as unknown as LaunchInput), values.json === true);
}

/**
 * contract `operations.hop.cli`: exactly one door, each a literal branch calling its own backend method (forge-e0 ruling 3: no
 * helper takes the mode as a value). --check NAME takes no positional and no plan flags; --dry-run / --live take exactly one
 * positional name; --force / --allow-closed go with --live only.
 */
async function hopVerb(args: readonly string[]): Promise<number> {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...args], strict: true, allowPositionals: true,
      options: {
        check: { type: "string" }, "dry-run": { type: "boolean" }, live: { type: "boolean" }, to: { type: "string" }, reason: { type: "string" },
        force: { type: "boolean" }, "allow-closed": { type: "boolean" }, json: { type: "boolean" },
      },
    }) as typeof parsed;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const check = str(values, "check");
  const dryRun = values["dry-run"] === true;
  const live = values.live === true;
  if ((check !== undefined ? 1 : 0) + (dryRun ? 1 : 0) + (live ? 1 : 0) !== 1) {
    throw new UsageError("hop needs exactly one of --check NAME, --dry-run, --live (there is no default)");
  }
  const to = str(values, "to");
  const reason = str(values, "reason");
  const force = values.force === true;
  const allowClosed = values["allow-closed"] === true;
  const json = values.json === true;
  if (check !== undefined) {
    if (positionals.length !== 0) throw new UsageError("hop --check NAME takes no positional name");
    if (to !== undefined || reason !== undefined || force || allowClosed) throw new UsageError("hop --check takes no --to, --reason, --force or --allow-closed");
    return emit(await createSessionBackend().hopCheck({ name: check }), json);
  }
  if (positionals.length !== 1) throw new UsageError("hop --dry-run / --live takes exactly one session name");
  const name = positionals[0]!;
  const plan = { name, ...(to !== undefined ? { to } : {}), ...(reason !== undefined ? { reason } : {}) };
  if (dryRun) {
    if (force || allowClosed) throw new UsageError("--force and --allow-closed go with --live only");
    return emit(await createSessionBackend().hopDryRun(plan), json);
  }
  if (live) {
    return emit(await createSessionBackend().hopLive({ ...plan, ...(force ? { force: true } : {}), ...(allowClosed ? { allowClosed: true } : {}) }), json);
  }
  throw new UsageError("hop needs exactly one of --check NAME, --dry-run, --live (there is no default)");
}
