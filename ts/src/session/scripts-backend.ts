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
  firstLine,
  isRefusalCode,
  JOB_KINDS,
  type JobsListData,
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
  VENDORS,
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

/** contract `operations.<op>.timeout_s` (admit: max_wait_s + 60). */
export const OP_TIMEOUT_S: Readonly<Record<Exclude<SessionOp, "admit">, number>> = Object.freeze({
  pick: 60,
  jobs_list: 30,
  jobs_register: 30,
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

/** A validator returns null when `doc` has the op's shape for this exit, else what is wrong. */
type Validator = (doc: unknown, exit: number) => string | null;

const SEAT_STATES = new Set(["reserved", "closed", "weekly", "unstarted", "behind", "ahead"]);

function pickValidator(input: PickInput): Validator {
  return (doc, exit) => {
    if (!isRecord(doc)) return "pick output is not an object";
    if (doc.kind !== input.kind) return "pick output kind does not match the request";
    if (typeof doc.reason !== "string" || typeof doc.rule !== "string") return "pick output lacks reason/rule";
    if (doc.choice !== null) {
      const c = doc.choice;
      if (!isRecord(c) || typeof c.id !== "string" || typeof c.vendor !== "string" || !isStringOrNull(c.label) || typeof c.command !== "string") {
        return "pick output choice is not {id, vendor, label, command}";
      }
    }
    if (doc.code !== undefined && doc.code !== "ahead-of-pace") return "pick output code is not 'ahead-of-pace'";
    if (doc.seats !== undefined) {
      if (!Array.isArray(doc.seats)) return "pick output seats is not an array";
      for (const seat of doc.seats) {
        if (!isRecord(seat) || typeof seat.id !== "string" || typeof seat.detail !== "string" || typeof seat.state !== "string" || !SEAT_STATES.has(seat.state)) {
          return "pick output seat row is not {id, state, detail}";
        }
      }
    }
    // The exit and the record must agree (usage_watch.py:3254).
    if (exit === 0 && doc.choice === null) return "pick exit 0 without a choice";
    if (exit === 1 && (doc.choice !== null || doc.code !== undefined)) return "pick exit 1 with a choice or a code";
    if (exit === 3 && (doc.choice !== null || doc.code !== "ahead-of-pace")) return "pick exit 3 without code 'ahead-of-pace'";
    return null;
  };
}

const jobsListValidator: Validator = (doc) => {
  if (!isRecord(doc)) return "jobs list output is not {rows, bad_count, diagnostics}";
  if (!Array.isArray(doc.rows) || !Array.isArray(doc.diagnostics)) return "jobs list rows/diagnostics are not arrays";
  if (typeof doc.bad_count !== "number" || !Number.isInteger(doc.bad_count) || doc.bad_count < 0) return "jobs list bad_count is not a non-negative integer";
  for (const row of doc.rows) {
    if (!isRecord(row) || typeof row.session !== "string" || typeof row.id !== "string" || typeof row.kind !== "string" || typeof row.status !== "string") {
      return "jobs list row lacks session/id/kind/status";
    }
  }
  for (const item of doc.diagnostics) if (!isRecord(item)) return "jobs list diagnostic is not an object";
  return null;
};

function jobsRegisterValidator(input: JobsRegisterInput): Validator {
  return (doc) => {
    if (!isRecord(doc)) return "register output is not the stored add event";
    if (doc.op !== "add") return "register output op is not 'add'";
    if (doc.session !== input.session || doc.id !== input.id) return "register output session/id differ from the request";
    if (doc.kind !== input.kind) return "register output kind differs from the request";
    if (typeof doc.ts !== "number" || !Number.isFinite(doc.ts)) return "register output ts is not a number";
    if (!isStringOrNull(doc.report) || !isStringOrNull(doc.collect) || !isStringOrNull(doc.label)) return "register output report/collect/label are not string|null";
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
    if (!isRecord(doc.env) || Object.values(doc.env).some((value) => typeof value !== "string")) return "admit output env is not a string map";
    if (!Array.isArray(doc.checks) || doc.checks.some((check) => !isRecord(check))) return "admit output checks is not an array of objects";
    if (!isStringOrNull(doc.launch_gate_label)) return "admit output launch_gate_label is not string|null";
    if (doc.account !== null && !(isRecord(doc.account) && typeof doc.account.id === "string")) return "admit output account is not null|{id, ...}";
    const keys = Object.keys(doc.env);
    if (exit === 0) {
      if (doc.admitted !== true || doc.code !== null) return "admit exit 0 is not admitted";
      // contract `operations.admit.script_output.env`: EXACTLY the engine home, absolute.
      const home = doc.env[homeVar];
      if (keys.length !== 1 || typeof home !== "string" || !isAbsolute(home)) return `admit env must be exactly {${homeVar}: <absolute path>}`;
      return null;
    }
    if (doc.admitted !== false || keys.length !== 0) return "admit refusal must be admitted:false with env {}";
    const allowed = ADMIT_EXIT_CODES[exit];
    if (allowed !== undefined && !(isRefusalCode(doc.code) && allowed.has(doc.code))) return `admit exit ${exit} with code ${JSON.stringify(doc.code)}`;
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
    // contract `operations.admit.library_result`: childEnv = {...child_env, ...data.env}.
    return { ...envelope, childEnv: envelope.ok ? { ...options.childEnv, ...envelope.data.env } : null };
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
