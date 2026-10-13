"""Offline tests for the email sidecar. Run with python3 tests/fixtures/email-sidecar-tests.py."""
import email
import email.policy
import importlib
import mailbox
import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

SIDECAR = Path(__file__).resolve().parents[2] / "extensions" / "email" / "sidecar"
sys.path.insert(0, str(SIDECAR))
mime = importlib.import_module("mime")
imap_reader = importlib.import_module("imap_reader")
reader = importlib.import_module("reader")


def mail_bytes(headers=None, body="Hello"):
    msg = EmailMessage(policy=email.policy.SMTP)
    for name, value in (headers or {}).items():
        msg[name] = value
    if not msg.get("From"):
        msg["From"] = "Alice <alice@example.test>"
    if not msg.get("Date"):
        msg["Date"] = "Mon, 05 Jan 2026 10:00:00 +0000"
    if not msg.get("Message-ID"):
        msg["Message-ID"] = "<one@example.test>"
    if not msg.get("Subject"):
        msg["Subject"] = "A subject"
    msg.set_content(body)
    return msg.as_bytes()


class FakeIMAP:
    def __init__(self, uids=b"1 2 3", validity=b"42", fail_uid=None, login_status="OK"):
        self.uids = uids
        self.validity = validity
        self.fail_uid = fail_uid
        self.login_status = login_status
        self.calls = []
        self.selected = []
        self.logged_out = False

    def login(self, username, password):
        self.calls.append(("login", username, password))
        if self.login_status != "OK":
            raise RuntimeError(f"login failed for {password}")
        return "OK", [b"logged in"]

    def select(self, mailbox_name, readonly=False):
        self.selected.append((mailbox_name, readonly))
        self.calls.append(("select", mailbox_name, readonly))
        return "OK", [b"3"]

    def response(self, name):
        self.calls.append(("response", name))
        return name, [self.validity]

    def uid(self, command, *args):
        self.calls.append((command, *args))
        if command == "SEARCH":
            return "OK", [self.uids]
        if command == "FETCH":
            uid = int(args[0])
            if uid == self.fail_uid:
                return "NO", []
            raw = mail_bytes({"Message-ID": f"<{uid}@example.test>"})
            return "OK", [(f"1 (UID {uid} BODY[] {{123}})".encode(), raw), b")"]
        raise AssertionError(f"Unexpected IMAP command: {command}")

    def logout(self):
        self.logged_out = True
        self.calls.append(("logout",))
        return "BYE", [b"logout"]


class MimeTests(unittest.TestCase):
    def test_encoded_headers_references_and_reply_id(self):
        raw = mail_bytes({
            "From": "=?utf-8?b?Sm9zw6kgRXhhbXBsZQ==?= <jose@example.test>",
            "Subject": "=?utf-8?q?Re=3A_Caf=C3=A9?=",
            "Message-ID": "<reply@example.test>",
            "References": "<root@example.test> <parent@example.test>",
            "In-Reply-To": "<root@example.test>",
        })
        result = mime.parse_mail(raw)
        self.assertEqual(result["subject"], "Café")
        self.assertIn("José Example <jose@example.test>", result["message"]["authorName"])
        self.assertEqual(result["references"], ["<root@example.test>", "<parent@example.test>"])
        self.assertEqual(result["message"]["replyToId"], "<root@example.test>")

    def test_plain_alternative_wins_and_attachment_is_metadata_only(self):
        msg = EmailMessage(policy=email.policy.SMTP)
        msg["From"] = "Alice <alice@example.test>"
        msg["Date"] = "Mon, 05 Jan 2026 10:00:00 +0000"
        msg["Message-ID"] = "<multi@example.test>"
        msg["Subject"] = "Alternatives"
        msg.set_content("Plain version")
        msg.add_alternative("<html><body><p>HTML version</p></body></html>", subtype="html")
        msg.add_attachment(b"PRIVATE-ATTACHMENT-BYTES", maintype="application", subtype="octet-stream", filename="secret.bin")
        result = mime.parse_mail(msg.as_bytes())
        self.assertIn("Plain version", result["message"]["text"])
        self.assertNotIn("HTML version", result["message"]["text"])
        self.assertEqual(result["message"]["attachments"], [{"name": "secret.bin", "kind": "file", "text": "application/octet-stream"}])
        self.assertNotIn("PRIVATE-ATTACHMENT-BYTES", str(result))

    def test_html_only_strips_script_style_and_ignores_remote_resources(self):
        msg = EmailMessage(policy=email.policy.SMTP)
        msg["From"] = "alice@example.test"
        msg.set_content("<html><head><title>hidden</title><style>.x{}</style></head><body><p>Visible</p><script>BAD()</script><img src='https://invalid.test/pixel'></body></html>", subtype="html")
        text = mime.parse_mail(msg.as_bytes())["message"]["text"]
        self.assertIn("Visible", text)
        self.assertNotIn("hidden", text)
        self.assertNotIn("BAD", text)
        self.assertNotIn("invalid.test", text)

    def test_missing_message_id_and_date_are_deterministic(self):
        msg = EmailMessage(policy=email.policy.SMTP)
        msg["From"] = "alice@example.test"
        msg["Date"] = "bad date"
        msg.set_content("Body")
        raw = msg.as_bytes()
        first, second = mime.parse_mail(raw), mime.parse_mail(raw)
        self.assertEqual(first["message"]["messageId"], second["message"]["messageId"])
        self.assertTrue(first["message"]["messageId"].startswith("sha256:"))
        self.assertEqual(first["message"]["sentAt"], 0)


class IMAPTests(unittest.TestCase):
    def setUp(self):
        self.request = {"mailboxes": ["Folder Name\"é&"], "cursors": {}, "maxMessagesPerMailbox": 20}

    def test_mailbox_uses_modified_utf7_and_quoted_escaping(self):
        self.assertEqual(imap_reader.mailbox_arg('Folder "A" \\ café &'), '"Folder \\"A\\" \\\\ caf&AOk- &-"')
        fake = FakeIMAP()
        imap_reader.examine(fake, "Folder Name")
        self.assertEqual(fake.selected, [("\"Folder Name\"", True)])

    def test_readonly_peek_and_no_mutation_commands(self):
        fake = FakeIMAP(uids=b"1")
        events = []
        imap_reader.sync_mailbox(fake, "INBOX", self.request, events.append)
        self.assertEqual(fake.selected, [("\"INBOX\"", True)])
        self.assertIn(("FETCH", "1", "(UID BODY.PEEK[])"), fake.calls)
        self.assertFalse(any(call[0] in {"STORE", "CLOSE", "EXPUNGE", "COPY", "MOVE", "APPEND"} for call in fake.calls))

    def test_same_uidvalidity_reuses_cursor_and_changed_validity_resets(self):
        for validity, expected in ((b"42", [8, 9]), (b"43", [1, 2, 3, 8, 9])):
            with self.subTest(validity=validity):
                fake = FakeIMAP(uids=b"1 2 3 8 9", validity=validity)
                events = []
                request = {**self.request, "cursors": {"INBOX": {"uidValidity": "42", "uid": 7}}}
                imap_reader.sync_mailbox(fake, "INBOX", request, events.append)
                fetched = [int(c[1]) for c in fake.calls if c[0] == "FETCH"]
                self.assertEqual(fetched, expected)
                self.assertEqual(fake.calls[1][0], "response")

    def test_reversed_n_star_results_filter_saved_uid_and_cap_batch(self):
        fake = FakeIMAP(uids=b"9 8 7 5 6")
        events = []
        request = {**self.request, "maxMessagesPerMailbox": 2,
                   "cursors": {"INBOX": {"uidValidity": "42", "uid": 7}}}
        imap_reader.sync_mailbox(fake, "INBOX", request, events.append)
        self.assertEqual([int(c[1]) for c in fake.calls if c[0] == "FETCH"], [8, 9])
        self.assertEqual([e["uid"] for e in events if e["type"] == "message"], [8, 9])

    def test_newest_batch_first_reports_skipped_range_then_drains_gaps_newest_first(self):
        fake = FakeIMAP(uids=b"1 2 3 4 5 6 7 8 9")
        events = []
        request = {**self.request, "maxMessagesPerMailbox": 3, "cursors": {"INBOX": {"uidValidity": "42", "uid": 2}}}
        imap_reader.sync_mailbox(fake, "INBOX", request, events.append)
        messages = [e for e in events if e["type"] == "message"]
        self.assertEqual([e["uid"] for e in messages], [7, 8, 9])
        self.assertEqual(messages[0]["gapBelow"], 3)
        self.assertNotIn("gapBelow", messages[1])

        fake = FakeIMAP(uids=b"1 2 3 4 5 6 7 8 9")
        events = []
        request = {**self.request, "maxMessagesPerMailbox": 2,
                   "cursors": {"INBOX": {"uidValidity": "42", "uid": 9, "gaps": [[3, 6]]}}}
        imap_reader.sync_mailbox(fake, "INBOX", request, events.append)
        self.assertEqual([(e["uid"], e["gap"]) for e in events if e["type"] == "message"], [(6, 3), (5, 3)])
        self.assertFalse(any(e["type"] == "gap-done" for e in events))

        fake = FakeIMAP(uids=b"1 2 3 4 5 6 7 8 9")
        events = []
        request = {**self.request, "maxMessagesPerMailbox": 5,
                   "cursors": {"INBOX": {"uidValidity": "42", "uid": 9, "gaps": [[3, 4]]}}}
        imap_reader.sync_mailbox(fake, "INBOX", request, events.append)
        self.assertEqual([e["uid"] for e in events if e["type"] == "message"], [4, 3])
        self.assertIn({"type": "gap-done", "mailbox": "INBOX", "uidValidity": "42", "gap": 3}, events)

    def test_fetch_failure_keeps_prior_event_and_emits_no_later_messages(self):
        fake = FakeIMAP(uids=b"1 2 3", fail_uid=2)
        events = []
        with self.assertRaisesRegex(RuntimeError, "Message fetch failed"):
            imap_reader.sync_mailbox(fake, "INBOX", self.request, events.append)
        self.assertEqual([e["uid"] for e in events if e["type"] == "message"], [1])
        self.assertEqual([int(c[1]) for c in fake.calls if c[0] == "FETCH"], [1, 2])

    def test_verify_examines_mailbox_but_does_not_search_or_fetch(self):
        fake = FakeIMAP()
        events = []
        with patch.object(imap_reader.imaplib, "IMAP4_SSL", return_value=fake):
            imap_reader.read_account({"account": {"host": "mail.test", "port": 993, "username": "u", "password": "p"},
                                      "mailboxes": ["INBOX"], "action": "verify"}, events.append)
        self.assertTrue(fake.logged_out)
        self.assertFalse(any(call[0] == "SEARCH" or call[0] == "FETCH" for call in fake.calls))
        self.assertIn({"type": "verified"}, events)

    def test_tls_context_verifies_host_and_client_logs_out(self):
        fake = FakeIMAP()
        with patch.object(imap_reader.imaplib, "IMAP4_SSL", return_value=fake) as constructor:
            imap_reader.read_account({"account": {"host": "mail.test", "port": 993, "username": "u", "password": "secret"},
                                      "mailboxes": ["INBOX"], "action": "verify"}, lambda event: None)
        context = constructor.call_args.kwargs["ssl_context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, imap_reader.ssl.CERT_REQUIRED)
        self.assertTrue(fake.logged_out)

    def test_login_and_connection_errors_hide_secrets_and_server_text(self):
        bad = FakeIMAP(login_status="NO")
        with patch.object(imap_reader.imaplib, "IMAP4_SSL", return_value=bad):
            with self.assertRaises(RuntimeError) as caught:
                imap_reader.read_account({"account": {"host": "mail.test", "port": 993, "username": "u", "password": "SUPERSECRET"},
                                          "mailboxes": ["INBOX"], "action": "verify"}, lambda event: None)
        self.assertNotIn("SUPERSECRET", str(caught.exception))
        self.assertNotIn("mail.test", str(caught.exception))
        with patch.object(imap_reader.imaplib, "IMAP4_SSL", side_effect=OSError("mail.test SUPERSECRET detail")):
            with self.assertRaises(RuntimeError) as caught:
                imap_reader.read_account({"account": {"host": "mail.test", "port": 993, "username": "u", "password": "SUPERSECRET"},
                                          "mailboxes": ["INBOX"], "action": "verify"}, lambda event: None)
        self.assertNotIn("SUPERSECRET", str(caught.exception))
        self.assertNotIn("mail.test", str(caught.exception))

    def test_failed_gmail_signin_explains_app_passwords_without_exposing_credentials(self):
        bad = FakeIMAP(login_status="NO")
        with patch.object(imap_reader.imaplib, "IMAP4_SSL", return_value=bad):
            with self.assertRaises(RuntimeError) as caught:
                imap_reader.read_account({"account": {"host": "imap.gmail.com", "port": 993,
                                          "username": "private-address@gmail.com", "password": "SUPERSECRET"},
                                         "mailboxes": ["INBOX"], "action": "verify"}, lambda event: None)
        self.assertIn("https://myaccount.google.com/apppasswords", str(caught.exception))
        self.assertIn("2-Step Verification", str(caught.exception))
        self.assertNotIn("SUPERSECRET", str(caught.exception))
        self.assertNotIn("private-address", str(caught.exception))
        self.assertTrue(bad.logged_out)


class ImportTests(unittest.TestCase):
    def test_eml_and_mbox_import_are_local_and_emit_parsed_records(self):
        with tempfile.TemporaryDirectory() as directory:
            eml = Path(directory) / "one.eml"
            eml.write_bytes(mail_bytes())
            events = []
            reader.import_mail(str(eml), events.append)
            self.assertEqual(events[0]["record"]["message"]["messageId"], "<one@example.test>")

            box_path = Path(directory) / "archive.mbox"
            box = mailbox.mbox(str(box_path))
            box.add(mail_bytes({"Message-ID": "<mbox@example.test>"}))
            box.flush()
            box.close()
            events = []
            reader.import_mail(str(box_path), events.append)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["record"]["message"]["messageId"], "<mbox@example.test>")


if __name__ == "__main__":
    unittest.main(verbosity=2)
