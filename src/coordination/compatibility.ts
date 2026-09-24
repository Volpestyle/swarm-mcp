import { version } from "../../package.json";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SCHEMA_VERSION } from "./migrations";
import { CoordinationError } from "./errors";

type Build = { revision: string | null; sourceDigest: string | null; packageVersion: string; sdkVersion: string };
declare const SWARM_BUILD: Build | undefined;
const build: Build = typeof SWARM_BUILD === "undefined"
  ? { revision: null, sourceDigest: null, packageVersion: "development-unidentified", sdkVersion: "development-unidentified" }
  : SWARM_BUILD!;
export const SKILL_CONTRACT = "swarm-coordination/1";
export const SERVER_VERSION = version;
export const MODERN_PROTOCOL = "2026-07-28";
export const compatibility = Object.freeze({ apiVersion: 1, skillContract: SKILL_CONTRACT,
  schemaVersion: SCHEMA_VERSION, serverVersion: SERVER_VERSION, modernProtocol: MODERN_PROTOCOL, build });

/** Discovery is metadata only; the transport authenticates the caller first. */
export function assertCompatibleOwner(value: unknown) {
  const owner = value as Partial<typeof compatibility> | null;
  if (!owner || owner.apiVersion !== compatibility.apiVersion || owner.schemaVersion !== SCHEMA_VERSION || owner.skillContract !== SKILL_CONTRACT)
    throw new CoordinationError("coordinator_version_mismatch", "Owner API/schema/skill contract differs; use one candidate build and explicitly restart its owner before reconnecting");
  if (build.sourceDigest && owner.build?.sourceDigest !== build.sourceDigest)
    throw new CoordinationError("coordinator_build_mismatch", "Owner runs a different or unidentified build; stop its work safely and explicitly restart it from this candidate");
  return owner;
}

/** Checks the configured file, never claims to inspect a host's model context. */
export function inspectSkill(path?: string) {
  if (!path) return { status: "not_configured" as const, expectedContract: SKILL_CONTRACT };
  if (!isAbsolute(path)) throw new CoordinationError("skill_mismatch", "SWARM_SKILL_PATH must name an absolute SKILL.md path");
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch { throw new CoordinationError("skill_mismatch", "Configured skill file cannot be read; reinstall the candidate skill or correct SWARM_SKILL_PATH"); }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  const contract = /^\s*coordination-contract:\s*([a-z0-9/-]+)\s*$/m.exec(frontmatter)?.[1];
  if (contract !== SKILL_CONTRACT)
    throw new CoordinationError("skill_mismatch", `Configured skill lacks ${SKILL_CONTRACT}; update that copy before using the coordinator`);
  return { status: "file_verified" as const, expectedContract: SKILL_CONTRACT, path,
    limitation: "Configured file only; host-loaded instructions are not observable" };
}
