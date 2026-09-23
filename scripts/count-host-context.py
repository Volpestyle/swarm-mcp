"""Count visible archived host request text; excludes billing and hidden framing."""
import json
import sys
from pathlib import Path
import tiktoken

encoding = tiktoken.get_encoding("o200k_base")


def measure(value):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return {"utf8Bytes": len(text.encode()), "tokens": len(encoding.encode(text, disallowed_special=()))}


reports = []
for name in sys.argv[1:]:
    data = json.loads(Path(name).read_text(encoding="utf-8-sig"))
    hosts = {"opencode": data["modelRequests"]}
    if data.get("mixedHost"):
        hosts["claude"] = [r["body"] for r in data["mixedHost"]["requests"]]
    reports.append({"capture": name, "hosts": {
        host: {"requests": len(requests), "perRequest": [
            {"messages": measure(r.get("messages", [])),
             "system": measure(r.get("system", "")),
             "tools": measure(r.get("tools", []))} for r in requests
        ]} for host, requests in hosts.items()
    }, "emittedToolCalls": len(data.get("toolCalls", [])) + len(data.get("mixedHost", {}).get("calls", [])),
       "explicitClaudeUserTurns": data.get("mixedHost", {}).get("userPromptInvocations", 0)})
print(json.dumps({"tokenizer": "tiktoken 0.12.0 / o200k_base", "runs": reports,
    "limitations": "Counts archived JSON with lease tokens redacted; not exact original-provider tokens. Repeated context counted per request; tools and system separate. No hidden framing, inference, caching adjustment or billing. Provider usage/cost fields in fixture host output are synthetic and must not be used as measurements."}, indent=2))
