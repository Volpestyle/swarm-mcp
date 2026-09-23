import { createHash } from "node:crypto";
import { ownerState, agentState } from "../../src/coordination/launcher-state";
const directory = process.argv[2]!;
const owner = await ownerState(directory);
const agent = await agentState(directory, "scope", "host", "session");
console.log(
  JSON.stringify({
    owner: createHash("sha256").update(owner.launcherSecret).digest("hex"),
    agent: createHash("sha256").update(JSON.stringify(agent)).digest("hex"),
  }),
);
