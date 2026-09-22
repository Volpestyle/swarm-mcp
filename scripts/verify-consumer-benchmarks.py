"""Check measured consumer recovery/backpressure evidence, not all release budgets."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--disconnect", required=True, type=Path)
parser.add_argument("--saturated", required=True, type=Path)
parser.add_argument("--slow", required=True, type=Path)
args = parser.parse_args()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def load(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    samples = [s for w in data["workers"] for s in w["samples"]]
    require(not data["errors"], f"{path}: unexpected errors")
    require(data["accepted"] + data.get("quotaRejections", 0) ==
            data["workload"]["count"] * data["workload"]["messagesPerAgent"],
            f"{path}: unaccounted sends")
    require(len(samples) == len({s["messageId"] for s in samples}) ==
            data["received"] == data["accepted"], f"{path}: loss or duplicate delivery")
    state = data["diagnostics"]["summary"]
    require(state["acknowledged"] == data["accepted"] and
            state["pending"] == state["leased"] == state["deadLetter"] == 0,
            f"{path}: incomplete acknowledgment")
    require(data["diagnostics"]["database"] == {"journalMode": "wal", "synchronous": 2},
            f"{path}: wrong durability configuration")
    return data


for path, saturated in [(args.disconnect, False), (args.saturated, True)]:
    data = load(path)
    require(data["workload"].get("physicalDisconnectMs", 0) > 0,
            f"{path}: no physical disconnect")
    consumer = data["workers"][0]
    recovery = consumer["recovery"]
    resumed = recovery["reconnectedAt"]
    require(resumed - recovery["disconnectedAt"] >= data["workload"]["physicalDisconnectMs"],
            f"{path}: disconnect shorter than configured")
    require(0 <= recovery["firstDeliveryAt"] - resumed <= 5000,
            f"{path}: replay readiness exceeded 5 seconds")
    require(all(s["receivedAt"] >= resumed for s in consumer["samples"]),
            f"{path}: consumer received while disconnected")
    require(all(any(s["ackResponseAt"] < resumed for s in w["samples"])
                for w in data["workers"][1:]), f"{path}: healthy peer made no progress")
    if saturated:
        require(data["quotaRejections"] > 0 and consumer["received"] == 1000 and
                recovery["scopePendingAtReconnect"] == 1000,
                f"{path}: default 1000-message capacity was not exercised")
        require(recovery["initialDrainCompletedAt"] - resumed <= 5000,
                f"{path}: saturated queue drain exceeded 5 seconds")
        require(all(all(s["ackResponseAt"] < resumed for s in w["samples"])
                    for w in data["workers"][1:]), f"{path}: healthy peer did not finish")

data = load(args.slow)
require(data["workload"]["slowMs"] > 0, "Slow run has no processing delay")
slow_finished = max(s["ackResponseAt"] for s in data["workers"][0]["samples"])
require(all(max(s["ackResponseAt"] for s in w["samples"]) < slow_finished
            for w in data["workers"][1:]), "Slow consumer stalled a healthy peer")
print("Consumer evidence passed: exact acknowledgment, quota, replay and peer progress.")
print("Scope: isolated IPC fixtures; not process-crash, host-wake or full release proof.")
