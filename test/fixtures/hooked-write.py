"""Host-contract driver: run the real pre-hook and only write when it allows."""
import json
from pathlib import Path
import subprocess
import sys
hook, encoded, path, text = sys.argv[1:]
result = subprocess.run([sys.executable, hook], input=encoded, capture_output=True, text=True)
decision = json.loads(result.stdout) if result.stdout.strip() else {}
denied = result.returncode != 0 or decision.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
if not denied:
    Path(path).write_text(text, encoding="utf-8")
print(json.dumps({"allowed": not denied, "decision": decision, "stderr": result.stderr}))
