"""
actions/common/notify.py

Shared helpers for sending step-by-step status messages to Telegram from
within a GitHub Action run, plus a live progress-bar updater for long
running steps (download / upload).

Design note: GitHub Actions can't push a truly continuous progress bar to
Telegram — there's no persistent process pushing frame-by-frame updates,
and editing a message every second would blow through Telegram's rate
limits. Instead, ProgressReporter edits a single message on a fixed
interval (default 10s): a good middle ground between "useful live status"
and "not spamming the API". For discrete milestones that aren't a running
transfer (started/downloaded/uploading/done/failed), the plain notify_*
functions below still send one message each, same as before.
"""

import json
import os
import time
import requests

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
WORKER_URL = os.getenv("WORKER_URL", "").rstrip("/")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET")


def _api_url(method):
    return f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}"


def record_history(user_id, source, file_name, file_size, link, storage_kind=None, used_personal_key=False):
    """
    Tells the Worker to add a completed job to the user's history in KV,
    and (if storage_kind is given) to record quota usage against the right
    bucket. Actions has no direct access to Cloudflare KV, so this is the
    bridge — a simple authenticated POST to a Worker endpoint that does the
    actual KV write (see worker/index.js handleHistoryAdd).

    storage_kind: "internal" | "external" | None. When "internal" and
    used_personal_key is True, the Worker skips quota accounting entirely
    (the user's own provider account was billed, not the admin's) — see
    worker/state/users.js recordUsage.

    Never raises: a failed history write shouldn't fail an otherwise
    successful job. Silently no-ops if WORKER_URL/INTERNAL_SECRET/user_id
    aren't configured (e.g. manual workflow_dispatch runs with no chat_id).
    """
    if not WORKER_URL or not INTERNAL_SECRET or not user_id:
        print("⚠️ WORKER_URL/INTERNAL_SECRET/user_id موجود نیست، تاریخچه ثبت نشد")
        return False

    try:
        resp = requests.post(
            f"{WORKER_URL}/internal/history-add",
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": INTERNAL_SECRET,
            },
            json={
                "userId": str(user_id),
                "source": source,
                "fileName": file_name,
                "fileSize": file_size,
                "link": link,
                "storageKind": storage_kind,
                "usedPersonalKey": bool(used_personal_key),
            },
            timeout=15,
        )
        if not resp.ok:
            print(f"⚠️ ثبت تاریخچه ناموفق: {resp.status_code} {resp.text}")
        return resp.ok
    except Exception as e:
        print(f"⚠️ خطا در ثبت تاریخچه: {e}")
        return False


def notify(chat_id, text, parse_mode=None, reply_markup=None):
    """Send a plain status message. Never raises — a failed notification
    should not crash the download/upload job itself. Returns the sent
    message_id on success, or None.

    reply_markup, if given, is a plain dict matching Telegram's inline
    keyboard shape (e.g. {"inline_keyboard": [[{"text": "...", "callback_data": "..."}]]}).
    Telegram's Bot API expects it JSON-encoded even when the rest of the
    request is form-encoded, so it's serialised separately here.
    """
    if not TELEGRAM_TOKEN or not chat_id:
        print(f"⚠️ توکن یا chat_id موجود نیست، پیام ارسال نشد:\n{text}")
        return None

    payload = {"chat_id": chat_id, "text": text}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)

    try:
        resp = requests.post(_api_url("sendMessage"), data=payload, timeout=15)
        data = resp.json() if resp.ok else {}
        ok = resp.ok and data.get("ok", False)
        if not ok:
            print(f"❌ ارسال پیام تلگرام ناموفق: {resp.text}")
            return None
        return data["result"]["message_id"]
    except Exception as e:
        print(f"❌ خطا در ارسال پیام تلگرام: {e}")
        return None


# A single "back to main menu" button, appended to terminal messages
# (success/failure) so the user always has a way back into the bot without
# retyping /start — matches worker/telegram/menus.js backToMenuKeyboard().
# The callback_data ("menu_main") is handled entirely by the Worker; this
# script never needs to know what it does, just that it exists.
BACK_TO_MENU_MARKUP = {"inline_keyboard": [[{"text": "🔙 بازگشت به منو", "callback_data": "menu_main"}]]}


def edit_message(chat_id, message_id, text):
    """Edit an existing message. Silently ignores 'message is not modified'
    errors (Telegram rejects no-op edits) and any other failure — a missed
    progress tick should never crash the job."""
    if not TELEGRAM_TOKEN or not chat_id or not message_id:
        return False

    payload = {"chat_id": chat_id, "message_id": message_id, "text": text}

    try:
        resp = requests.post(_api_url("editMessageText"), data=payload, timeout=15)
        if resp.ok:
            return True
        # "message is not modified" happens when the text is identical to
        # last tick (e.g. transfer briefly stalled at the same byte count) —
        # not a real error, just nothing to do.
        if "message is not modified" not in resp.text:
            print(f"⚠️ ادیت پیام ناموفق: {resp.text}")
        return False
    except Exception as e:
        print(f"⚠️ خطا در ادیت پیام: {e}")
        return False


def notify_started(chat_id, what):
    notify(chat_id, f"⏳ شروع شد: {what}")


def notify_downloaded(chat_id, size_label=None):
    text = "📥 دانلود کامل شد."
    if size_label:
        text += f"\n📦 حجم: {size_label}"
    notify(chat_id, text)


def notify_uploading(chat_id):
    notify(chat_id, "☁️ در حال آپلود...")


def notify_done(chat_id, message, link=None):
    text = f"✅ {message}"
    if link:
        text += f"\n\n🔗 {link}"

    reply_markup = BACK_TO_MENU_MARKUP
    if link:
        # Native Telegram "copy to clipboard" button (Bot API copy_text,
        # added 7.x) — copies the link with one tap, no need to long-press
        # select the URL text manually. Telegram caps copy_text.text at
        # 256 characters; a link should never come close to that, but the
        # cap is enforced defensively rather than trusting it blindly.
        copy_row = [{"text": "📋 کپی لینک", "copy_text": {"text": link[:256]}}]
        reply_markup = {"inline_keyboard": copy_row_and_menu(copy_row)}

    notify(chat_id, text, reply_markup=reply_markup)


def copy_row_and_menu(copy_row):
    """Prepends a copy-link row to the standard back-to-menu keyboard,
    without mutating BACK_TO_MENU_MARKUP itself (shared/reused elsewhere)."""
    return [copy_row] + [row[:] for row in BACK_TO_MENU_MARKUP["inline_keyboard"]]


def notify_failed(chat_id, reason):
    notify(chat_id, f"❌ خطا: {reason}", reply_markup=BACK_TO_MENU_MARKUP)


# Shown specifically when an internal-provider (ArvanCloud etc.) upload
# fails — matches worker/telegram/menus.js storageFailureKeyboard(). The
# Worker's handleStorageFailureChoice reads the retry payload back off the
# active-job record (set at dispatch time), so this script doesn't need to
# resend any job parameters here — just show the choice.
STORAGE_FAILURE_MARKUP = {
    "inline_keyboard": [
        [{"text": "🔁 تلاش مجدد (داخلی)", "callback_data": "storage_fail_retry"}],
        [{"text": "☁️ آپلود به GitHub", "callback_data": "storage_fail_fallback_github"}],
        [{"text": "❌ لغو", "callback_data": "storage_fail_cancel"}],
    ]
}


def notify_storage_failed(chat_id, provider_label, reason, message_id=None):
    """
    Reports an internal-storage upload failure and offers retry / fall back
    to GitHub / cancel. If message_id is given (the existing progress
    message), edits it in place rather than sending a new message — keeps
    the chat from accumulating a separate message per retry attempt.
    """
    text = f"❌ آپلود به {provider_label} ناموفق بود.\n{reason}\n\nچیکار کنیم؟"
    if message_id:
        # edit_message doesn't support reply_markup (it's used for the
        # plain progress-tick path where no keyboard is needed) — for this
        # one case we need the keyboard attached, so call the API directly
        # rather than extending edit_message's signature for a single caller.
        if not TELEGRAM_TOKEN or not chat_id:
            print(f"⚠️ توکن یا chat_id موجود نیست، پیام ارسال نشد:\n{text}")
            return None
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "reply_markup": json.dumps(STORAGE_FAILURE_MARKUP, ensure_ascii=False),
        }
        try:
            resp = requests.post(_api_url("editMessageText"), data=payload, timeout=15)
            if not resp.ok and "message is not modified" not in resp.text:
                print(f"⚠️ ادیت پیام خطای آپلود ناموفق: {resp.text}")
            return message_id
        except Exception as e:
            print(f"⚠️ خطا در ادیت پیام خطای آپلود: {e}")
            return None

    return notify(chat_id, text, reply_markup=STORAGE_FAILURE_MARKUP)


def format_bytes(num_bytes):
    """Human-readable size, e.g. 1536000 -> '1.5 MB'."""
    if num_bytes is None:
        return None
    step = 1024.0
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if num_bytes < step:
            return f"{num_bytes:.1f} {unit}" if unit != "B" else f"{int(num_bytes)} {unit}"
        num_bytes /= step
    return f"{num_bytes:.1f} PB"


def format_duration(seconds):
    """e.g. 125 -> '2:05'"""
    seconds = max(0, int(seconds))
    minutes, secs = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def render_bar(fraction, width=12):
    """e.g. 0.4 -> '▓▓▓▓▓░░░░░░░'"""
    fraction = max(0.0, min(1.0, fraction))
    filled = round(width * fraction)
    return "▓" * filled + "░" * (width - filled)


class ProgressReporter:
    """
    Polls a "how many bytes so far" callback on a fixed interval and edits
    one Telegram message with a progress bar, percentage, speed and ETA.

    Used for the download step, where we can cheaply read the growing file
    size off disk. Not a generic subprocess-log parser — deliberately
    simple and independent of any particular tool's output format, so it
    keeps working even if tdl's CLI output changes between versions.

    Usage:
        reporter = ProgressReporter(chat_id, label="در حال دانلود", total_bytes=total)
        reporter.start()
        ... (long-running operation happens in a loop that calls reporter.tick(current_bytes)) ...
        reporter.stop()
    """

    def __init__(self, chat_id, label, total_bytes=None, interval_seconds=10):
        self.chat_id = chat_id
        self.label = label
        self.total_bytes = total_bytes
        self.interval_seconds = interval_seconds
        self.message_id = None
        self.start_time = None
        self.last_edit_time = 0
        self.last_bytes = 0
        self.last_bytes_time = None

    def start(self):
        self.start_time = time.monotonic()
        self.last_bytes_time = self.start_time
        self.message_id = notify(self.chat_id, f"⏳ {self.label}...")
        return self.message_id

    def tick(self, current_bytes, force=False):
        """Call this periodically (e.g. every couple seconds from a polling
        loop) with the current byte count. Only actually edits the Telegram
        message once `interval_seconds` has passed since the last edit,
        unless force=True."""
        now = time.monotonic()
        if not force and (now - self.last_edit_time) < self.interval_seconds:
            return

        elapsed_since_last = now - self.last_bytes_time
        bytes_since_last = current_bytes - self.last_bytes
        speed = bytes_since_last / elapsed_since_last if elapsed_since_last > 0 else 0

        self.last_bytes = current_bytes
        self.last_bytes_time = now
        self.last_edit_time = now

        text = self._render(current_bytes, speed)
        if self.message_id:
            edit_message(self.chat_id, self.message_id, text)
        else:
            self.message_id = notify(self.chat_id, text)

    def _render(self, current_bytes, speed):
        lines = [f"⏳ {self.label}..."]

        if self.total_bytes:
            fraction = current_bytes / self.total_bytes if self.total_bytes else 0
            percent = round(fraction * 100)
            lines.append(f"{render_bar(fraction)} {percent}%")
            lines.append(f"📦 {format_bytes(current_bytes)} / {format_bytes(self.total_bytes)}")
            if speed > 0:
                remaining_bytes = max(0, self.total_bytes - current_bytes)
                eta = remaining_bytes / speed
                lines.append(f"🚀 {format_bytes(speed)}/s — ⏱ باقی‌مانده: {format_duration(eta)}")
        else:
            # No known total (e.g. size wasn't reported ahead of time) —
            # still useful to show bytes moved and speed.
            lines.append(f"📦 {format_bytes(current_bytes)} دانلود شده")
            if speed > 0:
                lines.append(f"🚀 {format_bytes(speed)}/s")

        elapsed = time.monotonic() - self.start_time
        lines.append(f"⏱ زمان سپری‌شده: {format_duration(elapsed)}")

        return "\n".join(lines)

    def stop(self, final_text=None):
        """Send a final edit (e.g. 100%) or just leave the last tick as-is."""
        if final_text and self.message_id:
            edit_message(self.chat_id, self.message_id, final_text)


class HeartbeatReporter:
    """
    For steps where we *can't* measure real progress (e.g. `gh release
    create` uploading — no accessible byte counter), this sends a periodic
    "still working" message instead of a fake progress bar. The goal is
    purely to reassure the user the job hasn't silently died.

    If total_bytes is known (e.g. the file size after a completed
    download), we show a one-time rough ETA computed from an assumed
    average upload speed — not a measured speed, since we have none. This
    is intentionally just a ballpark shown once at start, not re-estimated
    every tick (re-estimating with no real signal would just make the
    number jump around meaninglessly).

    Usage:
        hb = HeartbeatReporter(chat_id, label="در حال آپلود", total_bytes=file_size, interval_seconds=10, warn_after_seconds=300)
        hb.start()
        ... call hb.tick() periodically from a polling loop ...
        hb.stop()
    """

    # Conservative assumed average upload speed used only to print a rough
    # one-time ETA. GitHub Actions runners typically have generous
    # bandwidth, but this stays modest on purpose — better to under-promise
    # than to show a wildly optimistic countdown that keeps missing.
    ASSUMED_UPLOAD_SPEED_BYTES_PER_SEC = 5 * 1024 * 1024  # 5 MB/s

    def __init__(self, chat_id, label, total_bytes=None, interval_seconds=10, warn_after_seconds=300):
        self.chat_id = chat_id
        self.label = label
        self.total_bytes = total_bytes
        self.interval_seconds = interval_seconds
        self.warn_after_seconds = warn_after_seconds
        self.message_id = None
        self.start_time = None
        self.last_edit_time = 0

    def start(self):
        self.start_time = time.monotonic()
        self.message_id = notify(self.chat_id, self._render(0))
        return self.message_id

    def tick(self, force=False):
        now = time.monotonic()
        if not force and (now - self.last_edit_time) < self.interval_seconds:
            return
        self.last_edit_time = now

        elapsed = now - self.start_time
        text = self._render(elapsed)

        if self.message_id:
            edit_message(self.chat_id, self.message_id, text)
        else:
            self.message_id = notify(self.chat_id, text)

    def _render(self, elapsed):
        lines = [f"☁️ {self.label}...", f"⏱ زمان سپری‌شده: {format_duration(elapsed)}"]

        if self.total_bytes:
            estimated_total = self.total_bytes / self.ASSUMED_UPLOAD_SPEED_BYTES_PER_SEC
            remaining = max(0, estimated_total - elapsed)
            lines.append(f"⏳ تخمین باقی‌مانده: حدود {format_duration(remaining)}")

        if elapsed > self.warn_after_seconds:
            lines.append("")
            lines.append("⚠️ این مرحله بیشتر از حد معمول طول کشیده. همچنان در حال تلاشه، لطفاً صبر کنید.")

        return "\n".join(lines)

    def stop(self, final_text=None):
        if final_text and self.message_id:
            edit_message(self.chat_id, self.message_id, final_text)
