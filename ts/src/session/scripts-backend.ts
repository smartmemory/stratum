import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { SessionConfig } from "../config/index.js";
import {
  type AdmitData,
  type AdmitInput,
  type AdmitResult,
  type BackendKind,
  ENGINE_HOME_VAR,
  type Envelope,
  type FleetData,
  type PolicyData,
  firstLine,
  type GateStatus,
  type HopCheckInput,
  type HopData,
  type HopDryRunInput,
  type HopLiveInput,
  HOP_RESULTS,
  type HopResult,
  isRefusalCode,
  JOB_KINDS,
  type JobsListData,
  type LaunchData,
  type LaunchInput,
  type JobsListInput,
  type JobsRegisterData,
  type JobsRegisterInput,
  okEnvelope,
  PICK_KINDS,
  type PickData,
  type PickInput,
  PRIORITIES,
  type RefusalCode,
  refused,
  type SessionBackend,
  type SessionOp,
  type StatusData,
  VENDORS,
  WORK_KINDS,
} from "./backend.js";

/**
 * SESSION-MGMT-1-U1: the scripts backend (contract `backend.exec`, `backend.stdin`,
 * `backend.child_env_rule`, `operations.*`).
 *
 * Every script runs as `spawn(python, [script, ...args], { shell: false })`: an argv
 * array, never a shell string. `execFile` is not used because it does not pass
 * `detached` (the child must lead its own process group so a timeout can kill the whole
 * group) or a per-stream `stdio` (stdin must be 'ignore' for every op except admit).
 */

/** contract `operations.<op>.timeout_s` (admit: max_wait_s + 60; hop has one per mode: check 60, dry-run 60, live 300). */
export const OP_TIMEOUT_S: Readonly<Record<Exclude<SessionOp, "admit" | "hop">, number>> = Object.freeze({
  pick: 60,
  launch: 60,
  status: 90,
  fleet: 30,
  jobs_list: 30,
  jobs_register: 30,
  policy: 30,
});

/** contract `backend.stdin`: the gate's FILE_CAP (work_model_gate.py:73). */
export const MARKER_CAP_BYTES = 262_144;
const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const STDERR_KEEP_BYTES = 64 * 1024;
const MAX_WAIT_DEFAULT_S = 120;

/** contract `backend.child_env_rule`: never handed to a script. */
export const STRIPPED_ENV = Object.freeze(["CLAUDECODE", "LAUNCH_GATE_ADMITTED"] as const);

export function scriptEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

export interface ScriptsBackendOptions {
  /** The front door's own process env (ops other than admit run with it, minus STRIPPED_ENV). */
  readonly env: NodeJS.ProcessEnv;
  readonly config: SessionConfig;
  /** Test seam: per-op timeout override in milliseconds. */
  readonly timeoutsMs?: Partial<Record<SessionOp, number>>;
}

type RunOutcome =
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "signal"; readonly signal: string; readonly stderr: string }
  | { readonly kind: "timeout"; readonly stderr: string }
  | { readonly kind: "overflow"; readonly stderr: string }
  | { readonly kind: "spawn-error"; readonly code: string; readonly message: string };

/** Run one script. Resolves on every path; never throws. */
export function runScript(
  python: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinText: string | null,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, [...argv], {
        shell: false,
        detached: true,
        env,
        stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      resolve({ kind: "spawn-error", code: err.code ?? "UNKNOWN", message: err.message });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = Buffer.alloc(0);
    let killedFor: "timeout" | "overflow" | null = null;
    const killGroup = (why: "timeout" | "overflow"): void => {
      killedFor ??= why;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => killGroup("timeout"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_CAP_BYTES) { killGroup("overflow"); return; }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_KEEP_BYTES) err = Buffer.concat([err, chunk]).subarray(0, STDERR_KEEP_BYTES);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ kind: "spawn-error", code: error.code ?? "UNKNOWN", message: error.message });
    });
    child.on("close", (code, signal) => {
      const stderr = err.toString("utf8");
      if (killedFor === "timeout") return finish({ kind: "timeout", stderr });
      if (killedFor === "overflow") return finish({ kind: "overflow", stderr });
      if (code === null) return finish({ kind: "signal", signal: signal ?? "unknown", stderr });
      finish({ kind: "exit", code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    });
    if (stdinText !== null && child.stdin) {
      // A script that exits without reading its stdin raises EPIPE here; its exit decides.
      child.stdin.on("error", () => undefined);
      child.stdin.end(truncateUtf8(stdinText, MARKER_CAP_BYTES));
    }
  });
}

/** The head of `text`, at most `cap` UTF-8 bytes, never splitting a character. */
export function truncateUtf8(text: string, cap: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return bytes;
  let end = cap;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

// ---------------------------------------------------------------- stdout parsing and shapes

const NO_JSON = Symbol("no-json");
const BAD_JSON = Symbol("bad-json");

/** stdout must be ONE JSON document (contract `backend.exec`); whitespace only = none. */
function parseStdout(stdout: string): unknown | typeof NO_JSON | typeof BAD_JSON {
  if (stdout.trim() === "") return NO_JSON;
  try {
    return JSON.parse(stdout);
  } catch {
    return BAD_JSON;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPosInt = (value: unknown): value is number => isNonNegInt(value) && value > 0;
const isOneOf = (list: readonly string[], value: unknown): boolean => typeof value === "string" && list.includes(value);

/** A validator returns null when `doc` has the op's shape for this exit, else what is wrong. */
type Validator = (doc: unknown, exit: number) => string | null;

/**
 * Field tables: one entry per contracted key, `[key, test, what it must be]`. A required key must be
 * present and pass; an optional key is checked only when present. The table is the shape, so a new
 * contract key is one row, and the same table answers the success record and the refusal record.
 */
type FieldTable = ReadonlyArray<readonly [key: string, test: (value: unknown) => boolean, expected: string]>;

function tableProblem(what: string, record: Record<string, unknown>, required: FieldTable, optional: FieldTable): string | null {
  for (const [key, test, expected] of required) {
    if (!(key in record)) return `${what} lacks ${key}`;
    if (!test(record[key])) return `${what} ${key} is not ${expected}`;
  }
  for (const [key, test, expected] of optional) {
    if (key in record && !test(record[key])) return `${what} ${key} is not ${expected}`;
  }
  return null;
}

const isString = (value: unknown): boolean => typeof value === "string";
const SEAT_STATES = ["reserved", "closed", "weekly", "unstarted", "behind", "ahead"] as const;
const JOB_STATUSES = ["running", "done"] as const;
const PRIORITY_SOURCES = ["explicit", "defaulted", "set"] as const;
const JOB_OUTCOMES = ["passed", "failed", "superseded"] as const;
const DIAGNOSTIC_KINDS = ["bad-line", "degraded", "source-unreadable"] as const;
const DIAGNOSTIC_SOURCES = ["registry", "priority", "queue"] as const;

/** contract `operations.pick.script_output.choice`. */
const PICK_CHOICE_FIELDS: FieldTable = [
  ["id", isString, "a string"], ["vendor", (v) => isOneOf(VENDORS, v), `one of ${VENDORS.join(", ")}`], ["label", isStringOrNull, "string|null"], ["command", isString, "a string"],
];
/** contract `operations.pick.script_output.seats[]`; `used` is null for a seat with no usable 5h reading (usage_watch.py:1908). */
const PICK_SEAT_REQUIRED: FieldTable = [
  ["id", isString, "a string"],
  ["ceiling", isFiniteNumber, "a finite number"],
  ["used", (v) => v === null || isFiniteNumber(v), "a finite number|null"],
  ["state", (v) => isOneOf(SEAT_STATES, v), `one of ${SEAT_STATES.join(", ")}`],
  ["detail", isString, "a string"],
];
const PICK_SEAT_OPTIONAL: FieldTable = [["target", isFiniteNumber, "a finite number"], ["behind", isFiniteNumber, "a finite number"]];

function pickValidator(input: PickInput): Validator {
  return (doc, exit) => {
    if (!isRecord(doc)) return "pick output is not an object";
    if (typeof doc.kind !== "string") return "pick output lacks kind";
    if (doc.kind !== input.kind) return "pick output kind does not match the request";
    if (typeof doc.reason !== "string" || typeof doc.rule !== "string") return "pick output lacks reason/rule";
    if (!("choice" in doc)) return "pick output lacks choice";
    if (doc.choice !== null) {
      if (!isRecord(doc.choice)) return "pick output choice is not null|{id, vendor, label, command}";
      const wrong = tableProblem("pick output choice", doc.choice, PICK_CHOICE_FIELDS, []);
      if (wrong !== null) return wrong;
    }
    if (doc.code !== undefined && doc.code !== "ahead-of-pace") return "pick output code is not 'ahead-of-pace'";
    if (doc.seats !== undefined) {
      if (!Array.isArray(doc.seats)) return "pick output seats is not an array";
      for (const seat of doc.seats) {
        if (!isRecord(seat)) return "pick output seat row is not an object";
        const wrong = tableProblem("pick output seat row", seat, PICK_SEAT_REQUIRED, PICK_SEAT_OPTIONAL);
        if (wrong !== null) return wrong;
      }
    }
    // The exit and the record must agree (usage_watch.py:3254).
    if (exit === 0 && doc.choice === null) return "pick exit 0 without a choice";
    if (exit === 1 && (doc.choice !== null || doc.code !== undefined)) return "pick exit 1 with a choice or a code";
    if (exit === 3 && (doc.choice !== null || doc.code !== "ahead-of-pace")) return "pick exit 3 without code 'ahead-of-pace'";
    return null;
  };
}

/** The registry fields shared by a list row and the stored add event (claude/scripts/json-contract.json `list`, jobs.py:296-312). */
const JOB_OPTIONAL_FIELDS: FieldTable = [
  ["pid", isPosInt, "a positive integer"], ["log", isString, "a string"], ["work_kind", (v) => isOneOf(WORK_KINDS, v), `one of ${WORK_KINDS.join(", ")}`],
  ["vendor", (v) => isOneOf(VENDORS, v), `one of ${VENDORS.join(", ")}`], ["model", isString, "a string"], ["account", isString, "a string"],
  ["for_id", isString, "a string"], ["session_id", isString, "a string"],
  ["done_ts", isFiniteNumber, "a finite number"], ["outcome", (v) => isOneOf(JOB_OUTCOMES, v), `one of ${JOB_OUTCOMES.join(", ")}`],
  ["rounds", isNonNegInt, "a non-negative integer"],
];
/** Required `list` keys (json-contract.json:6). */
const JOB_ROW_REQUIRED: FieldTable = [
  ["op", (v) => v === "add", "'add'"], ["session", isString, "a string"], ["kind", (v) => isOneOf(JOB_KINDS, v), `one of ${JOB_KINDS.join(", ")}`],
  ["id", isString, "a string"], ["report", isStringOrNull, "string|null"], ["collect", isStringOrNull, "string|null"], ["label", isStringOrNull, "string|null"],
  ["ts", isFiniteNumber, "a finite number"], ["status", (v) => isOneOf(JOB_STATUSES, v), `one of ${JOB_STATUSES.join(", ")}`],
  ["priority", (v) => isOneOf(PRIORITIES, v), `one of ${PRIORITIES.join(", ")}`],
  ["priority_source", (v) => isOneOf(PRIORITY_SOURCES, v), `one of ${PRIORITY_SOURCES.join(", ")}`],
];
/** `diagnostics.item` (json-contract.json:56): kind, source, file, line, reason, affects. */
const DIAGNOSTIC_REQUIRED: FieldTable = [
  ["kind", (v) => isOneOf(DIAGNOSTIC_KINDS, v), `one of ${DIAGNOSTIC_KINDS.join(", ")}`],
  ["source", (v) => isOneOf(DIAGNOSTIC_SOURCES, v), `one of ${DIAGNOSTIC_SOURCES.join(", ")}`],
  ["file", isString, "a string"],
  ["line", (v) => v === null || isNonNegInt(v), "a non-negative integer|null"],
  ["reason", isString, "a string"],
  ["affects", (v) => Array.isArray(v) && v.every((a) => isRecord(a) && typeof a.session === "string" && "id" in a && isStringOrNull(a.id)), "an array of {session, id: string|null}"],
];

const jobsListValidator: Validator = (doc) => {
  if (!isRecord(doc)) return "jobs list output is not {rows, bad_count, diagnostics}";
  if (!Array.isArray(doc.rows) || !Array.isArray(doc.diagnostics)) return "jobs list rows/diagnostics are not arrays";
  if (!isNonNegInt(doc.bad_count)) return "jobs list bad_count is not a non-negative integer";
  for (const row of doc.rows) {
    if (!isRecord(row)) return "jobs list row is not an object";
    const wrong = tableProblem("jobs list row", row, JOB_ROW_REQUIRED, JOB_OPTIONAL_FIELDS);
    if (wrong !== null) return wrong;
  }
  for (const item of doc.diagnostics) {
    if (!isRecord(item)) return "jobs list diagnostic is not an object";
    const wrong = tableProblem("jobs list diagnostic", item, DIAGNOSTIC_REQUIRED, []);
    if (wrong !== null) return wrong;
  }
  return null;
};

/** The stored add event (jobs.py:296-312): the list row without the folded `status`, `priority`, `priority_source`, `done_ts`, `outcome`, `rounds`. */
const REGISTER_REQUIRED: FieldTable = JOB_ROW_REQUIRED.filter(([key]) => !["status", "priority", "priority_source"].includes(key));
const REGISTER_OPTIONAL: FieldTable = [
  ...JOB_OPTIONAL_FIELDS.filter(([key]) => !["done_ts", "outcome", "rounds"].includes(key)),
  ["priority", (v) => isOneOf(PRIORITIES, v), `one of ${PRIORITIES.join(", ")}`],
  ["priority_source", (v) => v === "explicit", "'explicit'"],
];

function jobsRegisterValidator(input: JobsRegisterInput): Validator {
  return (doc) => {
    if (!isRecord(doc)) return "register output is not the stored add event";
    const shape = tableProblem("register output", doc, REGISTER_REQUIRED, REGISTER_OPTIONAL);
    if (shape !== null) return shape;
    if (doc.session !== input.session || doc.id !== input.id) return "register output session/id differ from the request";
    if (doc.kind !== input.kind) return "register output kind differs from the request";
    if (input.pid !== undefined && doc.pid !== input.pid) return "register output pid differs from the request";
    if (input.priority !== undefined) {
      if (doc.priority !== input.priority || doc.priority_source !== "explicit") return "register output lacks the explicit priority";
    } else if (doc.priority_source !== undefined) {
      return "register output has priority_source without --priority";
    }
    return null;
  };
}

const ADMIT_EXIT_CODES: Readonly<Record<number, ReadonlySet<RefusalCode>>> = Object.freeze({
  1: new Set<RefusalCode>(["account-unknown", "account-unset", "account-retired", "no-eligible-account", "gate-denied", "marker-unreadable", "launch-gate-refused"]),
  3: new Set<RefusalCode>(["ahead-of-pace", "launch-gate-timeout"]),
});

function admitValidator(input: AdmitInput): Validator {
  const homeVar = ENGINE_HOME_VAR[input.engine];
  return (doc, exit) => {
    if (!isRecord(doc)) return "admit output is not an object";
    if (typeof doc.admitted !== "boolean" || typeof doc.reason !== "string") return "admit output lacks admitted/reason";
    if (doc.engine !== input.engine) return "admit output engine differs from the request";
    if (!isRecord(doc.env) || Object.values(doc.env).some((value) => value !== null && typeof value !== "string")) return "admit output env is not a map of string|null";
    if (!Array.isArray(doc.checks) || doc.checks.some((check) => !isRecord(check))) return "admit output checks is not an array of objects";
    if (!isStringOrNull(doc.launch_gate_label)) return "admit output launch_gate_label is not string|null";
    if (doc.account !== null && !(isRecord(doc.account) && typeof doc.account.id === "string")) return "admit output account is not null|{id, ...}";
    const keys = Object.keys(doc.env);
    if (exit === 0) {
      if (doc.admitted !== true || doc.code !== null) return "admit exit 0 is not admitted";
      // contract `operations.admit.script_output.env`: EXACTLY the engine home, absolute. The default-home
      // rule (Max): JSON null means remove CLAUDE_CONFIG_DIR, and only engine claude has that row.
      const home = doc.env[homeVar];
      if (keys.length !== 1 || !(homeVar in doc.env)) return `admit env must be exactly {${homeVar}: <absolute path>}`;
      if (home === null) return input.engine === "claude" ? null : `admit env ${homeVar} is null: the default-home rule is for engine claude only`;
      if (typeof home !== "string" || !isAbsolute(home)) return `admit env must be exactly {${homeVar}: <absolute path>}`;
      return null;
    }
    if (doc.admitted !== false || keys.length !== 0) return "admit refusal must be admitted:false with env {}";
    const allowed = ADMIT_EXIT_CODES[exit];
    if (allowed !== undefined && !(isRefusalCode(doc.code) && allowed.has(doc.code))) return `admit exit ${exit} with code ${JSON.stringify(doc.code)}`;
    return null;
  };
}

/** contract `operations.launch.script_output` (success) and `script_output_refused` (detach_job.py:2942-2946). */
const LAUNCH_FIELDS: FieldTable = [
  ["pid", isPosInt, "a positive integer"], ["pgid", isPosInt, "a positive integer"],
  ["log", (v) => typeof v === "string" && isAbsolute(v), "an absolute path"], ["meta", (v) => typeof v === "string" && isAbsolute(v), "an absolute path"],
  ["label", isString, "a string"], ["session", isString, "a string"], ["account", (v) => typeof v === "string" && v !== "", "a non-empty string"],
];
const LAUNCH_REFUSED_FIELDS: FieldTable = [["refused", (v) => v === true, "true"], ["reason", isString, "a string"]];

function launchValidator(input: LaunchInput): Validator {
  return (doc, exit) => {
    if (!isRecord(doc)) return "launch output is not an object";
    if (exit !== 0) return tableProblem("launch refusal", doc, LAUNCH_REFUSED_FIELDS, []);
    const shape = tableProblem("launch output", doc, LAUNCH_FIELDS, []);
    if (shape !== null) return shape;
    if (doc.label !== input.label || doc.session !== input.session) return "launch output label/session differ from the request";
    return null;
  };
}

/** tableProblem, and no key outside the two tables (a closed shape: an extra key is backend-error). */
function closedProblem(what: string, record: unknown, required: FieldTable, optional: FieldTable): string | null {
  if (!isRecord(record)) return `${what} is not an object`;
  const wrong = tableProblem(what, record, required, optional);
  if (wrong !== null) return wrong;
  const known = new Set([...required, ...optional].map(([key]) => key));
  const extra = Object.keys(record).find((key) => !known.has(key));
  return extra === undefined ? null : `${what} has an uncontracted key ${JSON.stringify(extra)}`;
}

const arrayOf = (test: (value: unknown) => boolean) => (value: unknown): boolean => Array.isArray(value) && value.every(test);
const isNumberOrNull = (value: unknown): boolean => value === null || isFiniteNumber(value);
/** Both scripts' refusal: `{refused: true, reason}` on stdout (launch_gate.py:723-742, ops json-contract.json "launch_gate status".refused). */
const GATE_REFUSED_FIELDS: FieldTable = [["refused", (v) => v === true, "true"], ["reason", isString, "a string"]];

/** contract `operations.status.script_output.usage_watch` accounts[] (closed: the listed optional keys and no others). */
const UW_ACCOUNT_REQUIRED: FieldTable = [
  ["id", isString, "a string"], ["vendor", (v) => isOneOf(VENDORS, v), `one of ${VENDORS.join(", ")}`], ["label", isStringOrNull, "string|null"],
  ["status", isString, "a string"], ["windows", isRecord, "an object"], ["pace", (v) => v === null || isRecord(v), "an object|null"],
];
const UW_ACCOUNT_OPTIONAL: FieldTable = [
  ["ceiling_pct", isFiniteNumber, "a finite number"], ["ceiling_source", isString, "a string"], ["reserved", (v) => typeof v === "boolean", "a boolean"],
  ["reserved_why", isString, "a string"], ["owner_sessions", Array.isArray, "an array"], ["unused_24h_pts", isNumberOrNull, "a finite number|null"],
  ["extra_windows", (v) => isRecord(v) || Array.isArray(v), "an object or array"], ["fable", (v) => v === null || isRecord(v), "an object|null"],
];
/** usage_watch's `recommendation` is the pick record for kind author (usage_watch.py status_data). */
const UW_RECOMMENDATION_REQUIRED: FieldTable = [
  ["kind", isString, "a string"], ["choice", (v) => v === null || (isRecord(v) && tableProblem("", v, PICK_CHOICE_FIELDS, []) === null), "null|{id, vendor, label, command}"],
  ["reason", isString, "a string"], ["rule", isString, "a string"],
];
const UW_RECOMMENDATION_OPTIONAL: FieldTable = [
  ["code", (v) => v === "ahead-of-pace", "'ahead-of-pace'"],
  ["seats", arrayOf((seat) => isRecord(seat) && tableProblem("", seat, PICK_SEAT_REQUIRED, PICK_SEAT_OPTIONAL) === null), "an array of seat rows"],
];
const UW_STATUS_FIELDS: FieldTable = [
  ["generated_at", isFiniteNumber, "a finite number"], ["target_pct", isFiniteNumber, "a finite number"],
  ["accounts", Array.isArray, "an array"], ["recommendation", (v) => v === null || isRecord(v), "an object|null"],
];

const usageStatusValidator: Validator = (doc) => {
  const top = closedProblem("usage_watch status", doc, UW_STATUS_FIELDS, []);
  if (top !== null) return top;
  const record = doc as Record<string, unknown>;
  for (const row of record.accounts as unknown[]) {
    const wrong = closedProblem("usage_watch status account", row, UW_ACCOUNT_REQUIRED, UW_ACCOUNT_OPTIONAL);
    if (wrong !== null) return wrong;
  }
  if (record.recommendation !== null) {
    return closedProblem("usage_watch status recommendation", record.recommendation, UW_RECOMMENDATION_REQUIRED, UW_RECOMMENDATION_OPTIONAL);
  }
  return null;
};

const GATE_ENGINE_FIELDS: FieldTable = [["would_pass", (v) => typeof v === "boolean", "a boolean"], ["reason", isStringOrNull, "string|null"]];
const GATE_WAITING_FIELDS: FieldTable = [
  ["engine", isString, "a string"], ["label", isStringOrNull, "string|null"], ["pid", isPosInt, "a positive integer"],
  ["waiting_s", isFiniteNumber, "a finite number"], ["alive", (v) => typeof v === "boolean", "a boolean"],
];
const GATE_LAUNCHES_REQUIRED: FieldTable = [
  ["kept", isNonNegInt, "a non-negative integer"], ["recent", isNonNegInt, "a non-negative integer"],
  ["window_s", isFiniteNumber, "a finite number"], ["last_age_s", isNumberOrNull, "a finite number|null"],
];
const GATE_LIMITS_FIELDS: FieldTable = [
  ["spacing_s", isFiniteNumber, "a finite number"], ["max_recent", isNonNegInt, "a non-negative integer"], ["window_s", isFiniteNumber, "a finite number"],
];
const GATE_FLEET_FIELDS: FieldTable = [["count", (v) => v === null || isNonNegInt(v), "a non-negative integer|null"], ["max", isNonNegInt, "a non-negative integer"]];
const GATE_STATUS_REQUIRED: FieldTable = [
  ["engines", isRecord, "an object"], ["queue", isRecord, "an object"], ["launches", isRecord, "an object"],
  ["load1", isFiniteNumber, "a finite number"], ["load_max", isFiniteNumber, "a finite number"],
  ["fleet", isRecord, "an object"], ["limits", isRecord, "an object"],
];
/**
 * The keys launch_gate --status --json prints beyond the plan's first six: `bypassed`, `idle`, launches.last_label and launches.retain_s.
 * They are contracted: session-contract `operations.status.script_output.launch_gate` lists them (c4b, forge-e0 ruling: the contract follows the
 * scripts) and ops json-contract.json "launch_gate status" requires them (U5, LAUNCH-GATE-IDLE-1). This table is the validator's allow-list;
 * `ts/tests/session/contract.test.ts` fails if the two drift. Any other extra key stays backend-error.
 */
const GATE_IDLE_FIELDS: FieldTable = [
  ["min", isFiniteNumber, "a finite number"], ["sampled", (v) => typeof v === "boolean", "a boolean"], ["pct", isNumberOrNull, "a finite number|null"],
];
const GATE_STATUS_ADDITIONS: FieldTable = [
  ["bypassed", (v) => typeof v === "boolean", "a boolean"],
  // LAUNCH-GATE-IDLE-1 (ops f88ad09a, 30f5b4fd, landed during U2-c3): `idle` is in the same ops entry's `required` and `types`
  // ("{min: number, sampled: boolean, pct: number|null}"); the same class as ruling 1's additions, listed in U2-c3-report Findings.
  ["idle", (v) => isRecord(v) && closedProblem("idle", v, GATE_IDLE_FIELDS, []) === null, "{min: number, sampled: boolean, pct: number|null}"],
];
const GATE_LAUNCHES_ADDITIONS: FieldTable = [["last_label", isStringOrNull, "string|null"], ["retain_s", isFiniteNumber, "a finite number"]];

const gateStatusValidator: Validator = (doc, exit) => {
  if (exit !== 0) return closedProblem("launch_gate status refusal", doc, GATE_REFUSED_FIELDS, []);
  const top = closedProblem("launch_gate status", doc, GATE_STATUS_REQUIRED, GATE_STATUS_ADDITIONS);
  if (top !== null) return top;
  const record = doc as Record<string, unknown>;
  const engines = record.engines as Record<string, unknown>;
  const engineKeys = Object.keys(engines).sort().join(",");
  if (engineKeys !== [...VENDORS].sort().join(",")) return `launch_gate status engines must be exactly {${VENDORS.join(", ")}}`;
  for (const engine of VENDORS) {
    const wrong = closedProblem(`launch_gate status engines.${engine}`, engines[engine], GATE_ENGINE_FIELDS, []);
    if (wrong !== null) return wrong;
  }
  const queue = closedProblem("launch_gate status queue", record.queue, [
    ["mode", (v) => v === "fifo" || v === "off", "'fifo'|'off'"], ["waiting", Array.isArray, "an array"],
  ], []);
  if (queue !== null) return queue;
  for (const item of (record.queue as Record<string, unknown>).waiting as unknown[]) {
    const wrong = closedProblem("launch_gate status queue.waiting item", item, GATE_WAITING_FIELDS, []);
    if (wrong !== null) return wrong;
  }
  return closedProblem("launch_gate status launches", record.launches, GATE_LAUNCHES_REQUIRED, GATE_LAUNCHES_ADDITIONS)
    ?? closedProblem("launch_gate status fleet", record.fleet, GATE_FLEET_FIELDS, [])
    ?? closedProblem("launch_gate status limits", record.limits, GATE_LIMITS_FIELDS, []);
};

/** contract `operations.fleet.script_output` (ops json-contract.json "launch_gate fleet": jobs.length == count). */
const FLEET_FIELDS: FieldTable = [["count", isNonNegInt, "a non-negative integer"], ["max", isNonNegInt, "a non-negative integer"], ["jobs", Array.isArray, "an array"]];
const FLEET_JOB_FIELDS: FieldTable = [["session", isString, "a string"], ["label", isStringOrNull, "string|null"], ["pid", isPosInt, "a positive integer"]];

const fleetValidator: Validator = (doc, exit) => {
  if (exit !== 0) return closedProblem("launch_gate fleet refusal", doc, GATE_REFUSED_FIELDS, []);
  const top = closedProblem("launch_gate fleet", doc, FLEET_FIELDS, []);
  if (top !== null) return top;
  const jobs = (doc as Record<string, unknown>).jobs as unknown[];
  for (const job of jobs) {
    const wrong = closedProblem("launch_gate fleet job", job, FLEET_JOB_FIELDS, []);
    if (wrong !== null) return wrong;
  }
  return jobs.length === (doc as Record<string, unknown>).count ? null : "launch_gate fleet jobs.length differs from count";
};

/** contract `operations.policy.script_output` (ops json-contract.json "session_policy": 4 required keys, values keys fixed). */
const POLICY_VALUES_KEYS = Object.freeze(["version", "seat_map", "admission", "launch_gate"] as const);
const isPolicySource = (value: unknown): boolean => typeof value === "string" && (value === "file" || value === "default" || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value));
const POLICY_FIELDS: FieldTable = [
  ["path", (v) => isString(v) && (v as string).length > 0 && !(v as string).includes("/"), "a basename (no '/')"],
  ["values", (v) => isRecord(v) && closedProblem("session_policy values", v, POLICY_VALUES_KEYS.map((key) => [key, () => true, "any"] as const), []) === null, `an object with exactly ${POLICY_VALUES_KEYS.join(", ")}`],
  ["sources", (v) => isRecord(v) && Object.values(v).every(isPolicySource), "a map of 'file'|'default'|'env:<VAR>'"],
  ["warnings", arrayOf(isString), "an array of strings"],
];

const policyValidator: Validator = (doc, exit) => (exit !== 0 ? "session_policy exits only 0 or 1" : closedProblem("session_policy", doc, POLICY_FIELDS, []));

/** contract `operations.hop.timeout_s`: one per door. */
export const HOP_TIMEOUT_S = Object.freeze({ check: 60, dryRun: 60, live: 300 });

/** contract `operations.hop.script_output` (ops json-contract.json "session_hop": these 8 keys required, none optional). */
const HOP_FIELDS: FieldTable = [
  ["result", (v) => isOneOf(HOP_RESULTS, v), `one of ${HOP_RESULTS.join(", ")}`], ["name", isString, "a string"],
  ["from", isStringOrNull, "string|null"], ["to", isStringOrNull, "string|null"],
  ["hop_recommended", (v) => v === null || typeof v === "boolean", "boolean|null"], ["reason", isString, "a string"], ["line", isString, "a string"],
  ["left_open", arrayOf(isString), "an array of tab ids"],
];

/**
 * Per door: script exit -> the results that exit may carry (session_hop.py:11-17, ops json-contract.json "session_hop"
 * exit_codes) and the door's exit map (contract `script_exit_check` / `script_exit_hop`). A result outside its door's
 * row (HOPPED from a dry-run, NOT-READY from a check) is backend-error: the door never reports what it did not ask for.
 */
const HOP_CHECK_RESULTS: Readonly<Record<number, readonly HopResult[]>> = Object.freeze({ 0: ["OK"], 1: ["HOP"], 2: ["UNKNOWN"] });
const HOP_DRY_RUN_RESULTS: Readonly<Record<number, readonly HopResult[]>> = Object.freeze({ 0: ["DRY-RUN", "ALREADY"], 2: ["REFUSED"], 3: ["BUSY"] });
const HOP_LIVE_RESULTS: Readonly<Record<number, readonly HopResult[]>> = Object.freeze({
  0: ["HOPPED", "ALREADY"], 2: ["REFUSED"], 3: ["BUSY"], 4: ["NOT-READY"], 5: ["PARTIAL"],
});
const HOP_CHECK_EXITS = Object.freeze({ 0: "ok", 1: "ok", 2: "backend-error" } as const);
const HOP_EXITS = Object.freeze({ 0: "ok", 2: "hop-refused", 3: "hop-busy", 4: "hop-not-ready", 5: "hop-partial" } as const);

/** The record for `name` whose result is one its door allows at this exit. Takes a results table, never a mode: it cannot choose an argv. */
function hopValidator(name: string, results: Readonly<Record<number, readonly HopResult[]>>): Validator {
  return (doc, exit) => {
    const shape = closedProblem("hop output", doc, HOP_FIELDS, []);
    if (shape !== null) return shape;
    const record = doc as unknown as HopData;
    if (record.name !== name) return "hop output name differs from the request";
    if (!(results[exit] ?? []).includes(record.result)) return `hop exit ${exit} with result ${record.result}`;
    // hop_recommended: true for HOP, false for OK, null for UNKNOWN and every hop-mode result.
    const recommended = record.result === "HOP" ? true : record.result === "OK" ? false : null;
    if (record.hop_recommended !== recommended) return `hop result ${record.result} with hop_recommended ${String(record.hop_recommended)}`;
    // left_open: the tabs a human must see to; NOT-READY always leaves the new tab, every result but NOT-READY / PARTIAL leaves none.
    if (record.result === "NOT-READY" && record.left_open.length === 0) return "hop NOT-READY without the new tab in left_open";
    if (record.result !== "NOT-READY" && record.result !== "PARTIAL" && record.left_open.length !== 0) return `hop result ${record.result} with a non-empty left_open`;
    return null;
  };
}

// ---------------------------------------------------------------- the backend

interface OpSpec {
  readonly op: SessionOp;
  readonly script: string;
  readonly args: readonly string[];
  /** script exit -> 'ok' or a refusal code; admit's 1 and 3 read the code from the output. */
  readonly exits: Readonly<Record<number, "ok" | RefusalCode | "from-output">>;
  readonly validate: Validator;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string | null;
  readonly timeoutMs: number;
  /** A refusal exit without the op's JSON record is backend-error (hop: --json prints one record on every exit path of main). */
  readonly recordRequired?: boolean;
}

export class ScriptsBackend implements SessionBackend {
  readonly kind: BackendKind;
  readonly #env: NodeJS.ProcessEnv;
  readonly #config: SessionConfig;
  readonly #timeoutsMs: Partial<Record<SessionOp, number>>;

  constructor(options: ScriptsBackendOptions) {
    this.#env = options.env;
    this.#config = options.config;
    this.#timeoutsMs = options.timeoutsMs ?? {};
    // Configured-but-broken is still 'scripts': it refuses, it never reads as 'none'.
    this.kind = options.config.configured || options.config.error !== null ? "scripts" : "none";
  }

  async pick(input: PickInput): Promise<Envelope<PickData>> {
    const bad = usageCheck([
      [(PICK_KINDS as readonly string[]).includes(input.kind), `kind must be one of ${PICK_KINDS.join(", ")}`],
      [input.authorVendor === undefined || (VENDORS as readonly string[]).includes(input.authorVendor), "author_vendor must be claude or codex"],
      [input.name === undefined || textOk(input.name), "name must be one line of text without NUL"],
    ]);
    if (bad !== null) return refused("pick", this.kind, "usage", bad);
    return this.#run<PickData>({
      op: "pick",
      script: "usage_watch.py",
      args: ["pick", `--kind=${input.kind}`, `--author-vendor=${input.authorVendor ?? "claude"}`, `--name=${input.name ?? "<name>"}`, "--json"],
      exits: { 0: "ok", 1: "no-eligible-account", 2: "usage", 3: "ahead-of-pace" },
      validate: pickValidator(input),
      env: scriptEnv(this.#env),
      stdin: null,
      timeoutMs: this.#timeout("pick", OP_TIMEOUT_S.pick),
    });
  }

  async jobsList(input: JobsListInput = {}): Promise<Envelope<JobsListData>> {
    const bad = usageCheck([[input.session === undefined || tokenOk(input.session), "session must be non-empty, trimmed, one line"]]);
    if (bad !== null) return refused("jobs_list", this.kind, "usage", bad);
    return this.#run<JobsListData>({
      op: "jobs_list",
      script: "jobs.py",
      args: ["list", ...(input.session !== undefined ? [`--session=${input.session}`] : []), "--json", "--diagnostics"],
      exits: { 0: "ok", 1: "registry-refused" },
      validate: jobsListValidator,
      env: scriptEnv(this.#env),
      stdin: null,
      timeoutMs: this.#timeout("jobs_list", OP_TIMEOUT_S.jobs_list),
    });
  }

  async jobsRegister(input: JobsRegisterInput): Promise<Envelope<JobsRegisterData>> {
    const bad = usageCheck([
      [tokenOk(input.session), "session must be non-empty, trimmed, one line"],
      [tokenOk(input.id), "id must be non-empty, trimmed, one line"],
      [(JOB_KINDS as readonly string[]).includes(input.kind), `kind must be one of ${JOB_KINDS.join(", ")}`],
      [input.pid === undefined || (Number.isInteger(input.pid) && input.pid > 0), "pid must be a positive integer"],
      [input.priority === undefined || (PRIORITIES as readonly string[]).includes(input.priority), "priority must be P0..P3"],
      [input.vendor === undefined || (VENDORS as readonly string[]).includes(input.vendor), "vendor must be claude or codex"],
      ...(["report", "collect", "label", "log", "workKind", "model", "account"] as const).map(
        (key) => [input[key] === undefined || textOk(input[key]), `${key} must be one line of text without NUL`] as [boolean, string],
      ),
    ]);
    if (bad !== null) return refused("jobs_register", this.kind, "usage", bad);
    const optional: Array<[string, string | number | undefined]> = [
      ["report", input.report], ["collect", input.collect], ["label", input.label], ["pid", input.pid], ["log", input.log],
      ["work-kind", input.workKind], ["vendor", input.vendor], ["model", input.model], ["account", input.account], ["priority", input.priority],
    ];
    return this.#run<JobsRegisterData>({
      op: "jobs_register",
      script: "jobs.py",
      args: [
        "add", `--session=${input.session}`, `--kind=${input.kind}`, `--id=${input.id}`,
        ...optional.filter(([, value]) => value !== undefined).map(([flag, value]) => `--${flag}=${String(value)}`),
      ],
      exits: { 0: "ok", 1: "registry-refused", 2: "usage" },
      validate: jobsRegisterValidator(input),
      env: scriptEnv(this.#env),
      stdin: null,
      timeoutMs: this.#timeout("jobs_register", OP_TIMEOUT_S.jobs_register),
    });
  }

  async admit(input: AdmitInput, options: { readonly childEnv: NodeJS.ProcessEnv }): Promise<AdmitResult> {
    const maxWaitS = input.maxWaitS ?? MAX_WAIT_DEFAULT_S;
    const bad = usageCheck([
      [(VENDORS as readonly string[]).includes(input.engine), "engine must be claude or codex"],
      [typeof input.label === "string" && /^[^\s-][^\s]*$/.test(input.label) && textOk(input.label), "label must be one token not starting with '-'"],
      [input.model === undefined || textOk(input.model), "model must be one line of text without NUL"],
      [input.account === undefined || tokenOk(input.account), "account must be inherit, auto or an account id"],
      [input.launchGate === undefined || input.launchGate === "full" || input.launchGate === "none", "launch_gate must be full or none"],
      [Number.isFinite(maxWaitS) && maxWaitS >= 1 && maxWaitS <= 1800, "max_wait_s must be in [1, 1800]"],
      [!(input.markerText !== undefined && input.markerFile !== undefined), "marker_text and marker_file are exclusive"],
      [input.markerFile === undefined || (isAbsolute(input.markerFile) && textOk(input.markerFile)), "marker_file must be an absolute path"],
      [input.markerText === undefined || typeof input.markerText === "string", "marker_text must be a string"],
    ]);
    if (bad !== null) return { ...refused("admit", this.kind, "usage", bad), childEnv: null };
    if (this.kind === "none") {
      // contract `backend.modes.none`: pass through, the caller launches with its env unchanged.
      const data: AdmitData = Object.freeze({
        admitted: true, code: null, reason: "session backend not configured", engine: input.engine,
        account: null, env: Object.freeze({}), checks: Object.freeze([]), launch_gate_label: null,
      });
      return { ...okEnvelope("admit", "none", data), childEnv: options.childEnv };
    }
    const envelope = await this.#run<AdmitData>({
      op: "admit",
      script: "session_admit.py",
      args: [
        `--engine=${input.engine}`, `--label=${input.label}`, `--model=${input.model ?? ""}`, `--account=${input.account ?? "inherit"}`,
        `--launch-gate=${input.launchGate ?? "full"}`, `--max-wait-s=${maxWaitS}`,
        ...(input.markerFile !== undefined ? [`--marker-file=${input.markerFile}`] : []), "--json",
      ],
      exits: { 0: "ok", 1: "from-output", 2: "usage", 3: "from-output" },
      validate: admitValidator(input),
      // contract `backend.child_env_rule`: admission is asked about the env the child will get.
      env: scriptEnv(options.childEnv),
      stdin: input.markerFile !== undefined ? "" : input.markerText ?? "",
      timeoutMs: this.#timeout("admit", (maxWaitS + 60) * 1000),
    });
    // contract `operations.admit.library_result`: childEnv = {...child_env, ...data.env}, where a null
    // value deletes the key (default-home rule), never sets the string "null" or "".
    return { ...envelope, childEnv: envelope.ok ? admittedChildEnv(options.childEnv, envelope.data.env) : null };
  }

  async launch(input: LaunchInput): Promise<Envelope<LaunchData>> {
    const maxWaitS = input.maxWaitS ?? MAX_WAIT_DEFAULT_S;
    const absolute = (value: unknown): boolean => typeof value === "string" && isAbsolute(value) && textOk(value);
    const bad = usageCheck([
      [tokenOk(input.session), "session must be non-empty, trimmed, one line"],
      [typeof input.label === "string" && /^[^\s-][^\s]*$/.test(input.label) && textOk(input.label), "label must be one token not starting with '-'"],
      [(VENDORS as readonly string[]).includes(input.engine), "engine must be claude or codex"],
      [tokenOk(input.model), "model must be non-empty, one line"],
      [input.effort === undefined || tokenOk(input.effort), "effort must be non-empty, one line"],
      [absolute(input.brief), "brief must be an absolute path"],
      [absolute(input.report), "report must be an absolute path"],
      [input.cwd === undefined || absolute(input.cwd), "cwd must be an absolute path"],
      [input.workKind === undefined || (WORK_KINDS as readonly string[]).includes(input.workKind), `work_kind must be one of ${WORK_KINDS.join(", ")}`],
      [input.priority === undefined || (PRIORITIES as readonly string[]).includes(input.priority), "priority must be P0..P3"],
      [input.account === undefined || tokenOk(input.account), "account must be inherit, auto or an account id"],
      [Number.isFinite(maxWaitS) && maxWaitS >= 1 && maxWaitS <= 1800, "max_wait_s must be in [1, 1800]"],
    ]);
    if (bad !== null) return refused("launch", this.kind, "usage", bad);
    // detach_job.py must be runnable before admit takes a launch-gate slot (mode none refuses backend-unconfigured here).
    const ready = this.#preflight("launch", "detach_job.py", scriptEnv(this.#env));
    if ("ok" in ready) return ready;
    // Step 1 (contract `operations.launch.steps`): admit with the full gate for EVERY engine, on the front door env minus
    // CLAUDECODE and any inherited LAUNCH_GATE_ADMITTED (never trusted).
    const base = scriptEnv(this.#env);
    const admitted = await this.admit(
      { engine: input.engine, label: input.label, model: input.model, account: input.account ?? "inherit", markerFile: input.brief, launchGate: "full", maxWaitS },
      { childEnv: base },
    );
    if (!admitted.ok || admitted.childEnv === null) {
      const refusal = admitted.ok ? { code: "backend-error" as const, reason: "admit returned no child env", script: "session_admit.py", script_exit: null } : admitted.refusal;
      return refused("launch", this.kind, refusal.code, refusal.reason, refusal.script, refusal.script_exit, admitted.ok ? null : admitted.record);
    }
    // Step 2: the detach env is the admitted childEnv and nothing else from the caller: the account (engine home) comes only from
    // admit. LAUNCH_GATE_ADMITTED=<label> is detach_job's skip (the full gate already ran, once, in admit); LAUNCH_GATE_MAX_WAIT
    // bounds any gate wait that still happens.
    const detachEnv: NodeJS.ProcessEnv = { ...admitted.childEnv, LAUNCH_GATE_ADMITTED: input.label, LAUNCH_GATE_MAX_WAIT: String(maxWaitS) };
    const optional: Array<[string, string | undefined]> = [
      ["effort", input.effort], ["cwd", input.cwd], ["work-kind", input.workKind], ["priority", input.priority],
    ];
    // Step 3.
    return this.#run<LaunchData>({
      op: "launch",
      script: "detach_job.py",
      args: [
        "run", `--session=${input.session}`, `--label=${input.label}`, `--engine=${input.engine}`, `--model=${input.model}`,
        `--brief=${input.brief}`, `--report=${input.report}`,
        ...optional.filter(([, value]) => value !== undefined).map(([flag, value]) => `--${flag}=${value}`),
        "--json",
      ],
      exits: { 0: "ok", 1: "detach-refused", 2: "usage" },
      validate: launchValidator(input),
      env: detachEnv,
      stdin: null,
      timeoutMs: this.#timeout("launch", OP_TIMEOUT_S.launch),
    });
  }

  async status(): Promise<Envelope<StatusData>> {
    const env = scriptEnv(this.#env);
    const timeoutMs = this.#timeout("status", OP_TIMEOUT_S.status);
    // Both are read-only, so they run side by side under the op's one timeout.
    const [usage, gate] = await Promise.all([
      this.#run<{ accounts: StatusData["accounts"]; recommendation: StatusData["recommendation"] }>({
        op: "status", script: "usage_watch.py", args: ["status", "--json", "--no-spend"],
        exits: { 0: "ok", 1: "backend-error", 2: "usage" }, validate: usageStatusValidator, env, stdin: null, timeoutMs,
      }),
      this.#run<GateStatus>({
        op: "status", script: "launch_gate.py", args: ["--status", "--json"],
        exits: { 0: "ok", 1: "backend-error", 2: "usage" }, validate: gateStatusValidator, env, stdin: null, timeoutMs,
      }),
    ]);
    if (!usage.ok) return usage;
    if (!gate.ok) return gate;
    return okEnvelope("status", this.kind, { accounts: usage.data.accounts, recommendation: usage.data.recommendation, gate: gate.data });
  }

  async fleet(): Promise<Envelope<FleetData>> {
    return this.#run<FleetData>({
      op: "fleet", script: "launch_gate.py", args: ["--fleet", "--json"],
      exits: { 0: "ok", 1: "backend-error" }, validate: fleetValidator, env: scriptEnv(this.#env), stdin: null,
      timeoutMs: this.#timeout("fleet", OP_TIMEOUT_S.fleet),
    });
  }

  async policy(): Promise<Envelope<PolicyData>> {
    return this.#run<PolicyData>({
      op: "policy", script: "session_policy.py", args: ["--json"],
      exits: { 0: "ok", 1: "backend-error" }, validate: policyValidator, env: scriptEnv(this.#env), stdin: null,
      timeoutMs: this.#timeout("policy", OP_TIMEOUT_S.policy),
    });
  }

  // Hop is three doors (contract `operations.hop.script_argv_by_mode`, forge-e0 ruling 2): each method writes its own literal
  // argv, and nothing shared takes the mode as a value. A check or a dry-run can only ever build an argv carrying --check= or
  // --dry-run before the `--`; only hopLive builds the live argv, and the MCP module never calls it (plan D4).

  async hopCheck(input: HopCheckInput): Promise<Envelope<HopData>> {
    const bad = hopNameProblem(input.name);
    if (bad !== null) return refused("hop", this.kind, "usage", bad);
    return this.#run<HopData>({
      op: "hop", script: "session_hop.py",
      args: [`--check=${input.name}`, "--json"],
      exits: HOP_CHECK_EXITS, validate: hopValidator(input.name, HOP_CHECK_RESULTS), recordRequired: true,
      env: scriptEnv(this.#env), stdin: null, timeoutMs: this.#timeout("hop", HOP_TIMEOUT_S.check),
    });
  }

  async hopDryRun(input: HopDryRunInput): Promise<Envelope<HopData>> {
    const bad = hopNameProblem(input.name) ?? hopToReasonProblem(input);
    if (bad !== null) return refused("hop", this.kind, "usage", bad);
    return this.#run<HopData>({
      op: "hop", script: "session_hop.py",
      args: ["--dry-run", `--to=${input.to ?? "auto"}`, `--reason=${input.reason ?? "quota hop"}`, "--json", "--", input.name],
      exits: HOP_EXITS, validate: hopValidator(input.name, HOP_DRY_RUN_RESULTS), recordRequired: true,
      env: scriptEnv(this.#env), stdin: null, timeoutMs: this.#timeout("hop", HOP_TIMEOUT_S.dryRun),
    });
  }

  async hopLive(input: HopLiveInput): Promise<Envelope<HopData>> {
    const bad = hopNameProblem(input.name) ?? hopToReasonProblem(input) ?? usageCheck([
      [input.force === undefined || typeof input.force === "boolean", "force must be a boolean"],
      [input.allowClosed === undefined || typeof input.allowClosed === "boolean", "allow_closed must be a boolean"],
    ]);
    if (bad !== null) return refused("hop", this.kind, "usage", bad);
    return this.#run<HopData>({
      op: "hop", script: "session_hop.py",
      args: [
        `--to=${input.to ?? "auto"}`, `--reason=${input.reason ?? "quota hop"}`,
        ...(input.force === true ? ["--force"] : []), ...(input.allowClosed === true ? ["--allow-closed"] : []),
        "--json", "--", input.name,
      ],
      exits: HOP_EXITS, validate: hopValidator(input.name, HOP_LIVE_RESULTS), recordRequired: true,
      env: scriptEnv(this.#env), stdin: null, timeoutMs: this.#timeout("hop", HOP_TIMEOUT_S.live),
    });
  }

  #timeout(op: SessionOp, fallbackSOrMs: number): number {
    const override = this.#timeoutsMs[op];
    if (override !== undefined) return override;
    return op === "admit" ? fallbackSOrMs : fallbackSOrMs * 1000;
  }

  /** Configured-but-broken checks (contract `backend.configured_test.configured_but_broken`). */
  #preflight(op: SessionOp, script: string, env: NodeJS.ProcessEnv): { python: string; path: string } | Envelope<never> {
    const config = this.#config;
    if (config.error !== null) return refused(op, this.kind, "backend-unavailable", config.error);
    if (!config.configured) {
      return refused(op, "none", "backend-unconfigured",
        "session backend not configured: set STRATUM_SESSION_SCRIPTS_DIR or [session] scripts_dir in the Stratum user config");
    }
    const dir = config.scriptsDir;
    if (dir === null || dir === "") return refused(op, this.kind, "backend-unavailable", `session backend configured but no scripts_dir (${config.userPath})`);
    if (!isAbsolute(dir)) return refused(op, this.kind, "backend-unavailable", `session scripts_dir must be an absolute path (${config.scriptsDirSource})`);
    if (!isDirectory(dir)) return refused(op, this.kind, "backend-unavailable", `session scripts_dir is not a directory (${config.scriptsDirSource})`);
    const path = join(dir, script);
    if (!isRegularFile(path)) return refused(op, this.kind, "backend-unavailable", `session script missing: ${script}`, script);
    const python = resolvePython(config.python, env);
    if (python === null) return refused(op, this.kind, "backend-unavailable", `session python not found or not executable: ${JSON.stringify(config.python)}`, script);
    return { python, path };
  }

  async #run<T>(spec: OpSpec): Promise<Envelope<T>> {
    const ready = this.#preflight(spec.op, spec.script, spec.env);
    if ("ok" in ready) return ready;
    const outcome = await runScript(ready.python, [ready.path, ...spec.args], spec.env, spec.stdin, spec.timeoutMs);
    const { op, script } = spec;
    const kind = this.kind;
    switch (outcome.kind) {
      case "spawn-error":
        return refused(op, kind, outcome.code === "ENOENT" || outcome.code === "EACCES" ? "backend-unavailable" : "backend-error",
          `cannot run ${script}: ${outcome.code}`, script);
      case "timeout":
        return refused(op, kind, "backend-timeout", `${script} timed out after ${Math.round(spec.timeoutMs / 1000)} s; its process group was killed`, script);
      case "overflow":
        return refused(op, kind, "backend-error", `${script} printed more than ${STDOUT_CAP_BYTES} bytes; its process group was killed`, script);
      case "signal":
        return refused(op, kind, "backend-error", `${script} was killed by ${outcome.signal}`, script);
      case "exit":
        break;
    }
    const exit = outcome.code;
    const mapped = spec.exits[exit];
    const doc = parseStdout(outcome.stdout);
    const stderrLine = firstLine(outcome.stderr);
    if (mapped === undefined) {
      return refused(op, kind, "backend-error", `${script} exited ${exit}, not in this op's exit map${stderrLine ? `: ${stderrLine}` : ""}`, script, exit);
    }
    if (doc === BAD_JSON) return refused(op, kind, "backend-error", `${script} exited ${exit} and its stdout is not one JSON document`, script, exit);
    if (mapped === "ok") {
      if (doc === NO_JSON) return refused(op, kind, "backend-error", `${script} exited 0 without a JSON document`, script, exit);
      const wrong = spec.validate(doc, exit);
      if (wrong !== null) return refused(op, kind, "backend-error", `${script}: ${wrong}`, script, exit);
      return okEnvelope(op, kind, doc as T);
    }
    // A refusal: its stdout is either nothing or one JSON document of the op's shape.
    let record: unknown = null;
    if (doc === NO_JSON && spec.recordRequired === true) {
      return refused(op, kind, "backend-error", `${script} exited ${exit} without its JSON record${stderrLine ? `: ${stderrLine}` : ""}`, script, exit);
    }
    if (doc !== NO_JSON) {
      const wrong = spec.validate(doc, exit);
      if (wrong !== null) return refused(op, kind, "backend-error", `${script}: refusal output of the wrong shape: ${wrong}`, script, exit);
      record = doc;
    }
    let code: RefusalCode;
    if (mapped === "from-output") {
      const fromDoc = isRecord(record) ? record.code : undefined;
      if (!isRefusalCode(fromDoc)) return refused(op, kind, "backend-error", `${script} exited ${exit} without a refusal code`, script, exit);
      code = fromDoc;
    } else {
      code = mapped;
    }
    const docReason = isRecord(record) && typeof record.reason === "string" ? firstLine(record.reason) : "";
    return refused(op, kind, code, docReason || stderrLine || `${script} exited ${exit}`, script, exit, record);
  }
}

/** {...childEnv, ...admitted}, with a null admitted value removing the key. */
export function admittedChildEnv(childEnv: NodeJS.ProcessEnv, admitted: Readonly<Record<string, string | null>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv };
  for (const [key, value] of Object.entries(admitted)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** contract `operations.hop.input.name`: non-empty, no NUL (nor any other control character: the name is one line of argv). Checked before any spawn. */
function hopNameProblem(name: unknown): string | null {
  return typeof name === "string" && name.length > 0 && textOk(name) ? null : "name must be a non-empty string without NUL or control characters";
}

function hopToReasonProblem(input: HopDryRunInput): string | null {
  return usageCheck([
    [input.to === undefined || tokenOk(input.to), "to must be non-empty, trimmed, one line"],
    [input.reason === undefined || textOk(input.reason), "reason must be one line of text without NUL"],
  ]);
}

function usageCheck(rules: ReadonlyArray<readonly [boolean, string]>): string | null {
  for (const [ok, message] of rules) if (!ok) return message;
  return null;
}

/** One line of text, no NUL or other control characters. Spaces and a leading '-' are fine: argv uses --flag=value. */
function textOk(value: unknown): boolean {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value);
}

/** A registry token: non-empty, trimmed, one line (jobs.py strips and would then not echo the input back). */
function tokenOk(value: unknown): boolean {
  return textOk(value) && (value as string).length > 0 && (value as string).trim() === value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isExecutableFile(path: string): boolean {
  if (!isRegularFile(path)) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** An absolute path is used as is; a bare name is looked up on the script env's PATH; anything else is refused. */
function resolvePython(python: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(python)) return isExecutableFile(python) ? python : null;
  if (python.includes("/")) return null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, python);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
