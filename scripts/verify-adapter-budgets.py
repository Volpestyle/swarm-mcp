"""Verify real stdio memory and bounded native/mixed-host fixture evidence."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
for name in ["legacy", "redesign", "native", "mixed"]:
    parser.add_argument("--" + name, required=True, type=Path)
args = parser.parse_args()


def require(value, message):
    if not value:
        raise SystemExit(message)


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def memory(data, expected):
    sample = data["memory"]
    require(sample["supported"] and len(sample["processes"]) == expected, "Missing process memory")
    require(len({p["Id"] for p in sample["processes"]}) == expected, "Duplicate process sample")
    for total, field in [("totalWorkingSetBytes", "WorkingSet64"), ("totalPrivateBytes", "PrivateMemorySize64")]:
        require(all(p[field] > 0 for p in sample["processes"]), "Invalid memory measurement")
        require(sum(p[field] for p in sample["processes"]) == sample[total], "Memory summary mismatch")
    return sample


legacy, redesign, native, mixed = [load(getattr(args, name)) for name in ["legacy", "redesign", "native", "mixed"]]
require(legacy["count"] == redesign["count"] == 32, "Adapter counts differ")
old, new = memory(legacy, 32), memory(redesign, 33)
require(old["environment"] == new["environment"], "Adapter hardware differs")
require(new["totalWorkingSetBytes"] <= old["totalWorkingSetBytes"], "Adapter resident-memory budget failed")
require(new["totalPrivateBytes"] <= old["totalPrivateBytes"], "Adapter private-memory comparison regressed")
roles = redesign["memoryRoles"]
require(len(roles["adapters"]) == 32 and set(roles["adapters"] + [roles["owner"]]) ==
        {p["Id"] for p in new["processes"]}, "Adapter/owner roles missing")
require(len(native["children"]) == 1 and len(native["toolCalls"]) == 1 and
        native["toolCalls"][0]["name"] == "task" and
        native["swarmConfigured"] is False and native["coordinatorStarted"] is False,
        "Native-only fixture did not establish one native delegation")
native_memory = memory(native, 1)
mixed_memory = memory(mixed, 2)
peer = mixed["mixedHost"]
claude_memory = memory(peer["result"], 1)
require(peer["userPromptInvocations"] == 1, "Unexpected explicit user-turn count")
require(len(mixed["toolCalls"]) == 2 and len(peer["calls"]) == 2,
        "Two-host round trip exceeds four model-visible coordination calls")
require([c["name"] for c in peer["calls"]] == ["mcp__swarm__swarm_send", "mcp__swarm__swarm_inbox"],
        "Unexpected Claude coordination calls")
require(len(peer["deliveries"]) == 2 and all(d["state"] == "acknowledged" and d["attempts"] == 1 for d in peer["deliveries"]),
        "Peer delivery incomplete or duplicated")
require(len(mixed["attempts"]) == len(mixed["children"]) == 1 and
        mixed["attempts"][0]["state"] == mixed["completed"]["status"] == "completed",
        "Mixed task did not finish exactly once")
print(json.dumps({"measuredAdapterBudgetsPassed": True,
    "legacy32WorkingSetBytes": old["totalWorkingSetBytes"],
    "redesign32AndOwnerWorkingSetBytes": new["totalWorkingSetBytes"],
    "legacy32PrivateBytes": old["totalPrivateBytes"],
    "redesign32AndOwnerPrivateBytes": new["totalPrivateBytes"],
    "nativeHostWorkingSetBytes": native_memory["totalWorkingSetBytes"],
    "mixedOpenCodeAndOwnerWorkingSetBytes": mixed_memory["totalWorkingSetBytes"],
    "claudeHostWorkingSetBytes": claude_memory["totalWorkingSetBytes"],
    "limitations": "Root host processes sampled separately, not simultaneous aggregate peaks. Native and mixed tasks have different durability/isolation and workloads; no speed ratio. Bash fixture tools contain multiple coordinator commands. No inference, billing, long-duration leak or hosted CI claim."}, indent=2))
