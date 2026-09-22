"""Count explicit MCP JSON/text with tiktoken==0.12.0; not provider billing."""
import json
import sys
from pathlib import Path
import tiktoken

encoding = tiktoken.get_encoding("o200k_base")

def serialized(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def tokens(value):
    return len(encoding.encode(value, disallowed_special=()))

rows = []
for name in sys.argv[1:]:
    path = Path(name)
    raw = path.read_bytes()
    content = raw.decode("utf-16") if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else raw.decode("utf-8-sig")
    data = json.loads(content)
    calls = data["transcript"]
    argument_tokens = sum(tokens(serialized({"name": call["name"], "arguments": call["arguments"]})) for call in calls)
    result_tokens = sum(tokens(block["text"]) for call in calls for block in call["result"]["content"] if block["type"] == "text")
    schema_tokens = tokens(serialized(data["toolSchema"]))
    instruction_tokens = tokens(data["instructions"]) if isinstance(data.get("instructions"), str) else None
    rows.append({"agents": data["count"], "calls": data["toolCalls"], "tools": len(data["toolSchema"]["tools"]), "schemaTokensPerAgent": schema_tokens, "argumentTokens": argument_tokens, "textResultTokens": result_tokens, "callsTokensTotal": argument_tokens + result_tokens, "withSchemaPerAgentTotal": argument_tokens + result_tokens + data["count"] * schema_tokens, "byTool": {name: {"calls": sum(call["name"] == name for call in calls), "textResultTokens": sum(tokens(block["text"]) for call in calls if call["name"] == name for block in call["result"]["content"] if block["type"] == "text")} for name in sorted({call["name"] for call in calls})}})
    rows[-1]["instructionsTokensPerAgent"] = instruction_tokens
    rows[-1]["catalogAndInstructionsTokensPerAgent"] = None if instruction_tokens is None else schema_tokens + instruction_tokens
print(json.dumps({"tokenizer": "tiktoken 0.12.0 / o200k_base", "measurement": "Explicit call name/arguments and text-result tokens. Schema JSON counted separately. Instruction counts are null when absent from historical captures. No hidden prompt framing, reasoning, caching adjustment or claim of a live model bill.", "runs": rows}, indent=2))
