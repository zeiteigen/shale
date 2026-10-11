#!/usr/bin/env python3
"""Fetch recent Instagram DMs with instagrapi and print them as NDJSON for Shale.

Protocol (stdout, one JSON object per line):
  {"type": "thread", "thread": {...}, "messages": [...]}
  {"type": "error", "code": "challenge_required" | "login_required" | "two_factor_required" | "rate_limited" | "error", "message": "..."}
  {"type": "done", "threads": N}
stdin: JSON object {"since": {"<thread_id>": <last message epoch ms>}}.
Sync resumes the saved session; IG_USERNAME / IG_PASSWORD (optional) allow re-login when it expires.
Logs go to stderr. Exit codes: 0 ok, 2 needs human login, 3 rate limited, 1 other failure.

--auth: sign in for the Shale web interface. stdin line 1 is {"method": "password", "username", "password"}
        or {"method": "session", "sessionid"}; the sidecar may emit {"type": "need_code", "kind", "prompt"} and
        then reads {"code": "..."}; it ends with {"type": "ok", "account": {...}} or an error.
--check: emit {"type": "ok", "account": {...}} if the saved session still works.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from typing import Any


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        ChallengeRequired,
        FeedbackRequired,
        LoginRequired,
        PleaseWaitFewMinutes,
        TwoFactorRequired,
    )
except ImportError:  # pragma: no cover - reported to the host
    emit({"type": "error", "code": "missing_dependency",
          "message": "instagrapi is not installed for this interpreter. Run `bun run setup instagram` in the Shale folder."})
    sys.exit(1)


def ms(value: Any) -> int | None:
    if value is None:
        return None
    if hasattr(value, "timestamp"):
        return int(value.timestamp() * 1000)
    return int(value)


def new_client() -> Client:
    cl = Client()
    cl.delay_range = [1, 3]
    return cl


def save(cl: Client, session: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(session)), exist_ok=True)
    cl.dump_settings(session)
    os.chmod(session, 0o600)


def restore(session: str) -> Client:
    """Resume the saved session; re-login with stored credentials only if it expired."""
    username = os.environ.get("IG_USERNAME", "").strip()
    password = os.environ.get("IG_PASSWORD", "")
    cl = new_client()
    if not os.path.exists(session):
        if not (username and password):
            raise LoginRequired("No Instagram session. Connect Instagram on the Accounts page of the Shale web interface.")
        cl.login(username, password)
        save(cl, session)
        return cl
    cl.load_settings(session)
    try:
        cl.account_info()  # validates the restored session
    except LoginRequired:
        if not (username and password):
            raise LoginRequired("The Instagram session expired. Reconnect Instagram on the Accounts page.")
        log("Stored session expired; logging in again with the same device identity")
        uuids = cl.get_settings()["uuids"]
        cl.set_settings({})
        cl.set_uuids(uuids)
        cl.login(username, password)
    save(cl, session)
    return cl


def read_request() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Sign-in cancelled")
    value = json.loads(line)
    return value if isinstance(value, dict) else {}


def ask_code(kind: str, prompt: str) -> str:
    emit({"type": "need_code", "kind": kind, "prompt": prompt})
    code = str(read_request().get("code", "")).strip()
    if not code:
        raise RuntimeError("No code was entered")
    return code


def account(cl: Client) -> dict[str, Any]:
    info = cl.account_info()
    return {"pk": str(info.pk), "username": info.username, "full_name": getattr(info, "full_name", "") or ""}


def authenticate(session: str) -> None:
    """Interactive sign-in driven by the host over stdin/stdout JSON lines."""
    request = read_request()
    cl = new_client()
    cl.challenge_code_handler = lambda _username, choice: ask_code(
        "challenge", f"Instagram sent a security code ({getattr(choice, 'name', str(choice)).lower()}). Enter it to continue.")
    if request.get("method") == "session":
        cl.login_by_sessionid(str(request.get("sessionid", "")).strip())
    else:
        username, password = str(request.get("username", "")).strip(), str(request.get("password", ""))
        try:
            cl.login(username, password)
        except TwoFactorRequired:
            cl.login(username, password, verification_code=ask_code(
                "two_factor", "Enter the two-factor code from your authenticator app or SMS."))
    save(cl, session)
    emit({"type": "ok", "account": account(cl)})


def user_name(user: Any) -> str:
    return (getattr(user, "full_name", None) or getattr(user, "username", None) or str(getattr(user, "pk", "unknown"))).strip()


def attachments(msg: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    kind = getattr(msg, "item_type", None) or ""
    link = getattr(msg, "link", None)
    if isinstance(link, dict):
        context = link.get("link_context") or {}
        result.append({"kind": "link", "name": context.get("link_title") or context.get("link_url") or "link",
                       "url": context.get("link_url"), "text": context.get("link_summary")})
    for field in ("media_share", "clip", "felix_share", "story_share", "reel_share", "xma_share"):
        shared = getattr(msg, field, None)
        if not shared:
            continue
        caption = getattr(shared, "caption_text", None) or getattr(shared, "title", None)
        user = getattr(shared, "user", None)
        code = getattr(shared, "code", None)
        url = f"https://www.instagram.com/p/{code}/" if code else str(getattr(shared, "video_url", "") or "") or None
        result.append({"kind": "link", "name": f"post by {user_name(user)}" if user else field.replace("_", " "),
                       "url": url, "text": (caption or "")[:300] or None})
    media = getattr(msg, "media", None) or getattr(msg, "visual_media", None)
    if media is not None:
        media_type = getattr(media, "media_type", None)
        result.append({"kind": "video" if media_type == 2 else "image", "name": kind or "media"})
    if kind == "voice_media":
        result.append({"kind": "audio", "name": "voice message"})
    if kind == "animated_media":
        result.append({"kind": "image", "name": "GIF"})
    return result


def reactions(msg: Any) -> list[dict[str, Any]]:
    raw = getattr(msg, "reactions", None)
    if not isinstance(raw, dict):
        return []
    counts: dict[str, int] = {}
    for item in raw.get("emojis") or []:
        emoji = item.get("emoji") if isinstance(item, dict) else None
        if emoji:
            counts[emoji] = counts.get(emoji, 0) + 1
    likes = len(raw.get("likes") or [])
    if likes:
        counts["❤️"] = counts.get("❤️", 0) + likes
    return [{"emoji": emoji, "count": count} for emoji, count in counts.items()]


def message_record(msg: Any) -> dict[str, Any] | None:
    sent = ms(getattr(msg, "timestamp", None))
    if sent is None:
        return None
    kind = getattr(msg, "item_type", None) or ""
    reply = getattr(msg, "reply", None)
    return {
        "id": str(msg.id),
        "user_id": str(getattr(msg, "user_id", "") or ""),
        "timestamp": sent,
        "text": getattr(msg, "text", None) or "",
        "item_type": kind,
        "reply_to_id": str(reply.id) if reply is not None and getattr(reply, "id", None) else None,
        "attachments": attachments(msg),
        "reactions": reactions(msg),
        "is_system": kind in ("action_log", "video_call_event", "placeholder"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--max-threads", type=int, default=20)
    parser.add_argument("--max-messages", type=int, default=200)
    parser.add_argument("--auth", action="store_true", help="sign in, driven by JSON lines on stdin")
    parser.add_argument("--check", action="store_true", help="verify the saved session")
    args = parser.parse_args()

    try:
        if args.auth:
            authenticate(args.session)
            return 0
        cl = restore(args.session)
        if args.check:
            emit({"type": "ok", "account": account(cl)})
            return 0
        request = json.loads(sys.stdin.read() or "{}")
        since: dict[str, int] = request.get("since") or {}
        viewer = {"pk": str(cl.user_id), "name": user_name(cl.account_info())}
        threads = cl.direct_threads(amount=args.max_threads)
        done = 0
        for thread in threads:
            thread_id = str(thread.id)
            last_seen = int(since.get(thread_id, 0))
            last_activity = ms(getattr(thread, "last_activity_at", None))
            if last_seen and last_activity is not None and last_activity <= last_seen:
                continue
            time.sleep(random.uniform(2, 6))
            messages = cl.direct_messages(thread_id, amount=args.max_messages)
            records = [r for r in (message_record(m) for m in messages) if r and r["timestamp"] > last_seen]
            users = [{"pk": str(u.pk), "name": user_name(u), "username": getattr(u, "username", None)} for u in thread.users]
            emit({"type": "thread", "thread": {
                "id": thread_id, "title": getattr(thread, "thread_title", None) or "",
                "is_group": bool(getattr(thread, "is_group", False)), "users": users, "viewer": viewer,
            }, "messages": records})
            done += 1
        emit({"type": "done", "threads": done})
        return 0
    except (ChallengeRequired, TwoFactorRequired) as error:
        emit({"type": "error", "code": "challenge_required" if isinstance(error, ChallengeRequired) else "two_factor_required",
              "message": "Instagram requires verification. Reconnect Instagram on the Accounts page to enter the code."})
        return 2
    except LoginRequired as error:
        emit({"type": "error", "code": "login_required", "message": str(error)[:300]})
        return 2
    except (PleaseWaitFewMinutes, FeedbackRequired) as error:
        emit({"type": "error", "code": "rate_limited", "message": str(error)[:300]})
        return 3
    except Exception as error:  # noqa: BLE001 - every failure is reported to the host
        emit({"type": "error", "code": "error", "message": f"{type(error).__name__}: {str(error)[:300]}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
