/**
 * Server-side evaluator for the four trusted guard-evidence builtins.
 *
 * This module intentionally handles only trusted predicates. Callers route
 * `verified` and `judged` predicates to the judge backend before/after this
 * evaluation; `evaluateEvidence` skips those tiers defensively for that split.
 */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { EvidenceParseError } from "./errors.js";
export { EvidenceParseError } from "./errors.js";

export const TRUSTED_BUILTINS = new Set([
  "server_file_exists",
  "git_commit_exists",
  "command_exit_zero",
  "verdict_receipt_clean",
] as const);

export type TrustedBuiltin = "server_file_exists" | "git_commit_exists" | "command_exit_zero" | "verdict_receipt_clean";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const NO_WORKSPACE_ROOT_REASON = "no workspace_root registered for trusted file/command/git evidence";

export type ParsedPredicateStatement = { name: TrustedBuiltin; args: unknown[] };

export type EvidencePredicate = {
  id?: unknown;
  statement?: unknown;
  type?: unknown;
};

export type LedgerEntryLike = {
  entry_digest?: unknown;
  outcome?: unknown;
};

export type PredicateEvidence = {
  id: unknown;
  statement: string;
  met: boolean;
  evidence: string;
};

export type EvidenceResult = {
  met: boolean;
  perPredicate: PredicateEvidence[];
};

/** Match Python's opt-in command gate exactly. */
export function commandsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRATUM_GUARD_ALLOW_COMMANDS === "1";
}

/** Match Python's `int(env or default)` fallback for malformed values. */
export function commandTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.STRATUM_GUARD_CMD_TIMEOUT_S;
  if (value === undefined || value.trim() === "") return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : DEFAULT_COMMAND_TIMEOUT_SECONDS;
}

/** Enough of Python's `str.__repr__` for the evidence messages it exposes. */
function pythonStringRepr(value: string): string {
  let encoded = "'";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const code = char.charCodeAt(0);
    if (char === "\\") encoded += "\\\\";
    else if (char === "'") encoded += "\\'";
    else if (char === "\n") encoded += "\\n";
    else if (char === "\r") encoded += "\\r";
    else if (char === "\t") encoded += "\\t";
    else if (code < 0x20 || code === 0x7f) encoded += `\\x${code.toString(16).padStart(2, "0")}`;
    else encoded += char;
  }
  return `${encoded}'`;
}

function pythonStringListRepr(values: string[]): string {
  return `[${values.map(pythonStringRepr).join(", ")}]`;
}

function isIdentifierStart(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\v" || char === "\f";
}

function isTrustedBuiltin(name: string): name is TrustedBuiltin {
  return TRUSTED_BUILTINS.has(name as TrustedBuiltin);
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= "0" && char <= "9");
}

function isHex(char: string): boolean {
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

/** Hand-rolled grammar for the deliberately tiny trusted-evidence language. */
class PredicateStatementParser {
  private index = 0;

  constructor(private readonly statement: string) {}

  parse(): ParsedPredicateStatement {
    this.skipWhitespace();
    const name = this.parseIdentifier();
    if (name === undefined) this.singleCallError();
    this.skipWhitespace();
    if (this.current() !== "(") this.singleCallError();
    this.index += 1;

    if (!isTrustedBuiltin(name)) {
      throw new EvidenceParseError(`unknown trusted builtin ${pythonStringRepr(name)} in ${pythonStringRepr(this.statement)}`);
    }

    const args: unknown[] = [];
    this.skipWhitespace();
    if (this.current() !== ")") {
      while (true) {
        if (this.isKeywordArgument()) {
          throw new EvidenceParseError(`keyword args not allowed: ${pythonStringRepr(this.statement)}`);
        }
        args.push(this.parseLiteral());
        this.skipWhitespace();
        if (this.current() === ")") break;
        if (this.current() !== ",") this.literalError();
        this.index += 1;
        this.skipWhitespace();
        // Python accepts a trailing comma in a call.
        if (this.current() === ")") break;
      }
    }

    this.index += 1;
    this.skipWhitespace();
    if (this.index !== this.statement.length) this.singleCallError();
    return { name, args };
  }

  private current(): string | undefined {
    return this.statement[this.index];
  }

  private skipWhitespace(): void {
    while (this.current() !== undefined && isWhitespace(this.current()!)) this.index += 1;
  }

  private parseIdentifier(): string | undefined {
    const first = this.current();
    if (first === undefined || !isIdentifierStart(first)) return undefined;
    const start = this.index;
    this.index += 1;
    while (this.current() !== undefined && isIdentifierPart(this.current()!)) this.index += 1;
    return this.statement.slice(start, this.index);
  }

  private isKeywordArgument(): boolean {
    const saved = this.index;
    const name = this.parseIdentifier();
    if (name === undefined) return false;
    this.skipWhitespace();
    const keyword = this.current() === "=";
    this.index = saved;
    return keyword;
  }

  private parseLiteral(): string | string[] {
    const char = this.current();
    if (char === "'" || char === '"') return this.parseString();
    if (char === "[") return this.parseStringArray();
    // Decision 4 deliberately accepts only strings and arrays of strings.
    // Unlike Python's literal_eval, other literal forms fail closed as
    // evidence_parse_error rather than being interpreted by this trusted DSL.
    this.literalError();
  }

  private parseStringArray(): string[] {
    this.index += 1;
    const values: string[] = [];
    this.skipWhitespace();
    if (this.current() !== "]") {
      while (true) {
        const char = this.current();
        if (char !== "'" && char !== '"') this.literalError();
        values.push(this.parseString());
        this.skipWhitespace();
        if (this.current() === "]") break;
        if (this.current() !== ",") this.literalError();
        this.index += 1;
        this.skipWhitespace();
        // Python accepts a trailing comma in a list literal.
        if (this.current() === "]") break;
      }
    }
    this.index += 1;
    return values;
  }

  private parseString(): string {
    const quote = this.current();
    if (quote !== "'" && quote !== '"') this.literalError();
    this.index += 1;
    let value = "";

    while (true) {
      const char = this.current();
      if (char === undefined || char === "\n" || char === "\r") this.literalError();
      if (char === quote) {
        this.index += 1;
        return value;
      }
      if (char !== "\\") {
        value += char;
        this.index += 1;
        continue;
      }

      this.index += 1;
      value += this.parseEscape();
    }
  }

  private parseEscape(): string {
    const escaped = this.current();
    if (escaped === undefined) this.literalError();
    this.index += 1;
    const simple: Record<string, string> = {
      a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
      "\\": "\\", "'": "'", '"': '"',
    };
    const mapped = simple[escaped];
    if (mapped !== undefined) return mapped;
    if (escaped === "\n") return "";
    if (escaped === "\r") {
      if (this.current() === "\n") this.index += 1;
      return "";
    }
    if (escaped === "x") return String.fromCodePoint(this.parseHexValue(2));
    if (escaped === "u") return String.fromCodePoint(this.parseHexValue(4));
    if (escaped === "U") {
      const codePoint = this.parseHexValue(8);
      if (codePoint > 0x10ffff) this.literalError();
      return String.fromCodePoint(codePoint);
    }
    if (escaped >= "0" && escaped <= "7") {
      let digits = escaped;
      while (digits.length < 3) {
        const next = this.current();
        if (next === undefined || next < "0" || next > "7") break;
        digits += next;
        this.index += 1;
      }
      return String.fromCharCode(Number.parseInt(digits, 8));
    }
    // Python preserves unknown escape sequences (and emits a warning), rather
    // than interpreting them as JavaScript escapes.
    return `\\${escaped}`;
  }

  private parseHexValue(length: number): number {
    const start = this.index;
    for (let offset = 0; offset < length; offset += 1) {
      const char = this.current();
      if (char === undefined || !isHex(char)) this.literalError();
      this.index += 1;
    }
    return Number.parseInt(this.statement.slice(start, this.index), 16);
  }

  private singleCallError(): never {
    throw new EvidenceParseError(`predicate must be a single call: ${pythonStringRepr(this.statement)}`);
  }

  private literalError(): never {
    throw new EvidenceParseError(`predicate args must be literals: ${pythonStringRepr(this.statement)}`);
  }
}

/** Parse `name(literal, ...)` without evaluating arbitrary JavaScript. */
export function parsePredicateStatement(statement: string): ParsedPredicateStatement {
  return new PredicateStatementParser(statement).parse();
}

export function statementIsTrusted(statement: string): boolean {
  try {
    parsePredicateStatement(statement);
    return true;
  } catch (error) {
    if (error instanceof EvidenceParseError) return false;
    throw error;
  }
}

export function statementUsesCommand(statement: string): boolean {
  try {
    return parsePredicateStatement(statement).name === "command_exit_zero";
  } catch (error) {
    if (error instanceof EvidenceParseError) return false;
    throw error;
  }
}

function isInside(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Resolve a possibly-missing target as Python's `(base / rel).resolve()` does:
 * resolve every extant parent symlink, then refuse a resolved target outside
 * the resolved workspace base.
 */
async function resolveUnder(workspaceRoot: string, rel: string): Promise<string | undefined> {
  let base: string;
  try {
    base = await realpath(workspaceRoot);
  } catch {
    // Path.resolve(strict=False) still produces a usable lexical base when a
    // registered root has disappeared; the later stat simply reports missing.
    base = resolve(workspaceRoot);
  }

  let candidate: string;
  try {
    candidate = resolve(base, rel);
  } catch {
    return undefined;
  }
  if (!isInside(base, candidate)) return undefined;

  const suffix: string[] = [];
  let existing = candidate;
  while (true) {
    try {
      const realExisting = await realpath(existing);
      const target = resolve(realExisting, ...suffix);
      return isInside(base, target) ? target : undefined;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return undefined;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function evaluateServerFileExists(workspaceRoot: string, args: unknown[]): Promise<[boolean, string]> {
  if (args.length !== 1 || typeof args[0] !== "string") {
    return [false, "server_file_exists expects one string path"];
  }
  const rel = args[0];
  const target = await resolveUnder(workspaceRoot, rel);
  if (target === undefined) return [false, `path escapes workspace_root: ${pythonStringRepr(rel)}`];
  try {
    const exists = (await stat(target)).isFile();
    return [exists, `${rel} ${exists ? "exists" : "missing"}`];
  } catch {
    return [false, `${rel} missing`];
  }
}

type CommandOutcome =
  | { kind: "exit"; code: number | null }
  | { kind: "error"; error: string }
  | { kind: "timeout"; command: string[]; timeoutSeconds: number };

async function runCommand(command: string, args: string[], cwd: string, timeoutSeconds: number): Promise<CommandOutcome> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveOutcome(outcome);
    };
    let child;
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
    } catch (error) {
      finish({ kind: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      // Python's subprocess timeout path calls Popen.kill(), which is SIGKILL
      // on POSIX. Kill the detached child's whole group so background
      // descendants do not survive the timeout.
      try {
        if (child.pid === undefined) throw new Error("child has no pid");
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH" || code === "EPERM") {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child has already exited or cannot be signaled.
          }
        }
      }
    }, Math.max(0, timeoutSeconds) * 1000);
    child.once("error", (error) => finish({ kind: "error", error: error.message }));
    child.once("close", (code) => finish(timedOut
      ? { kind: "timeout", command: [command, ...args], timeoutSeconds }
      : { kind: "exit", code }));
  });
}

async function evaluateGitCommitExists(workspaceRoot: string, args: unknown[]): Promise<[boolean, string]> {
  if (args.length !== 1 || typeof args[0] !== "string") {
    return [false, "git_commit_exists expects one sha string"];
  }
  const sha = args[0];
  const outcome = await runCommand("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], workspaceRoot, 5);
  if (outcome.kind === "error") return [false, `git rev-parse failed: ${outcome.error}`];
  if (outcome.kind === "timeout") {
    return [false, `git rev-parse failed: Command ${pythonStringListRepr(outcome.command)} timed out after ${outcome.timeoutSeconds} seconds`];
  }
  const met = outcome.code === 0;
  return [met, `commit ${sha.slice(0, 12)} ${met ? "present" : "absent"}`];
}

async function evaluateCommandExitZero(workspaceRoot: string, args: unknown[]): Promise<[boolean, string]> {
  if (!commandsAllowed()) return [false, "command execution disabled (set STRATUM_GUARD_ALLOW_COMMANDS=1)"];
  if (args.length !== 1 || !Array.isArray(args[0]) || !args[0].every((value) => typeof value === "string")) {
    return [false, "command_exit_zero expects one list[str]"];
  }
  const command = args[0] as string[];
  if (command.length === 0) return [false, "empty command"];
  const outcome = await runCommand(command[0]!, command.slice(1), workspaceRoot, commandTimeoutSeconds());
  if (outcome.kind === "error") return [false, `command failed: ${outcome.error}`];
  if (outcome.kind === "timeout") {
    return [false, `command failed: Command ${pythonStringListRepr(outcome.command)} timed out after ${outcome.timeoutSeconds} seconds`];
  }
  const met = outcome.code === 0;
  return [met, `${command[0]} exited ${String(outcome.code)}`];
}

function evaluateVerdictReceiptClean(args: unknown[], ledgerEntries: LedgerEntryLike[]): [boolean, string] {
  if (args.length !== 1 || typeof args[0] !== "string") {
    return [false, "verdict_receipt_clean expects one digest string"];
  }
  const digest = args[0];
  const met = ledgerEntries.some((entry) => entry.entry_digest === digest && (entry.outcome === "applied" || entry.outcome === "review_clean"));
  return [met, met ? `receipt ${digest.slice(0, 12)} found (clean)` : `no clean receipt for ${digest.slice(0, 12)}`];
}

/**
 * Evaluate only trusted builtins, with AND semantics. `verified`/`judged`
 * predicates are deliberately omitted because the transition caller routes
 * them to the judge backend (the Python evaluator is normally called with
 * only trusted predicates as well).
 */
export async function evaluateEvidence(
  predicates: EvidencePredicate[],
  workspaceRoot: string | null | undefined,
  ledgerEntries: LedgerEntryLike[],
): Promise<EvidenceResult> {
  const perPredicate: PredicateEvidence[] = [];
  let met = true;

  for (const predicate of predicates) {
    if (predicate.type === "verified" || predicate.type === "judged") continue;
    const statement = typeof predicate.statement === "string" ? predicate.statement : "";
    const { name, args } = parsePredicateStatement(statement);

    let predicateMet: boolean;
    let evidence: string;
    if ((name === "server_file_exists" || name === "git_commit_exists" || name === "command_exit_zero") && !workspaceRoot) {
      [predicateMet, evidence] = [false, NO_WORKSPACE_ROOT_REASON];
    } else if (name === "server_file_exists") {
      [predicateMet, evidence] = await evaluateServerFileExists(workspaceRoot!, args);
    } else if (name === "git_commit_exists") {
      [predicateMet, evidence] = await evaluateGitCommitExists(workspaceRoot!, args);
    } else if (name === "command_exit_zero") {
      [predicateMet, evidence] = await evaluateCommandExitZero(workspaceRoot!, args);
    } else {
      [predicateMet, evidence] = evaluateVerdictReceiptClean(args, ledgerEntries);
    }

    perPredicate.push({ id: predicate.id, statement, met: predicateMet, evidence });
    met = met && predicateMet;
  }

  return { met, perPredicate };
}
