import type { Evaluator, EvaluatorContext } from "../engine/engine.js";
import { createFileHelpers, FileValidationError } from "./files.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ExpressionIdentifier = "result" | "input" | "item" | "prev";
export type ExpressionBindings = Partial<Record<ExpressionIdentifier, unknown>>;

export type EvaluationResult =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: string };

export interface PredicateResult {
  holds: boolean;
  reason: string;
}

export interface EvaluationOptions {
  workspaceRoot?: string;
}

const BLOCKED_MEMBERS = new Set(["__proto__", "constructor", "prototype"]);
const IDENTIFIERS = new Set<ExpressionIdentifier>(["result", "input", "item", "prev"]);
const FUNCTIONS = new Set(["len", "any", "all", "max", "min", "str", "int", "bool", "matches", "file_exists", "file_contains"]);
const MAX_PARSE_DEPTH = 128;
const MAX_AST_NODES = 4096;
const MAX_REGEX_LENGTH = 256;
const MAX_REGEX_INPUT = 4096;

type FailureCode = "parse_error" | "unknown_identifier" | "unknown_function" | "type_error" | "validation_error" | "resource_limit";

class ExpressionError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ExpressionError";
  }
}

type TokenKind = "string" | "number" | "identifier" | "operator" | "punctuation" | "eof";
interface Token { kind: TokenKind; text: string; value?: string | number; position: number }

type Node =
  | { kind: "literal"; value: JsonValue }
  | { kind: "identifier"; name: string }
  | { kind: "member"; target: Node; property: string }
  | { kind: "index"; target: Node; index: number }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; operator: "!" | "-"; operand: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node };

class Lexer {
  private position = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  next(): Token {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
    const start = this.position;
    const char = this.source[this.position];
    if (char === undefined) return { kind: "eof", text: "", position: start };
    if (char === "\"" || char === "'") return this.string(char, start);
    if (/[0-9]/u.test(char)) return this.number(start);
    if (/[A-Za-z_]/u.test(char)) return this.identifier(start);

    for (const operator of ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "!"]) {
      if (this.source.startsWith(operator, start)) {
        this.position += operator.length;
        return { kind: "operator", text: operator, position: start };
      }
    }
    if ("().[],".includes(char)) {
      this.position += 1;
      return { kind: "punctuation", text: char, position: start };
    }
    throw new ExpressionError("parse_error", `unexpected character ${JSON.stringify(char)} at position ${start}`);
  }

  private identifier(start: number): Token {
    this.position += 1;
    while (/[A-Za-z0-9_]/u.test(this.source[this.position] ?? "")) this.position += 1;
    const text = this.source.slice(start, this.position);
    return text === "in"
      ? { kind: "operator", text, position: start }
      : { kind: "identifier", text, position: start };
  }

  private number(start: number): Token {
    const match = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(start));
    if (!match) throw new ExpressionError("parse_error", `invalid number at position ${start}`);
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ExpressionError("parse_error", `number must be finite at position ${start}`);
    return { kind: "number", text: match[0], value, position: start };
  }

  private string(quote: string, start: number): Token {
    this.position += 1;
    let value = "";
    while (this.position < this.source.length) {
      const char = this.source[this.position++]!;
      if (char === quote) return { kind: "string", text: this.source.slice(start, this.position), value, position: start };
      if (char === "\n" || char === "\r" || char.charCodeAt(0) < 0x20) {
        throw new ExpressionError("parse_error", `unescaped control character in string at position ${this.position - 1}`);
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = this.source[this.position++];
      if (escaped === undefined) break;
      const simple: Record<string, string> = { "\"": "\"", "'": "'", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (Object.hasOwn(simple, escaped)) {
        value += simple[escaped]!;
        continue;
      }
      if (escaped === "u") {
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw new ExpressionError("parse_error", `invalid unicode escape at position ${this.position - 2}`);
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 4;
        continue;
      }
      throw new ExpressionError("parse_error", `invalid escape \\${escaped} at position ${this.position - 2}`);
    }
    throw new ExpressionError("parse_error", `unterminated string at position ${start}`);
  }
}

class Parser {
  private current: Token;
  private depth = 0;
  private nodes = 0;
  private readonly lexer: Lexer;

  constructor(lexer: Lexer) {
    this.lexer = lexer;
    this.current = lexer.next();
  }

  parse(): Node {
    const node = this.parseOr();
    if (this.current.kind !== "eof") this.fail(`unexpected token ${JSON.stringify(this.current.text)}`);
    return node;
  }

  private parseOr(): Node { return this.binary(() => this.parseAnd(), ["||"]); }
  private parseAnd(): Node { return this.binary(() => this.parseComparison(), ["&&"]); }
  private parseComparison(): Node { return this.binary(() => this.parseAdditive(), ["==", "!=", "<", "<=", ">", ">=", "in"]); }
  private parseAdditive(): Node { return this.binary(() => this.parseMultiplicative(), ["+", "-"]); }
  private parseMultiplicative(): Node { return this.binary(() => this.parseUnary(), ["*", "/"]); }

  private binary(next: () => Node, operators: string[]): Node {
    let left = next();
    while (this.current.kind === "operator" && operators.includes(this.current.text)) {
      const operator = this.current.text;
      this.advance();
      left = this.node({ kind: "binary", operator, left, right: next() });
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.current.kind === "operator" && (this.current.text === "!" || this.current.text === "-")) {
      const operator = this.current.text;
      this.advance();
      return this.nested(() => this.node({ kind: "unary", operator, operand: this.parseUnary() }));
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let target = this.parsePrimary();
    while (this.current.text === "." || this.current.text === "[") {
      if (this.current.text === ".") {
        this.advance();
        if (this.current.kind !== "identifier") this.fail("member access requires a property name");
        const property = this.current.text;
        if (BLOCKED_MEMBERS.has(property)) this.fail(`member ${JSON.stringify(property)} is forbidden`);
        this.advance();
        target = this.node({ kind: "member", target, property });
        continue;
      }
      this.advance();
      if (this.current.kind !== "number" || !Number.isInteger(this.current.value) || (this.current.value as number) < 0) {
        this.fail("index access requires a non-negative integer literal");
      }
      const index = this.current.value as number;
      this.advance();
      this.expect("]");
      target = this.node({ kind: "index", target, index });
    }
    return target;
  }

  private parsePrimary(): Node {
    if (this.current.kind === "string" || this.current.kind === "number") {
      const value = this.current.value as string | number;
      this.advance();
      return this.node({ kind: "literal", value });
    }
    if (this.current.kind === "identifier") {
      const name = this.current.text;
      this.advance();
      if (name === "true" || name === "false" || name === "null") {
        return this.node({ kind: "literal", value: name === "null" ? null : name === "true" });
      }
      if (!this.at("(")) return this.node({ kind: "identifier", name });
      this.advance();
      const args: Node[] = [];
      if (!this.at(")")) {
        while (true) {
          args.push(this.nested(() => this.parseOr()));
          if (!this.at(",")) break;
          this.advance();
        }
      }
      this.expect(")");
      return this.node({ kind: "call", name, args });
    }
    if (this.current.text === "(") {
      this.advance();
      const value = this.nested(() => this.parseOr());
      this.expect(")");
      return value;
    }
    this.fail(`expected a literal, identifier, function call, or parenthesized expression`);
  }

  private nested<T>(action: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) throw new ExpressionError("resource_limit", `expression nesting exceeds ${MAX_PARSE_DEPTH}`);
    try { return action(); } finally { this.depth -= 1; }
  }

  private node<T extends Node>(node: T): T {
    this.nodes += 1;
    if (this.nodes > MAX_AST_NODES) throw new ExpressionError("resource_limit", `expression exceeds ${MAX_AST_NODES} syntax nodes`);
    return node;
  }

  private expect(text: string): void {
    if (this.current.text !== text) this.fail(`expected ${JSON.stringify(text)}`);
    this.advance();
  }

  private advance(): void { this.current = this.lexer.next(); }
  private at(text: string): boolean { return this.current.text === text; }
  private fail(message: string): never { throw new ExpressionError("parse_error", `${message} at position ${this.current.position}`); }
}

export function evaluateExpression(expression: string, bindings: ExpressionBindings, options: EvaluationOptions = {}): EvaluationResult {
  try {
    const ast = new Parser(new Lexer(expression)).parse();
    return { ok: true, value: evaluateNode(ast, bindings, options) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, reason: `${error.code}: ${error.message}` };
    if (error instanceof FileValidationError) return { ok: false, reason: `${error.code}: ${error.message}` };
    return { ok: false, reason: `validation_error: ${errorMessage(error)}` };
  }
}

export function evaluatePredicate(expression: string, bindings: ExpressionBindings, options: EvaluationOptions = {}): PredicateResult {
  const result = evaluateExpression(expression, bindings, options);
  if (!result.ok) return { holds: false, reason: result.reason };
  if (typeof result.value !== "boolean") {
    return { holds: false, reason: `type_error: predicate must evaluate to boolean, received ${typeName(result.value)}` };
  }
  return { holds: result.value, reason: `predicate evaluated to ${result.value}` };
}

/** Static policy helper: parse once, then inspect every nested AST node. */
export function expressionUsesFilePredicate(expression: string): boolean {
  let ast: Node;
  try {
    ast = new Parser(new Lexer(expression)).parse();
  } catch {
    return false;
  }
  const visit = (node: Node): boolean => {
    switch (node.kind) {
      case "literal":
      case "identifier": return false;
      case "member": return visit(node.target);
      case "index": return visit(node.target);
      case "call": return node.name === "file_exists" || node.name === "file_contains" || node.args.some(visit);
      case "unary": return visit(node.operand);
      case "binary": return visit(node.left) || visit(node.right);
    }
  };
  return visit(ast);
}

/**
 * Engine adapter. During ensure evaluation (context.result present) `result` is the
 * step output under test; for when/set it falls back to the own-property map of
 * completed step outputs. A context workspaceRoot overrides the constructor option.
 */
export class ExpressionEvaluator implements Evaluator {
  private readonly options: EvaluationOptions;

  constructor(options: EvaluationOptions = {}) {
    this.options = options;
  }

  evaluate(expression: string, context: EvaluatorContext): unknown {
    const result = evaluateExpression(expression, this.bindings(context), this.merged(context));
    return result.ok ? result.value : false;
  }

  evaluatePredicate(expression: string, context: EvaluatorContext): PredicateResult {
    return evaluatePredicate(expression, this.bindings(context), this.merged(context));
  }

  private bindings(context: EvaluatorContext): ExpressionBindings {
    return {
      input: context.input,
      result: Object.hasOwn(context, "result") ? context.result : context.steps,
      ...(Object.hasOwn(context, "item") ? { item: context.item } : {}),
      ...(Object.hasOwn(context, "prev") ? { prev: context.prev } : {}),
    };
  }

  private merged(context: EvaluatorContext): EvaluationOptions {
    return { ...this.options, ...(context.workspaceRoot !== undefined ? { workspaceRoot: context.workspaceRoot } : {}) };
  }
}

export function createEvaluator(options: EvaluationOptions = {}): Evaluator {
  return new ExpressionEvaluator(options);
}

function evaluateNode(node: Node, bindings: ExpressionBindings, options: EvaluationOptions): JsonValue {
  switch (node.kind) {
    case "literal": return node.value;
    case "identifier": return identifier(node.name, bindings);
    case "member": return member(evaluateNode(node.target, bindings, options), node.property);
    case "index": return index(evaluateNode(node.target, bindings, options), node.index);
    case "call": return call(node.name, node.args.map((arg) => evaluateNode(arg, bindings, options)), options);
    case "unary": return unary(node.operator, evaluateNode(node.operand, bindings, options));
    case "binary": return binary(node, bindings, options);
  }
}

function identifier(name: string, bindings: ExpressionBindings): JsonValue {
  if (!IDENTIFIERS.has(name as ExpressionIdentifier) || !Object.hasOwn(bindings, name)) {
    throw new ExpressionError("unknown_identifier", `unknown identifier ${JSON.stringify(name)}`);
  }
  return assertJsonValue(bindings[name as ExpressionIdentifier], `identifier ${name}`);
}

function member(target: JsonValue, property: string): JsonValue {
  if (BLOCKED_MEMBERS.has(property)) throw new ExpressionError("validation_error", `member ${JSON.stringify(property)} is forbidden`);
  const object = plainObject(target, "member access target");
  if (!Object.hasOwn(object, property)) throw new ExpressionError("type_error", `member ${JSON.stringify(property)} does not exist`);
  return object[property]!;
}

function index(target: JsonValue, position: number): JsonValue {
  if (!Array.isArray(target)) throw new ExpressionError("type_error", `index access requires an array, received ${typeName(target)}`);
  if (position >= target.length) throw new ExpressionError("type_error", `array index ${position} is out of bounds`);
  return target[position]!;
}

function unary(operator: "!" | "-", value: JsonValue): JsonValue {
  if (operator === "!") return !booleanValue(value, "operator !");
  return finiteNumber(-numberValue(value, "unary operator -"), "unary operator -");
}

function binary(node: Extract<Node, { kind: "binary" }>, bindings: ExpressionBindings, options: EvaluationOptions): JsonValue {
  const left = evaluateNode(node.left, bindings, options);
  if (node.operator === "&&") {
    const holds = booleanValue(left, "left operand of &&");
    return holds ? booleanValue(evaluateNode(node.right, bindings, options), "right operand of &&") : false;
  }
  if (node.operator === "||") {
    const holds = booleanValue(left, "left operand of ||");
    return holds ? true : booleanValue(evaluateNode(node.right, bindings, options), "right operand of ||");
  }
  const right = evaluateNode(node.right, bindings, options);
  switch (node.operator) {
    case "==": return jsonEqual(left, right);
    case "!=": return !jsonEqual(left, right);
    case "<": return compare(left, right, "<") < 0;
    case "<=": return compare(left, right, "<=") <= 0;
    case ">": return compare(left, right, ">") > 0;
    case ">=": return compare(left, right, ">=") >= 0;
    case "+":
      if (typeof left === "number" && typeof right === "number") return finiteNumber(left + right, "operator +");
      if (typeof left === "string" && typeof right === "string") return left + right;
      throw new ExpressionError("type_error", "operator + requires two numbers or two strings");
    case "-": return finiteNumber(numberValue(left, "left operand of -") - numberValue(right, "right operand of -"), "operator -");
    case "*": return finiteNumber(numberValue(left, "left operand of *") * numberValue(right, "right operand of *"), "operator *");
    case "/": {
      const divisor = numberValue(right, "right operand of /");
      if (divisor === 0) throw new ExpressionError("type_error", "division by zero");
      return finiteNumber(numberValue(left, "left operand of /") / divisor, "operator /");
    }
    case "in": return contains(left, right);
    default: throw new ExpressionError("parse_error", `unknown operator ${JSON.stringify(node.operator)}`);
  }
}

function call(name: string, args: JsonValue[], options: EvaluationOptions): JsonValue {
  if (!FUNCTIONS.has(name)) throw new ExpressionError("unknown_function", `unknown function ${JSON.stringify(name)}`);
  switch (name) {
    case "len": {
      arity(name, args, 1);
      const value = args[0]!;
      if (typeof value === "string" || Array.isArray(value)) return value.length;
      return Object.keys(plainObject(value, "len argument")).length;
    }
    case "any":
    case "all": {
      arity(name, args, 1);
      const values = arrayValue(args[0]!, `${name} argument`);
      return name === "any" ? values.some(truthy) : values.every(truthy);
    }
    case "max":
    case "min": {
      arity(name, args, 1);
      const values = arrayValue(args[0]!, `${name} argument`);
      if (values.length === 0) throw new ExpressionError("type_error", `${name} requires a non-empty array`);
      if (values.every((value) => typeof value === "number")) return name === "max" ? Math.max(...values) : Math.min(...values);
      if (values.every((value) => typeof value === "string")) {
        return values.slice(1).reduce((best, value) => name === "max" ? (value > best ? value : best) : (value < best ? value : best), values[0]!);
      }
      throw new ExpressionError("type_error", `${name} requires an array containing only numbers or only strings`);
    }
    case "str": arity(name, args, 1); return stringConversion(args[0]!);
    case "int": arity(name, args, 1); return integerConversion(args[0]!);
    case "bool": arity(name, args, 1); return truthy(args[0]!);
    case "matches": {
      arity(name, args, 2);
      const input = stringValue(args[0]!, "first matches argument");
      const pattern = stringValue(args[1]!, "second matches argument");
      return safeMatches(input, pattern);
    }
    case "file_exists": {
      arity(name, args, 1);
      return helpers(options).fileExists(stringValue(args[0]!, "file_exists path"));
    }
    case "file_contains": {
      arity(name, args, 2);
      return helpers(options).fileContains(stringValue(args[0]!, "file_contains path"), stringValue(args[1]!, "file_contains substring"));
    }
  }
  throw new ExpressionError("unknown_function", `unknown function ${JSON.stringify(name)}`);
}

function helpers(options: EvaluationOptions) {
  if (options.workspaceRoot === undefined) throw new ExpressionError("validation_error", "file function requires a workspace root");
  return createFileHelpers(options.workspaceRoot);
}

function contains(needle: JsonValue, haystack: JsonValue): boolean {
  if (Array.isArray(haystack)) return haystack.some((value) => jsonEqual(needle, value));
  if (typeof haystack === "string") return haystack.includes(stringValue(needle, "left operand of in"));
  const object = plainObject(haystack, "right operand of in");
  const key = stringValue(needle, "left operand of in");
  if (BLOCKED_MEMBERS.has(key)) throw new ExpressionError("validation_error", `member ${JSON.stringify(key)} is forbidden`);
  return Object.hasOwn(object, key);
}

function compare(left: JsonValue, right: JsonValue, operator: string): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  throw new ExpressionError("type_error", `operator ${operator} requires two numbers or two strings`);
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, indexValue) => jsonEqual(value, right[indexValue]!));
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!));
  }
  return false;
}

function assertJsonValue(value: unknown, label: string, seen = new WeakSet<object>(), depth = 0): JsonValue {
  if (depth > MAX_PARSE_DEPTH) throw new ExpressionError("resource_limit", `${label} exceeds JSON nesting limit ${MAX_PARSE_DEPTH}`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finiteNumber(value, label);
  if (typeof value !== "object") throw new ExpressionError("type_error", `${label} is not a JSON value`);
  if (seen.has(value)) throw new ExpressionError("type_error", `${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => assertJsonValue(item, label, seen, depth + 1));
    if (!isPlainObject(value)) throw new ExpressionError("type_error", `${label} must contain plain JSON objects only`);
    const copy: Record<string, JsonValue> = Object.create(null);
    for (const [key, item] of Object.entries(value)) copy[key] = assertJsonValue(item, label, seen, depth + 1);
    return copy;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plainObject(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!isPlainObject(value)) throw new ExpressionError("type_error", `${label} requires an object, received ${typeName(value)}`);
  return value;
}

function arrayValue(value: JsonValue, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new ExpressionError("type_error", `${label} requires an array, received ${typeName(value)}`);
  return value;
}

function booleanValue(value: JsonValue, label: string): boolean {
  if (typeof value !== "boolean") throw new ExpressionError("type_error", `${label} requires a boolean, received ${typeName(value)}`);
  return value;
}

function numberValue(value: JsonValue, label: string): number {
  if (typeof value !== "number") throw new ExpressionError("type_error", `${label} requires a number, received ${typeName(value)}`);
  return value;
}

function stringValue(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw new ExpressionError("type_error", `${label} requires a string, received ${typeName(value)}`);
  return value;
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new ExpressionError("type_error", `${label} must be a finite number`);
  return value;
}

function arity(name: string, args: JsonValue[], expected: number): void {
  if (args.length !== expected) throw new ExpressionError("type_error", `${name} expects ${expected} argument${expected === 1 ? "" : "s"}, received ${args.length}`);
}

function truthy(value: JsonValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function stringConversion(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function integerConversion(value: JsonValue): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return finiteNumber(Math.trunc(value), "int result");
  if (typeof value === "string" && /^[+-]?\d+$/u.test(value)) return finiteNumber(Number.parseInt(value, 10), "int result");
  throw new ExpressionError("type_error", `int requires a boolean, finite number, or integer string, received ${typeName(value)}`);
}

function safeMatches(input: string, pattern: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) throw new ExpressionError("resource_limit", `regex exceeds ${MAX_REGEX_LENGTH} characters`);
  if (input.length > MAX_REGEX_INPUT) throw new ExpressionError("resource_limit", `regex input exceeds ${MAX_REGEX_INPUT} characters`);
  if (!safeRegexShape(pattern)) throw new ExpressionError("validation_error", "regex contains a potentially unsafe construct");
  try { return new RegExp(pattern, "u").test(input); }
  catch (error) { throw new ExpressionError("validation_error", `invalid regex: ${errorMessage(error)}`); }
}

/**
 * Conservative shape filter: rejects backreferences, `(?...)` constructs, nested
 * quantifiers, and ADJACENT quantified atoms (`a*a*`, `[ab]+a?`, `(x)*(y)*`) —
 * sequential overlapping quantifiers backtrack combinatorially just like nested
 * ones. False positives are acceptable; a rejected pattern fails the predicate
 * with a structured reason, never hangs the evaluator.
 */
function safeRegexShape(pattern: string): boolean {
  if (/\\[1-9]/u.test(pattern) || pattern.includes("(?")) return false;
  // Parentheses are TRANSPARENT to adjacency: `(a*)(b*)` backtracks like `a*b*`,
  // so quantified-atom state flows into a group's first atom and out of its last,
  // and a quantified group checks the atom that preceded its `(`.
  const stack: Array<{ quantified: boolean; alternation: boolean; precededByQuantified: boolean }> = [];
  let quantifiers = 0;
  let lastAtomQuantified: boolean = false;
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index]!;

    if (char === "(") {
      stack.push({ quantified: false, alternation: false, precededByQuantified: lastAtomQuantified });
      index += 1;
      continue;
    }
    if (char === "|") {
      if (stack.length > 0) stack[stack.length - 1]!.alternation = true;
      lastAtomQuantified = false; // branches do not concatenate
      index += 1;
      continue;
    }

    // Consume exactly one atom.
    let atomEnd: number;
    let group: { quantified: boolean; alternation: boolean; precededByQuantified: boolean } | undefined;
    if (char === ")") {
      group = stack.pop();
      if (!group) return false; // unbalanced
      atomEnd = index + 1;
    } else if (char === "[") {
      let cursor = index + 1;
      while (cursor < pattern.length && pattern[cursor] !== "]") cursor += pattern[cursor] === "\\" ? 2 : 1;
      if (cursor >= pattern.length) return false; // unterminated class
      atomEnd = cursor + 1;
    } else if (char === "\\") {
      if (index + 1 >= pattern.length) return false; // dangling escape
      atomEnd = index + 2;
    } else if (isQuantifierStart(char)) {
      return false; // dangling quantifier (nothing to repeat)
    } else {
      atomEnd = index + 1; // plain character (anchors included)
    }

    const contentTrailingQuantified: boolean = lastAtomQuantified;
    const quantifierTail = quantifierEnd(pattern, atomEnd);
    const quantified = quantifierTail !== atomEnd;
    if (quantified) {
      quantifiers += 1;
      if (quantifiers > 32) return false;
      // Adjacency: for a quantified group the relevant neighbor is the atom before
      // its `(`; for any other atom it is the previous atom (incl. through `)`).
      if (group ? group.precededByQuantified : lastAtomQuantified) return false;
      if (group && (group.quantified || group.alternation)) return false; // nested quantifier
      if (stack.length > 0) stack[stack.length - 1]!.quantified = true;
    }
    if (group && (group.quantified || group.alternation) && stack.length > 0) {
      stack[stack.length - 1]!.quantified = true;
    }
    // An unquantified `)` stays transparent: its trailing content state flows onward.
    lastAtomQuantified = quantified || (group !== undefined && !quantified && contentTrailingQuantified);
    index = quantifierTail;
  }
  return stack.length === 0;
}

/** Returns the index just past a quantifier at `at` (incl. `{m,n}` and a lazy `?` suffix), or `at` if none. */
function quantifierEnd(pattern: string, at: number): number {
  const char = pattern[at] ?? "";
  let end = at;
  if (char === "*" || char === "+" || char === "?") {
    end = at + 1;
  } else if (char === "{") {
    const close = pattern.indexOf("}", at + 1);
    if (close === -1 || !/^\{\d+(,\d*)?\}$/u.test(pattern.slice(at, close + 1))) return at; // literal brace
    end = close + 1;
  } else {
    return at;
  }
  if (pattern[end] === "?") end += 1; // lazy modifier
  return end;
}

function isQuantifierStart(value: string): boolean { return value === "*" || value === "+" || value === "?" || value === "{"; }
function typeName(value: JsonValue): string { return value === null ? "null" : Array.isArray(value) ? "array" : typeof value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
