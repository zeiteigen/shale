"""Normalize MIME mail without loading remote resources or storing attachment payloads."""
import hashlib
import re
from datetime import timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head"}:
            self.hidden += 1
        if not self.hidden and tag in {"br", "p", "div", "li", "tr", "hr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "head"}:
            self.hidden = max(0, self.hidden - 1)
        if not self.hidden and tag in {"p", "div", "li", "tr"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def header(message, key):
    return re.sub(r"[\r\n]+\s*", " ", str(message.get(key, ""))).strip()


def message_ids(value):
    return re.findall(r"<[^<>\s]+>", value)


def parse_mail(raw):
    mail = BytesParser(policy=policy.default).parsebytes(raw)
    if not mail.get("From"):
        raise ValueError("Email has no From header")
    ids = message_ids(header(mail, "Message-ID"))
    message_id = ids[0] if ids else "sha256:" + hashlib.sha256(mail.as_bytes()).hexdigest()
    subject = header(mail, "Subject")
    thread_subject = re.sub(r"^(?:(?:re|fw|fwd)\s*:\s*)+", "", subject, flags=re.I).strip()
    senders = getaddresses([header(mail, "From")])
    name, address = senders[0] if senders else ("Unknown sender", "")
    author_name = f"{name} <{address}>" if name and address else (address or name or "Unknown sender")
    try:
        date = parsedate_to_datetime(header(mail, "Date"))
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        sent_at = int(date.timestamp() * 1000)
    except (ValueError, TypeError, OverflowError):
        # Deterministic fallback avoids changing identity/order every time a malformed export is retried.
        sent_at = 0
    body = mail.get_body(preferencelist=("plain", "html"))
    text = ""
    if body:
        try:
            text = body.get_content()
        except (LookupError, UnicodeError):
            text = (body.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
        if body.get_content_type() == "text/html":
            parser = PlainHTML()
            parser.feed(text)
            text = "".join(parser.parts)
    attachments = []
    for part in mail.walk():
        if part.get_filename() or part.get_content_disposition() == "attachment":
            content_type = part.get_content_type()
            kind = content_type.split("/", 1)[0]
            attachments.append({"name": part.get_filename() or "attachment", "kind": kind if kind in {"image", "video", "audio"} else "file",
                                "text": content_type})
    metadata = [f"Subject: {subject or '(No subject)'}", f"From: {author_name}"]
    for key in ("To", "Cc", "Bcc"):
        value = header(mail, key)
        if value:
            metadata.append(f"{key}: {value}")
    reply_ids = message_ids(header(mail, "In-Reply-To"))
    message = {"messageId": message_id, "authorId": address.casefold() if address else f"name:{author_name}",
               "authorName": author_name, "sentAt": sent_at, "text": "\n".join(metadata) + "\n\n" + text.replace("\r\n", "\n").strip(),
               "attachments": attachments}
    if reply_ids:
        message["replyToId"] = reply_ids[-1]
    return {"subject": thread_subject or "(No subject)", "references": message_ids(header(mail, "References")), "message": message}
