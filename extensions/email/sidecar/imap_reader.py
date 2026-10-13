"""Passive IMAP: TLS, EXAMINE, UID SEARCH and BODY.PEEK; no mailbox mutations."""
import base64
import imaplib
import re
import ssl
from datetime import datetime, timedelta, timezone
from mime import parse_mail


def mailbox_arg(name):
    if not name or any(char in name for char in "\r\n\x00"):
        raise ValueError("Invalid mailbox name")
    # IMAP4rev1 mailbox names use modified UTF-7, including quoted spaces/backslashes.
    parts, non_ascii = [], []

    def flush():
        if non_ascii:
            encoded = base64.b64encode("".join(non_ascii).encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
            parts.append("&" + encoded + "-")
            non_ascii.clear()

    for char in name:
        if " " <= char <= "~":
            flush()
            parts.append("&-" if char == "&" else char)
        else:
            non_ascii.append(char)
    flush()
    return '"' + "".join(parts).replace("\\", "\\\\").replace('"', '\\"') + '"'


def examine(client, name):
    status, _ = client.select(mailbox_arg(name), readonly=True)
    if status != "OK":
        raise RuntimeError("Could not open mailbox read-only")
    _, values = client.response("UIDVALIDITY")
    validity = values[0].decode("ascii") if values and values[0] else ""
    if not validity.isdigit() or int(validity) < 1:
        raise RuntimeError("Mailbox did not supply a valid UIDVALIDITY")
    return validity


def since_criteria(days):
    date = datetime.now(timezone.utc) - timedelta(days=days)
    # IMAP date tokens use English month names independently of machine locale.
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return ["SINCE", f"{date.day:02d}-{months[date.month - 1]}-{date.year}"]


def search_uids(client, criteria):
    status, data = client.uid("SEARCH", None, *criteria)
    if status != "OK":
        raise RuntimeError("Mailbox search failed")
    return {int(uid) for uid in (data[0] or b"").split()}


def fetch_message(client, uid):
    status, fetched = client.uid("FETCH", str(uid), "(UID BODY.PEEK[])")
    if status != "OK":
        raise RuntimeError("Message fetch failed")
    for item in fetched:
        if isinstance(item, tuple) and isinstance(item[1], bytes):
            returned = re.search(rb"\bUID (\d+)\b", item[0])
            if returned and int(returned.group(1)) == uid:
                return item[1]
    raise RuntimeError("Message disappeared or had an invalid UID response; retry next sync")


def sync_mailbox(client, name, request, emit):
    """Newest mail first: UIDs above the head cursor are read before older gaps are backfilled.

    When more new mail exists than the per-run budget, only the newest batch is read and its first
    message carries gapBelow so the host records the skipped range as a gap. Gaps drain newest first."""
    validity = examine(client, name)
    emit({"type": "mailbox", "mailbox": name, "uidValidity": validity})
    saved = request.get("cursors", {}).get(name) or {}
    same = str(saved.get("uidValidity")) == validity
    after = int(saved.get("uid", 0)) if same else 0
    gaps = [(int(lo), int(hi)) for lo, hi in (saved.get("gaps") or [])] if same else []
    limit = int(request.get("maxMessagesPerMailbox", 200))
    if limit < 1:
        raise ValueError("maxMessagesPerMailbox must be positive")
    days = float(request.get("initialSyncDays", 0))
    bounded = after == 0 and days > 0
    criteria = ["UID", f"{after + 1}:*"] + (since_criteria(days) if bounded else [])
    # n:* includes the highest UID when n exceeds it. Filter that reversed-range result explicitly.
    uids = sorted(uid for uid in search_uids(client, criteria) if uid > after)
    batch = uids[-limit:]
    if len(batch) < len(uids):
        # A bounded first sync (initialSyncDays) never backfills below its window.
        gaps.append((uids[0] if bounded else after + 1, batch[0] - 1))
    for index, uid in enumerate(batch):
        event = {"type": "message", "mailbox": name, "uidValidity": validity, "uid": uid,
                 "record": parse_mail(fetch_message(client, uid))}
        if index == 0 and len(batch) < len(uids):
            event["gapBelow"] = uids[0] if bounded else after + 1
        emit(event)
    budget = limit - len(batch)
    for lo, hi in sorted(gaps, key=lambda gap: gap[1], reverse=True):
        if budget <= 0:
            break
        older = sorted((uid for uid in search_uids(client, ["UID", f"{lo}:{hi}"]) if lo <= uid <= hi), reverse=True) if hi >= lo else []
        for uid in older[:budget]:
            emit({"type": "message", "mailbox": name, "uidValidity": validity, "uid": uid, "gap": lo,
                  "record": parse_mail(fetch_message(client, uid))})
        if len(older) <= budget:
            emit({"type": "gap-done", "mailbox": name, "uidValidity": validity, "gap": lo})
        budget -= min(budget, len(older))


def read_account(request, emit):
    account = request["account"]
    try:
        client = imaplib.IMAP4_SSL(account["host"], int(account["port"]), ssl_context=ssl.create_default_context(), timeout=30)
    except Exception:
        raise RuntimeError("Could not establish a verified TLS connection to the IMAP server.") from None
    try:
        try:
            status, _ = client.login(account["username"], account["password"])
            if status != "OK":
                raise RuntimeError()
        except Exception:
            if account["host"].lower() in {"imap.gmail.com", "imap.googlemail.com"}:
                raise RuntimeError("Gmail sign-in failed. Use your full email address and a Google app password from https://myaccount.google.com/apppasswords with 2-Step Verification enabled. Your normal Google password and 2FA code cannot sign in here. If app passwords are unavailable, this connector requires local exports; Google OAuth is not implemented.") from None
            raise RuntimeError("IMAP sign-in failed. Check the username and password/app password; OAuth-only accounts need local exports.") from None
        for name in request["mailboxes"]:
            try:
                if request["action"] == "verify":
                    examine(client, name)
                else:
                    sync_mailbox(client, name, request, emit)
            except Exception:
                if request["action"] == "verify":
                    raise RuntimeError("Could not read a configured mailbox. Check the mailbox names and IMAP permissions.") from None
                emit({"type": "error", "mailbox": name, "message": f"Unable to finish mailbox {name}; its uncommitted messages will be retried."})
        if request["action"] == "verify":
            emit({"type": "verified"})
    finally:
        # No CLOSE/EXPUNGE/STORE: logout directly from the read-only selection.
        try:
            client.logout()
        except Exception:
            pass
