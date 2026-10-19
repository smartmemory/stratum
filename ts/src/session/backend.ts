/**
 * SESSION-MGMT-1: the session front door's typed surface (contract
 * docs/features/SESSION-MGMT-1/session-contract.json: `envelope`, `refusal_codes`,
 * `cli_exit_codes`, `operations`, `library`).
 *
 * Every operation answers with one envelope. A refusal is a normal value, never a
 * thrown error: callers branch on `ok`. The CLI maps `refusal.code` to its exit code
 * with `cliExitFor`.
 */

export type BackendKind = "scripts" | "none";

/** contract `refusal_codes`: code -> cli exit. The map is total for every code the door can emit. */
export const REFUSAL_CLI_EXIT = Object.freeze({
  "backend-unconfigured": 4,
  "backend-unavailable": 4,
  "backend-error": 4,
  "backend-timeout": 4,
  "admission-env-mismatch": 4,
  "no-eligible-account": 1,
  "ahead-of-pace": 3,
  "account-unknown": 1,
  "account-unset": 1,
  "account-retired": 1,
  "gate-denied": 1,
  "marker-unreadable": 1,
  "launch-gate-refused": 1,
  "launch-gate-timeout": 3,
  "hop-refused": 1,
  "hop-busy": 3,
  "hop-not-ready": 5,
  "hop-partial": 5,
  "detach-refused": 1,
  "mark-mismatch": 1,
  "registry-refused": 1,
  usage: 2,
} as const);

export type RefusalCode = keyof typeof REFUSAL_CLI_EXIT;

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_CLI_EXIT, value);
}

export type SessionOp = "pick" | "admit" | "jobs_list" | "jobs_register";

export interface Refusal {
  readonly code: RefusalCode;
  /** The script's own text (first line, at most 500 chars) or the door's reason. Never an env value. */
  readonly reason: string;
  readonly script: string | null;
  readonly script_exit: number | null;
}

export interface OkEnvelope<T> {
  readonly ok: true;
  readonly op: SessionOp;
  readonly backend: BackendKind;
  readonly data: T;
}

export interface RefusedEnvelope {
  readonly ok: false;
  readonly op: SessionOp;
  readonly backend: BackendKind;
  readonly refusal: Refusal;
  /** The script's parsed stdout when it printed one valid JSON document of the op's shape; else null. */
  readonly record: unknown;
}

export type Envelope<T> = OkEnvelope<T> | RefusedEnvelope;

/** contract `cli_exit_codes`. */
export function cliExitFor(envelope: Envelope<unknown>): number {
  return envelope.ok ? 0 : REFUSAL_CLI_EXIT[envelope.refusal.code];
}

export const REASON_CAP = 500;

/** First non-empty line, capped. Used for every reason the door forwards. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > REASON_CAP ? line.slice(0, REASON_CAP) : line;
}

export function refused(
  op: SessionOp,
  backend: BackendKind,
  code: RefusalCode,
  reason: string,
  script: string | null = null,
  scriptExit: number | null = null,
  record: unknown = null,
): RefusedEnvelope {
  return Object.freeze({
    ok: false as const,
    op,
    backend,
    refusal: Object.freeze({ code, reason: firstLine(reason) || code, script, script_exit: scriptExit }),
    record,
  });
}

export function okEnvelope<T>(op: SessionOp, backend: BackendKind, data: T): OkEnvelope<T> {
  return Object.freeze({ ok: true as const, op, backend, data });
}

// ---------------------------------------------------------------- operation inputs and data

export const PICK_KINDS = Object.freeze(["author", "fix-round", "review", "diagnose", "land", "doc", "spike", "other"] as const);
export type PickKind = (typeof PICK_KINDS)[number];
export const VENDORS = Object.freeze(["claude", "codex"] as const);
export type Vendor = (typeof VENDORS)[number];

export interface PickInput {
  readonly kind: PickKind;
  readonly authorVendor?: Vendor;
  readonly name?: string;
}

export interface PickChoice { readonly id: string; readonly vendor: string; readonly label: string | null; readonly command: string }
export interface PickSeat { readonly id: string; readonly state: string; readonly detail: string; readonly [key: string]: unknown }
export interface PickData {
  readonly kind: string;
  readonly choice: PickChoice | null;
  readonly reason: string;
  readonly rule: string;
  readonly code?: "ahead-of-pace";
  readonly seats?: readonly PickSeat[];
}

export const JOB_KINDS = Object.freeze(["agent", "stratum", "bash", "tab", "detached"] as const);
export const WORK_KINDS = PICK_KINDS;
export const PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"] as const);

export interface JobsListInput { readonly session?: string }
export interface JobsListData {
  readonly rows: readonly Record<string, unknown>[];
  readonly bad_count: number;
  readonly diagnostics: readonly Record<string, unknown>[];
}

export interface JobsRegisterInput {
  readonly session: string;
  readonly kind: (typeof JOB_KINDS)[number];
  readonly id: string;
  readonly report?: string;
  readonly collect?: string;
  readonly label?: string;
  readonly pid?: number;
  readonly log?: string;
  readonly workKind?: string;
  readonly vendor?: Vendor;
  readonly model?: string;
  readonly account?: string;
  readonly priority?: (typeof PRIORITIES)[number];
}

/** contract `operations.jobs_register.script_output`: the stored add event as jobs.py echoes it. */
export interface JobsRegisterData {
  readonly op: "add";
  readonly session: string;
  readonly kind: string;
  readonly id: string;
  readonly report: string | null;
  readonly collect: string | null;
  readonly label: string | null;
  readonly ts: number;
  readonly priority_source?: "explicit";
  readonly [key: string]: unknown;
}

export interface AdmitInput {
  readonly engine: Vendor;
  readonly label: string;
  readonly model?: string;
  /** 'inherit' (default) | 'auto' | an account id. */
  readonly account?: string;
  readonly markerText?: string;
  readonly markerFile?: string;
  readonly launchGate?: "full" | "none";
  readonly maxWaitS?: number;
}

export interface AdmitCheck { readonly name: string; readonly result: "pass" | "deny" | "skip"; readonly detail: string }
export interface AdmitData {
  readonly admitted: boolean;
  readonly code: RefusalCode | null;
  readonly reason: string;
  readonly engine: Vendor;
  readonly account: { readonly id: string; readonly vendor: string; readonly label: string | null; readonly config_dir_name: string } | null;
  readonly env: Readonly<Record<string, string>>;
  readonly checks: readonly AdmitCheck[];
  readonly launch_gate_label: string | null;
}

/** The engine home variable admit must return (contract `operations.admit.script_output.env`). */
export const ENGINE_HOME_VAR = Object.freeze({ claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const);

export type AdmitResult = Envelope<AdmitData> & { readonly childEnv: NodeJS.ProcessEnv | null };

/**
 * contract `library.exports`. U1 implements pick, admit's mode handling, jobsList and
 * jobsRegister; U2 adds launch, status, fleet, hopCheck, hopDryRun, hopLive and policy.
 */
export interface SessionBackend {
  /** 'scripts' when configured (even when broken), 'none' otherwise. */
  readonly kind: BackendKind;
  pick(input: PickInput): Promise<Envelope<PickData>>;
  admit(input: AdmitInput, options: { readonly childEnv: NodeJS.ProcessEnv }): Promise<AdmitResult>;
  jobsList(input?: JobsListInput): Promise<Envelope<JobsListData>>;
  jobsRegister(input: JobsRegisterInput): Promise<Envelope<JobsRegisterData>>;
}
