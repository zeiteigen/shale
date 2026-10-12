"""Offline JSON-line fixture for the TypeScript email orchestration tests."""
import json
import sys
from pathlib import Path

directory = Path(__file__).parent
request = json.loads(sys.stdin.readline())
if "account" in request:
    request["account"].pop("password", None)
(directory / "request.json").write_text(json.dumps(request))
plan = json.loads((directory / "plan.json").read_text())
for event in plan[request["action"]]:
    print(json.dumps(event), flush=True)
    if event["type"] == "message":
        if sys.stdin.readline().strip() != "ack":
            sys.exit(2)
sys.exit(plan.get("exit", 0))
