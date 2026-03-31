import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

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

function within(base: string, target: string) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function file(
  dir: string,
  path: string,
  options?: {
    fileRoot?: string;
    root?: string;
  },
) {
  const input = String(path || "").trim();
  const physicalDir = clean(dir);
  const logicalDir = clean(options?.fileRoot || dir);
  const physicalRoot = clean(options?.root || root(dir));
  const logicalRoot = root(logicalDir);

  if (isAbsolute(input)) {
    const absolute = clean(input);
    if (within(physicalRoot, absolute)) {
      return clean(resolve(logicalRoot, relative(physicalRoot, absolute)));
    }
    if (within(physicalDir, absolute)) {
      return clean(resolve(logicalDir, relative(physicalDir, absolute)));
    }
    return absolute;
  }

  return clean(resolve(logicalDir, input));
}
