import { parseArgs } from "node:util";
import {
  cliExitFor,
  createSessionBackend,
  type Envelope,
  type JobsRegisterInput,
  type PickInput,
} from "../session/index.js";

/**
 * `stratum session <verb>` (SESSION-MGMT-1, contract `operations.*.cli`, `cli_exit_codes`).
 * U1 verbs: pick, jobs, register. Each prints the envelope (`--json`) or a short text form,
 * and exits 0 ok, 1 refused by policy, 2 usage, 3 waited/held, 4 backend problem, 5 partial.
 */

const USAGE = [
  "Usage: stratum session <verb> ... [--json]",
  "  pick --kind KIND [--author-vendor claude|codex] [--name NAME]       choose an account (read-only)",
  "  jobs [--session S]                                                  list the job registry (read-only)",
  "  register --session S --kind K --id ID [--report ABS] [--collect T] [--label L] [--pid N] [--log ABS]",
  "           [--work-kind K] [--vendor claude|codex] [--model M] [--account ID] [--priority P0..P3]   record a job (writes the registry)",
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
