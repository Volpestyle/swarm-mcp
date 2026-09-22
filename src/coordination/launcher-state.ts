import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  lstatSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { readOwnerConfig } from "./owner-config";

function privatePath(path: string, initialize = false) {
  const stat = lstatExists(path) ? lstatSync(path) : undefined;
  if (stat?.isSymbolicLink())
    throw new Error("Launcher state cannot be a symbolic link");
  if (process.platform !== "win32") {
    if (!stat) throw new Error("Launcher state does not exist");
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Launcher state must be owned by this user and private (0700 directory / 0600 file)",
      );
    return;
  }
  // Pass paths as environment data, never executable PowerShell interpolation.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference = 'Stop'
$target = $env:SWARM_PRIVATE_STATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:SWARM_PRIVATE_STATE_INITIALIZE -eq '1') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  # CreateDirectory receives the ACL at creation; there is no public-directory
  # window for another launcher to observe. Existing directories are unchanged.
  $directory = New-Object System.IO.DirectoryInfo($target)
  $directory.Create($acl)
}
$acl = Get-Acl -LiteralPath $target
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Launcher state has a different owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Launcher state grants access to another principal' }
}
`,
    ],
    {
      windowsHide: true,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SWARM_PRIVATE_STATE_PATH: path,
        SWARM_PRIVATE_STATE_INITIALIZE: initialize ? "1" : "0",
      },
    },
  );
}

/** Caller creates the parent under its own profile directory. Existing insecure
 * directories are rejected, never silently re-permissioned or rotated. */
export function prepareLauncherDirectory(path: string) {
  if (!isAbsolute(path))
    throw new Error("Launcher state directory must be absolute");
  if (process.platform === "win32") {
    privatePath(path, true);
    if (!lstatSync(path).isDirectory())
      throw new Error("Launcher state path must be a directory");
    return;
  }
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isDirectory())
    throw new Error("Launcher state path must be a directory");
  privatePath(path, created);
}

function record<T>(directory: string, name: string, create: () => T): T {
  const target = join(directory, name);
  if (!lstatExists(target)) {
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(create()));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      unlinkSync(temporary);
    }
  }
  privatePath(target);
  const bytes = readFileSync(target);
  if (bytes.byteLength > 8192) throw new Error("Launcher state exceeds 8 KiB");
  return JSON.parse(bytes.toString("utf8")) as T;
}
function lstatExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function ownerState(directory: string) {
  prepareLauncherDirectory(directory);
  record(directory, "owner.json", () => ({
    databasePath: join(directory, "coordination.db"),
    launcherSecret: randomBytes(32).toString("hex"),
  }));
  return {
    configPath: join(directory, "owner.json"),
    ...readOwnerConfig(join(directory, "owner.json")),
  };
}

export function agentState(
  directory: string,
  scope: string,
  host: string,
  hostSessionId: string,
) {
  prepareLauncherDirectory(directory);
  if (
    ![scope, host, hostSessionId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 4096,
    )
  )
    throw new Error("Invalid launcher identity key");
  const key = createHash("sha256")
    .update(JSON.stringify([scope, host, hostSessionId]))
    .digest("hex");
  const result = record(directory, `agent-${key}.json`, () => ({
    agentId: randomUUID(),
    resumeToken: randomBytes(32).toString("hex"),
  }));
  if (
    !/^[a-f0-9-]{36}$/.test(result.agentId) ||
    !/^[a-f0-9]{64}$/.test(result.resumeToken)
  )
    throw new Error(
      "Invalid retained launcher identity; refusing to rotate it",
    );
  return result;
}

/** A single owner publishes an intent before contacting the host. A later
 * process reconciles the same IDs rather than blindly injecting another turn. */
export function wakeState(
  directory: string,
  scope: string,
  session: string,
  message: string,
) {
  prepareLauncherDirectory(directory);
  if (
    ![scope, session, message].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 4096,
    )
  )
    throw new Error("Invalid wake identity");
  const key = createHash("sha256")
    .update(JSON.stringify([scope, session, message]))
    .digest("hex");
  // Match the installed host's ascending ID time prefix; keep the random tail
  // independent so parallel trusted launchers cannot collide.
  const time = ((BigInt(Date.now()) * 4096n + 1n) & 0xffffffffffffn)
    .toString(16)
    .padStart(12, "0");
  const candidate = {
    messageId: `msg_${time}${randomBytes(7).toString("hex")}`,
    partId: `prt_${time}${randomBytes(7).toString("hex")}`,
  };
  const saved = record(directory, `wake-${key}.json`, () => candidate);
  if (
    !/^msg_[a-f0-9]{26}$/.test(saved.messageId) ||
    !/^prt_[a-f0-9]{26}$/.test(saved.partId)
  )
    throw new Error("Invalid retained wake intent");
  return { ...saved, fresh: saved.messageId === candidate.messageId };
}
