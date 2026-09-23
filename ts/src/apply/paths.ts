import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function realpathThroughMissing(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
