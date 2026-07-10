import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

/** Bound on file_contains reads — a workspace file must not exhaust evaluator memory. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class FileValidationError extends Error {
  readonly code = "validation_error";

  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function validateRelativePath(path: string): void {
  if (path.length === 0) throw new FileValidationError("file path must not be empty");
  if (path.includes("\0")) throw new FileValidationError("file path must not contain NUL bytes");
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path)) {
    throw new FileValidationError(`absolute file path is not allowed: ${JSON.stringify(path)}`);
  }
}

/** Resolve a user path lexically, then (when it exists) enforce the realpath jail too. */
export function resolveWorkspacePath(workspaceRoot: string, path: string): string {
  validateRelativePath(path);
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) {
    throw new FileValidationError(`file path escapes workspace root: ${JSON.stringify(path)}`);
  }

  if (existsSync(candidate)) {
    let realRoot: string;
    let realCandidate: string;
    try {
      realRoot = realpathSync(root);
      realCandidate = realpathSync(candidate);
    } catch (error) {
      throw new FileValidationError(`file path could not be resolved: ${errorMessage(error)}`);
    }
    if (!inside(realRoot, realCandidate)) {
      throw new FileValidationError(`file path resolves outside workspace root: ${JSON.stringify(path)}`);
    }
    return realCandidate;
  }

  return candidate;
}

export interface FileHelpers {
  fileExists(path: string): boolean;
  fileContains(path: string, substring: string): boolean;
}

/**
 * Jail guarantees: lexical normalization + realpath containment + O_NOFOLLOW on the
 * final component + fd-based bounded reads. Accepted residual (owner decision,
 * 2026-07-10): an attacker who can swap an ALREADY-CHECKED ANCESTOR DIRECTORY for a
 * symlink between the realpath check and open can still escape — Node exposes no
 * portable openat/O_RESOLVE_BENEATH to close that window. The jail is defense in
 * depth for predicate evaluation, not a boundary against a concurrent local attacker.
 */
export function createFileHelpers(workspaceRoot: string, options: { maxFileBytes?: number } = {}): FileHelpers {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new FileValidationError(`maxFileBytes must be a positive integer, received ${String(maxFileBytes)}`);
  }
  return {
    fileExists(path) {
      const resolved = resolveWorkspacePath(workspaceRoot, path);
      if (!existsSync(resolved)) return false;
      try {
        // lstat: resolveWorkspacePath already realpath-resolved; a symlink here is post-check churn.
        return lstatSync(resolved).isFile();
      } catch {
        return false;
      }
    },
    fileContains(path, substring) {
      const resolved = resolveWorkspacePath(workspaceRoot, path);
      // O_NOFOLLOW closes the realpath-check → open race on the final component:
      // a symlink swapped in after the jail check fails loudly instead of escaping.
      let descriptor: number;
      try {
        descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        if (errorCode(error) === "ELOOP") throw new FileValidationError("file became a symlink after the jail check; refusing to follow it");
        throw new FileValidationError(`file could not be opened: ${errorMessage(error)}`);
      }
      try {
        const stats = fstatSync(descriptor);
        if (!stats.isFile()) return false;
        if (stats.size > maxFileBytes) {
          throw new FileValidationError(`file exceeds the ${maxFileBytes}-byte file_contains read limit`);
        }
        // Bounded read loop: never trust the fstat snapshot — a file grown after the
        // stat still cannot pull more than maxFileBytes + 1 bytes into memory.
        const buffer = Buffer.alloc(maxFileBytes + 1);
        let total = 0;
        while (total < buffer.length) {
          const bytesRead = readSync(descriptor, buffer, total, buffer.length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total > maxFileBytes) {
          throw new FileValidationError(`file exceeds the ${maxFileBytes}-byte file_contains read limit`);
        }
        return buffer.toString("utf8", 0, total).includes(substring);
      } catch (error) {
        if (error instanceof FileValidationError) throw error;
        throw new FileValidationError(`file could not be read: ${errorMessage(error)}`);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
