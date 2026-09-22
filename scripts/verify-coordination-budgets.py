"""Enforce measured IPC and compact-API budgets; not a complete release gate."""
import argparse
import json
import math
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
for name in ["agents2", "agents8", "agents32", "baseline32", "tokens"]:
    parser.add_argument("--" + name, required=True, type=Path)
args = parser.parse_args()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def number(value, name):
    require(isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0, f"Invalid metric: {name}")
    return value


def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


measurements = []
hardware = None
for count, path in [(2, args.agents2), (8, args.agents8), (32, args.agents32)]:
    data = load(path)
    workload = data["workload"]
    require(workload["count"] == count and workload["messagesPerAgent"] == 12
            and workload["bodyBytes"] == 256 and workload["spacingMs"] == 73,
            f"{count}: workload does not match selected ring budget")
    require(not workload.get("profiled") and workload["warmupMs"] >= 2000
            and not workload.get("slowMs") and not workload.get("deferredConsumerMs")
            and not workload.get("physicalDisconnectMs"), f"{count}: nonstandard workload")
    require(not data["errors"] and data.get("quotaRejections", 0) == 0,
            f"{count}: send errors or quota rejections")
    require(len(data["workers"]) == count, f"{count}: missing workers")
    samples = [s for worker in data["workers"] for s in worker["samples"]]
    expected = count * 12
    require(len(samples) == len({s["messageId"] for s in samples}) ==
            data["accepted"] == data["received"] == expected,
            f"{count}: missing or duplicate deliveries")
    state = data["diagnostics"]["summary"]
    require(state["acknowledged"] == expected and
            state["pending"] == state["leased"] == state["deadLetter"] == 0,
            f"{count}: incomplete durable acknowledgment")
    require(data["diagnostics"].get("database") == {"journalMode": "wal", "synchronous": 2},
            f"{count}: durability changed or writer evidence missing")
    require(data["diagnostics"]["processMetrics"]["databaseBusyErrors"] == 0,
            f"{count}: database busy errors")
    delivery = [number(s["receivedAt"] - s["createdAt"], "delivery") for s in samples]
    p95, p99 = percentile(delivery, .95), percentile(delivery, .99)
    require(p95 <= 100 and p99 <= 250, f"{count}: delivery budget failed: p95={p95}, p99={p99}")
    for key, value in [("p95", p95), ("p99", p99)]:
        require(data["deliveryMs"][key] == value, f"{count}: summary disagrees with samples")
    owner_memory = number(data["ownerWorkingSetBytes"], "ownerWorkingSetBytes")
    require(0 < owner_memory <= 256 * 1024**2, f"{count}: owner memory exceeds 256 MiB")
    require(number(data["ownerPrivateBytes"], "ownerPrivateBytes") > 0,
            f"{count}: private memory not measured")
    fingerprint = {k: data["hardware"][k] for k in
                   ["cpu", "logicalCpus", "physicalMemoryBytes", "platform", "release", "bun"]}
    if hardware is None:
        hardware = fingerprint
    require(fingerprint == hardware, f"{count}: hardware/runtime mismatch")
    measurements.append({"agents": count, "p95": p95, "p99": p99,
                         "ownerWorkingSetBytes": owner_memory})
    if count == 32:
        require(workload["idleMs"] >= 60000 and
                all(w["idleWallMs"] >= 60000 for w in data["workers"]),
                "32: idle sample shorter than 60 seconds")
        cpu = number(data["aggregateIdleCpuPercentOfOneCore"], "idle CPU")
        require(cpu <= 2, f"32: idle CPU budget failed: {cpu}")
        elapsed = max(w["finished"] for w in data["workers"]) - min(w["sendStart"] for w in data["workers"])
        require(elapsed > 0, "32: invalid workload duration")
        throughput = expected * 1000 / elapsed
        require(throughput >= 250, f"32: throughput budget failed: {throughput}")
        baseline = load(args.baseline32)
        require(baseline["hardware"] == hardware and baseline["workload"]["count"] == 32,
                "32: baseline configuration mismatch")
        fixture_memory = data["aggregateWorkerRssBytes"] + owner_memory
        require(fixture_memory <= baseline["aggregateWorkerRssBytes"],
                "32: IPC fixture resident memory exceeds legacy fixture")
        measurements[-1].update(idleCpuPercent=cpu, deliveredPerSecond=throughput,
                                fixtureResidentBytes=fixture_memory)

tokens = load(args.tokens)
require(tokens["tokenizer"] == "tiktoken 0.12.0 / o200k_base", "Unexpected tokenizer")
rows = [row for row in tokens["runs"] if row["agents"] == 32]
require(len(rows) == 1, "Missing or ambiguous 32-agent token capture")
row = rows[0]
require(number(row["schemaTokensPerAgent"], "schema tokens") <= 3000, "Core catalog exceeds 3000 tokens")
sync = row["byTool"]["swarm_sync"]
require(sync["calls"] == 32 and number(sync["maxTextResultTokensPerCall"], "sync tokens") <= 1000,
        "Sync exceeds per-agent token budget or lacks all agents")
require(row["calls"] - sync["calls"] == 32 * 3, "Manual handoff call count changed")
print(json.dumps({"measuredBudgetsPassed": True, "ipc": measurements,
    "schemaTokensPerAgent": row["schemaTokensPerAgent"],
    "maxSyncTextTokensPerAgent": sync["maxTextResultTokensPerCall"],
    "manualHandoffCalls": 3,
    "uncovered": ["Full host/adapter memory", "Native-only comparison",
                  "Crash/restart and stale-owner invariants require the separate failure gate",
                  "Automatic host delivery and consumer recovery require separate captures",
                  "Hosted CI and migration/rollout"]}, indent=2))
