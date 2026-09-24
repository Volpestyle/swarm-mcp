"""Fresh compact MCP token gate. Requires the same pinned tokenizer as captures."""
import json
import sys
from pathlib import Path
import importlib.metadata
import tiktoken

assert importlib.metadata.version("tiktoken") == "0.12.0", "Use tiktoken==0.12.0"
data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
encoding = tiktoken.get_encoding("o200k_base")
def tokens(value):
    return len(encoding.encode(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":")), disallowed_special=()))
def text_tokens(result):
    return sum(tokens(block["text"]) for block in result["content"] if block["type"] == "text")

catalog = tokens(data["toolSchema"])
instructions = tokens(data["instructions"])
assert data["count"] == 32 and len(data["toolSchema"]["tools"]) == 9
assert catalog + instructions <= 3000, f"Catalog/instructions exceed 3000 tokens: {catalog + instructions}"
sync = [call for call in data["transcript"] if call["name"] == "swarm_sync"]
assert len(sync) == 32 and max(text_tokens(call["result"]) for call in sync) <= 1000
assert data["toolCalls"] - len(sync) == 32 * 3, "Manual handoff call budget changed"
delta = data["deltaCheck"]
assert delta["unrelatedRenewals"] >= 40
assert not delta["result"].get("isError")
assert delta["result"]["structuredContent"]["data"]["items"] == [], "Unrelated events reached model sync"
assert delta["result"]["structuredContent"]["data"]["cursor"] > delta["before"], "Filtered cursor did not advance"
assert text_tokens(delta["result"]) <= 64, "Empty delta exceeds 64 tokens"
print(json.dumps({"catalogTokens": catalog, "instructionTokens": instructions,
                  "maxBootstrapTokens": max(text_tokens(call["result"]) for call in sync),
                  "unrelatedDeltaTokens": text_tokens(delta["result"])}))
