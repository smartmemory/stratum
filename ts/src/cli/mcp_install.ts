import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const PACKAGE_NAME = "@smartmemory/stratum";
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

interface McpEntry {
  command: string;
  args: string[];
}

interface Finding {
  className: string;
  current: string;
  recommendation: string;
}

interface InstallOptions {
  project: string;
  version: string;
}

interface DoctorOptions {
  project: string;
  fix: boolean;
  all: boolean;
}

type JsonObject = Record<string, unknown>;

export async function mcpCommand(args: string[]): Promise<number> {
  const options = parseInstall(args);
  if (!options) return usageInstall();
  try {
    const result = await writeCanonical(options.project, options.version, false);
    process.stdout.write(`${result.path}: ${result.action}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`stratum mcp install: ${message(error)}\n`);
    return 2;
  }
}

export async function doctorCommand(args: string[]): Promise<number> {
  const options = parseDoctor(args);
  if (!options) return usageDoctor();

  if (!options.all) return doctorProject(options.project, options.fix);

  let projects: string[] | undefined;
  try {
    projects = await registeredConsumers();
  } catch (error) {
    process.stderr.write(`stratum doctor: ${message(error)}\n`);
    return 2;
  }
  if (!projects) {
    process.stdout.write("no consumer registry configured\n");
    return 0;
  }

  let exitCode = 0;
  for (const project of projects) {
    const code = await doctorProject(project, options.fix);
    exitCode = Math.max(exitCode, code);
  }
  return exitCode;
}

interface UpgradeOptions {
  project: string;
  version: string;
  all: boolean;
  python: boolean;
}

const RETIRED_PYTHON_PACKAGES = ["stratum-mcp", "stratum-py"];

/**
 * One-shot migration/upgrade: repoint every target's .mcp.json stratum entry to
 * the canonical npx form at THIS package's version (so running via
 * `npx @smartmemory/stratum@latest stratum upgrade` bumps consumers to latest),
 * then remove the retired Python packages. Nothing here fails the command.
 */
export async function upgradeCommand(args: string[]): Promise<number> {
  const options = parseUpgrade(args);
  if (!options) return usageUpgrade();

  let projects: string[];
  if (options.all) {
    let registry: string[] | undefined;
    try {
      registry = await registeredConsumers();
    } catch (error) {
      process.stderr.write(`stratum upgrade: ${message(error)}\n`);
      return 2;
    }
    if (!registry) {
      process.stdout.write("no consumer registry configured\n");
      projects = [];
    } else {
      projects = registry;
    }
  } else {
    projects = [options.project];
  }

  for (const project of projects) {
    try {
      const result = await writeCanonical(project, options.version, true);
      process.stdout.write(`${result.path}: ${result.action}\n`);
    } catch (error) {
      process.stderr.write(`stratum upgrade: ${project}: ${message(error)}\n`);
    }
  }

  if (options.python) {
    const py = removeRetiredPython();
    if (py.skipped) process.stdout.write(`Retired Python packages: ${py.skipped}\n`);
    else if (py.removed.length) process.stdout.write(`Removed retired Python packages: ${py.removed.join(", ")}\n`);
    else process.stdout.write("Retired Python packages: none installed\n");
  }

  process.stdout.write("Upgrade complete — the new engine loads on your MCP client's next start (e.g. a fresh session).\n");
  return 0;
}

/** Detect and uninstall the retired stratum-mcp / stratum-py PyPI packages. Never throws. */
function removeRetiredPython(): { removed: string[]; skipped?: string } {
  const pip = pipCommand();
  if (!pip) return { removed: [], skipped: "pip not found — nothing to clean up" };
  const removed: string[] = [];
  for (const pkg of RETIRED_PYTHON_PACKAGES) {
    try {
      execFileSync(pip.command, [...pip.args, "show", pkg], { stdio: "ignore" });
    } catch {
      continue; // not installed
    }
    try {
      execFileSync(pip.command, [...pip.args, "uninstall", "-y", pkg], { stdio: "ignore" });
      removed.push(pkg);
    } catch {
      // best-effort; leave it rather than fail the upgrade
    }
  }
  return { removed };
}

function pipCommand(): { command: string; args: string[] } | undefined {
  const candidates = [
    { command: "pip3", args: [] as string[] },
    { command: "pip", args: [] as string[] },
    { command: "python3", args: ["-m", "pip"] },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

function parseUpgrade(args: string[]): UpgradeOptions | undefined {
  const rest = [...args];
  let project = process.cwd();
  let projectSet = false;
  let version = PACKAGE_VERSION;
  let all = false;
  let python = true;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--project") {
      const value = rest.shift();
      if (!value || projectSet) return undefined;
      project = value;
      projectSet = true;
    } else if (flag === "--version") {
      const value = rest.shift();
      if (!value) return undefined;
      version = value;
    } else if (flag === "--all") {
      if (all) return undefined;
      all = true;
    } else if (flag === "--no-python") {
      python = false;
    } else {
      return undefined;
    }
  }
  if (all && projectSet) return undefined;
  return { project, version, all, python };
}

function usageUpgrade(): number {
  process.stderr.write("Usage: stratum upgrade [--project <dir>] [--version <v>] [--all] [--no-python]\n");
  return 2;
}

function parseInstall(args: string[]): InstallOptions | undefined {
  if (args[0] !== "install") return undefined;
  const rest = args.slice(1);
  let project = process.cwd();
  let version = PACKAGE_VERSION;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--project") {
      const value = rest.shift();
      if (!value) return undefined;
      project = value;
    } else if (flag === "--version") {
      const value = rest.shift();
      if (!value) return undefined;
      version = value;
    } else {
      return undefined;
    }
  }
  return { project, version };
}

function parseDoctor(args: string[]): DoctorOptions | undefined {
  const rest = [...args];
  let project = process.cwd();
  let projectSet = false;
  let fix = false;
  let all = false;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--project") {
      const value = rest.shift();
      if (!value || projectSet) return undefined;
      project = value;
      projectSet = true;
    } else if (flag === "--fix") {
      if (fix) return undefined;
      fix = true;
    } else if (flag === "--all") {
      if (all) return undefined;
      all = true;
    } else {
      return undefined;
    }
  }
  if (all && projectSet) return undefined;
  return { project, fix, all };
}

function usageInstall(): number {
  process.stderr.write("Usage: stratum mcp install [--project <dir>] [--version <v>]\n");
  return 2;
}

function usageDoctor(): number {
  process.stderr.write("Usage: stratum doctor [--project <dir>] [--fix] [--all]\n");
  return 2;
}

async function doctorProject(project: string, fix: boolean): Promise<number> {
  let findings: Finding[];
  try {
    findings = await inspect(project);
  } catch (error) {
    process.stderr.write(`stratum doctor: ${project}: ${message(error)}\n`);
    return 2;
  }

  if (findings.length === 0) {
    process.stdout.write(`${project}: ok\n`);
    return 0;
  }
  for (const finding of findings) printFinding(project, fix ? "before" : undefined, finding);
  if (!fix) return 1;

  try {
    await writeCanonical(project, PACKAGE_VERSION, true);
    const after = await inspect(project);
    if (after.length === 0) {
      process.stdout.write(`${project}: after: ok\n`);
      return 0;
    }
    for (const finding of after) printFinding(project, "after", finding);
    return 1;
  } catch (error) {
    process.stderr.write(`stratum doctor: ${project}: ${message(error)}\n`);
    return 2;
  }
}

async function inspect(project: string): Promise<Finding[]> {
  const path = join(project, ".mcp.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [finding("missing-file", "missing", project)];
    }
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch (error) {
    return [finding("malformed-json", message(error), project)];
  }
  if (!isRecord(document)) {
    return [finding("malformed-json", JSON.stringify(document), project)];
  }
  if (!isRecord(document.mcpServers) || !("stratum" in document.mcpServers)) {
    return [finding("missing-entry", "missing", project)];
  }

  const entry = document.mcpServers.stratum;
  const current = JSON.stringify(entry);
  if (!isRecord(entry)) return [finding("invalid-entry", current, project)];

  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) && entry.args.every((value) => typeof value === "string")
    ? entry.args as string[]
    : [];
  const findings: Finding[] = [];
  if (command === "stratum-mcp" || command === "stratum") {
    findings.push(finding("retired-bin", current, project));
  }
  if ([command, ...args].some(isSourceCheckoutPath)) {
    findings.push(finding("source-path", current, project));
  }
  const packageArg = args.find((arg) => arg.startsWith(`--package=${PACKAGE_NAME}@`));
  if (command === "npx" && packageArg) {
    const pinnedVersion = packageArg.slice(`--package=${PACKAGE_NAME}@`.length);
    if (pinnedVersion !== PACKAGE_VERSION) findings.push(finding("version-drift", current, project));
  }
  if (findings.length > 0) return findings;
  return sameEntry(entry, canonicalEntry(PACKAGE_VERSION))
    ? []
    : [finding("invalid-entry", current, project)];
}

function finding(className: string, current: string, project: string): Finding {
  return {
    className,
    current,
    recommendation: `set ${join(project, ".mcp.json")} mcpServers.stratum to ${JSON.stringify(canonicalEntry(PACKAGE_VERSION))}`,
  };
}

function printFinding(project: string, phase: string | undefined, findingValue: Finding): void {
  const prefix = phase ? `${project}: ${phase}:` : `${project}:`;
  process.stdout.write(`${prefix} ${findingValue.className}: current=${findingValue.current}; fix=${findingValue.recommendation}\n`);
}

async function writeCanonical(project: string, version: string, repairMalformed: boolean): Promise<{ path: string; action: "created" | "repointed" | "already-current" }> {
  const path = join(project, ".mcp.json");
  let source: string | undefined;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let document: JsonObject = {};
  if (source !== undefined) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed)) throw new Error("root must be a JSON object");
      document = parsed;
    } catch (error) {
      if (!repairMalformed) throw new Error(`${path} is malformed: ${message(error)}`);
    }
  }

  let servers: JsonObject;
  if (isRecord(document.mcpServers)) {
    servers = document.mcpServers;
  } else if (document.mcpServers === undefined || repairMalformed) {
    servers = {};
    document.mcpServers = servers;
  } else {
    throw new Error(`${path} mcpServers must be a JSON object`);
  }

  const canonical = canonicalEntry(version);
  if (source !== undefined && sameEntry(servers.stratum, canonical)) {
    return { path, action: "already-current" };
  }
  servers.stratum = canonical;
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { path, action: source === undefined ? "created" : "repointed" };
}

function canonicalEntry(version: string): McpEntry {
  return {
    command: "npx",
    args: ["-y", `--package=${PACKAGE_NAME}@${version}`, "stratum-mcp"],
  };
}

function sameEntry(value: unknown, expected: McpEntry): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 2
    && value.command === expected.command
    && Array.isArray(value.args)
    && value.args.length === expected.args.length
    && value.args.every((arg, index) => arg === expected.args[index]);
}

function isSourceCheckoutPath(value: string): boolean {
  if (!isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized.endsWith("/ts/src/mcp/bin.mjs")
    || /\/stratum\/.+\/bin\.mjs$/.test(normalized);
}

async function registeredConsumers(): Promise<string[] | undefined> {
  const fromEnvironment = process.env.STRATUM_CONSUMERS?.split(":").map((value) => value.trim()).filter(Boolean);
  if (fromEnvironment && fromEnvironment.length > 0) return [...new Set(fromEnvironment)];

  const path = join(homedir(), ".stratum", "consumers.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error(`${path} must contain a JSON array of consumer directories`);
  }
  return [...new Set(parsed)];
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
