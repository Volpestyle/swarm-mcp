"""Run an explicit subprocess critical section under cooperative reservations."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
import time
try:
    import leased_writes as leases
except ModuleNotFoundError:
    from . import leased_writes as leases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["file", "integration"], default="file")
    parser.add_argument("--paths", default="[]", help="JSON array of concrete file paths")
    parser.add_argument("--reason", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not argv:
        parser.error("A subprocess argv is required after --")
    result = leases.acquire(json.loads(args.paths), args.reason, kind=args.kind)
    child = None
    try:
        child = subprocess.Popen(argv)
        grants = result["grants"] + result["reused"]
        while True:
            remaining = min(g["expires_at"] for g in grants) / 1000 - time.time()
            if remaining <= 0:
                raise RuntimeError("Reservation expired during critical section")
            try:
                return child.wait(timeout=min(10, remaining / 3))
            except subprocess.TimeoutExpired:
                if result["grants"]:
                    result["grants"] = leases.command("reservation.renew", {"grants": leases.refs(result["grants"]), "leaseMs": 60000})["grants"]
                grants = leases.command("reservation.check", {"grants": leases.refs(result["grants"] + result["reused"])})["grants"]
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        try:
            leases.release(result)
        except Exception as error:
            print(f"Reservation release failed: {error}", file=sys.stderr)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
