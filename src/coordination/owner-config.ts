import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { requireText } from "./errors";
import { ownerDispatchSchema, type OwnerDispatch } from "./owner-dispatch";

export function readOwnerConfig(path: string): {
  databasePath: string;
  launcherSecret: string;
  dispatch?: OwnerDispatch;
} {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 8192) throw new Error("Owner config exceeds 8 KiB");
  const config = JSON.parse(bytes.toString("utf8"));
  requireText(config?.databasePath, "databasePath", 4096);
  requireText(config?.launcherSecret, "launcherSecret", 512);
  if (!isAbsolute(config.databasePath))
    throw new Error("Owner databasePath must be absolute");
  if (config.launcherSecret.length < 32)
    throw new Error("Owner launcherSecret must contain at least 32 characters");
  return {
    databasePath: config.databasePath,
    launcherSecret: config.launcherSecret,
    ...(config.dispatch === undefined
      ? {}
      : { dispatch: ownerDispatchSchema.parse(config.dispatch) }),
  };
}
