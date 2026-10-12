"""JSON-line subprocess entry point. Requests/secrets use stdin, never argv."""
import json
import mailbox
import sys
from pathlib import Path
from mime import parse_mail
from imap_reader import read_account


def emit(event):
    print(json.dumps(event, ensure_ascii=True), flush=True)
    # Keep only one parsed message in flight. The host acknowledges after its transaction commits.
    if event["type"] == "message" and sys.stdin.readline().strip() != "ack":
        raise RuntimeError("Email host disconnected before acknowledging a message.")


def import_mail(path, send=emit):
    if Path(path).suffix.lower() == ".eml":
        send({"type": "message", "record": parse_mail(Path(path).read_bytes())})
    elif Path(path).suffix.lower() == ".mbox":
        box = mailbox.mbox(path, create=False)
        try:
            for key in box.iterkeys():
                send({"type": "message", "record": parse_mail(box.get_bytes(key))})
        finally:
            box.close()
    else:
        raise ValueError("Unsupported email export; use .eml or .mbox.")


def main():
    request = json.loads(sys.stdin.readline())
    try:
        if request["action"] == "import":
            try:
                import_mail(request["path"])
            except Exception:
                raise RuntimeError("Could not parse the email export; earlier messages were kept and the file will be retried.") from None
        elif request["action"] in {"sync", "verify"}:
            read_account(request, emit)
        else:
            raise RuntimeError("Unknown email reader action.")
        emit({"type": "done"})
    except RuntimeError as error:
        emit({"type": "error", "message": str(error)})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
