import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

function clean(path: string) {
  const next = normalize(resolve(path));
  return process.platform === "win32" ? next.toLowerCase() : next;
}

export function norm(path: string) {
  return clean(path);
}

export function root(dir: string) {
  const start = clean(dir);
  let cur = start;

  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;

    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

export function scope(dir: string, value?: string) {
  const next = value?.trim();
  if (next) return next;
  return root(dir);
}

export function file(dir: string, path: string) {
  if (isAbsolute(path)) return clean(path);
  return clean(resolve(dir, path));
}
