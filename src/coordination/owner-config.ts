import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { requireText } from "./errors";
import { ownerDispatchSchema, type OwnerDispatch } from "./owner-dispatch";
import { storageLimits, type StorageLimits } from "./storage";

export function readOwnerConfig(path: string): {
  databasePath: string;
  launcherSecret: string;
  dispatch?: OwnerDispatch;
  storage: StorageLimits;
} {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 65536) throw new Error("Owner config exceeds 64 KiB");
  const config = JSON.parse(bytes.toString("utf8"));
  if (config?.version !== undefined && config.version !== 1)
    throw new Error("Unsupported owner config version; use version 1 from this candidate without rotating retained credentials");
  requireText(config?.databasePath, "databasePath", 4096);
  requireText(config?.launcherSecret, "launcherSecret", 512);
  if (!isAbsolute(config.databasePath))
    throw new Error("Owner databasePath must be absolute");
  if (config.launcherSecret.length < 32)
    throw new Error("Owner launcherSecret must contain at least 32 characters");
  if (config.storage !== undefined && (!config.storage || typeof config.storage !== "object" || Array.isArray(config.storage)
      || Object.keys(config.storage).some(key => !["databaseBytes", "artifactBytes"].includes(key))))
    throw new Error("storage accepts databaseBytes and artifactBytes only");
  return {
    databasePath: config.databasePath,
    launcherSecret: config.launcherSecret,
    storage: storageLimits(config.storage),
    ...(config.dispatch === undefined
      ? {}
      : { dispatch: ownerDispatchSchema.parse(config.dispatch) }),
  };
}
