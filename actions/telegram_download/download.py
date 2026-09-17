"""
actions/telegram_download/download.py

Downloads a public Telegram message's media via `tdl`, optionally
renames/zips it, uploads the file as a GitHub Release asset, and reports
progress/status to the user via actions/common/notify.py.

Two stages here (`run_download`, `run_upload`) actually *launch* the
external command themselves (instead of the workflow YAML calling `tdl`/`gh`
directly), because they need to poll alongside the running process to
report live progress:
  - run_download: launches `tdl dl` in the background, polls the growing
    file size on disk every couple seconds, and edits a single Telegram
    message on a 20s interval with percent/speed/ETA (ProgressReporter).
  - run_upload: launches `gh release create` in the background. There's no
    reliable byte-level progress signal for this step, so instead of a fake
    bar we send a periodic "still working" heartbeat (HeartbeatReporter) —
    the goal is just to reassure the user it hasn't silently died.

The other stages (started/downloaded/process/done/failed) are simple
one-shot notifications, same as before.
"""

import asyncio
import os
import shutil
import subprocess
import sys
import time
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "common"))
from notify import (  # noqa: E402
    notify_started,
    notify_downloaded,
    notify_done,
    notify_failed,
    notify_storage_failed,
    format_bytes,
    record_history,
    ProgressReporter,
    HeartbeatReporter,
)
from storage_upload import upload_to_s3_compatible, StorageUploadError  # noqa: E402

TELEGRAM_URL = os.getenv("TELEGRAM_URL", "").strip()
# Fallback path for forwards with no public t.me link (see
# worker/telegram/handlers.js handleForwardedMessage): fetch this exact
# message straight from the bot's own chat with the user, over MTProto,
# logged in as the bot itself (see _run_bot_mtproto_download). Empty
# unless this path is in use.
PRIVATE_CHAT_ID = os.getenv("PRIVATE_CHAT_ID", "").strip()
PRIVATE_MESSAGE_ID = os.getenv("PRIVATE_MESSAGE_ID", "").strip()
# Needed only for the private-chat fallback below (_run_bot_mtproto_download):
# logging into Telegram over MTProto *as the bot itself*, instead of via a
# separate personal-account tdl session. TELEGRAM_API_ID/HASH come from
# https://my.telegram.org (any personal account, one-time, free) and are
# just app credentials — they don't log in as that personal account here.
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "").strip()
TELEGRAM_API_ID = os.getenv("TELEGRAM_API_ID", "").strip()
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "").strip()
CHAT_ID = os.getenv("CHAT_ID", "").strip()
STAGE = os.getenv("STAGE", "").strip()  # set by the workflow step calling us
FILE_PATH = os.getenv("FILE_PATH", "").strip()
DIRECT_URL = os.getenv("DIRECT_URL", "").strip()
FAIL_REASON = os.getenv("FAIL_REASON", "").strip()
CUSTOM_NAME = os.getenv("CUSTOM_NAME", "").strip()
ZIP = os.getenv("ZIP", "").strip().lower() in ("1", "true", "yes")
# When the Worker already knows the file's size (e.g. from a forwarded
# message's media metadata), it's passed through so run_download can show a
# real percentage/ETA instead of just bytes-moved. Empty/invalid values just
# mean "unknown", same as before this existed.
_expected_size_raw = os.getenv("EXPECTED_SIZE", "").strip()
EXPECTED_SIZE = int(_expected_size_raw) if _expected_size_raw.isdigit() else None

# For run_download / run_upload:
DOWNLOAD_DIR = os.getenv("DOWNLOAD_DIR", "").strip()
TDL_NAMESPACE = os.getenv("TDL_NAMESPACE", "quickstart").strip()
TDL_STORAGE = os.getenv("TDL_STORAGE", "").strip()
RELEASE_TAG = os.getenv("RELEASE_TAG", "").strip()
RELEASE_TITLE = os.getenv("RELEASE_TITLE", "").strip()
RELEASE_NOTES = os.getenv("RELEASE_NOTES", "").strip()
GITHUB_REPOSITORY = os.getenv("GITHUB_REPOSITORY", "").strip()
POLL_SECONDS = 2  # how often we check bytes-on-disk / process liveness
EDIT_INTERVAL_SECONDS = 20  # how often we actually edit the Telegram message

# Internal-storage (ArvanCloud etc) fields — see worker/telegram/handlers.js
# startJob() for how these are populated from client_payload. Empty strings
# (not missing) when storage_target is "external".
STORAGE_TARGET = os.getenv("STORAGE_TARGET", "external").strip() or "external"
STORAGE_PROVIDER = os.getenv("STORAGE_PROVIDER", "").strip()
STORAGE_ACCESS_KEY = os.getenv("STORAGE_ACCESS_KEY", "").strip()
STORAGE_SECRET_KEY = os.getenv("STORAGE_SECRET_KEY", "").strip()
STORAGE_ENDPOINT = os.getenv("STORAGE_ENDPOINT", "").strip()
STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "").strip()
STORAGE_USING_PERSONAL_KEY = os.getenv("STORAGE_USING_PERSONAL_KEY", "").strip() in ("1", "true", "yes")
PROGRESS_MESSAGE_ID = os.getenv("PROGRESS_MESSAGE_ID", "").strip()

# Mirrors worker/state/storageProviders.js defaults — see the identical
# comment in actions/direct_url_download/download.py for why this is a
# small local mirror rather than a shared import.
PROVIDER_DEFAULTS = {
    "arvan": {
        "endpoint": "https://s3.ir-thr-at1.arvanstorage.ir",
        "bucket": "my-files-telegram",
        "label": "آروان‌کلاد",
    },
}


def _write_output(key, value):
    github_output = os.getenv("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"{key}={value}\n")


def stage_started():
    source_label = TELEGRAM_URL or f"پیام فوروارد‌شده (چت {PRIVATE_CHAT_ID}, پیام {PRIVATE_MESSAGE_ID})"
    notify_started(CHAT_ID, f"دانلود پیام تلگرام\n{source_label}")


def stage_downloaded():
    size_label = None
    if FILE_PATH and os.path.isfile(FILE_PATH):
        size_label = format_bytes(os.path.getsize(FILE_PATH))
    notify_downloaded(CHAT_ID, size_label)


def stage_done():
    notify_done(CHAT_ID, "دانلود با موفقیت انجام شد!", link=DIRECT_URL)

    file_name = os.path.basename(FILE_PATH) if FILE_PATH else None
    file_size = os.path.getsize(FILE_PATH) if FILE_PATH and os.path.isfile(FILE_PATH) else None
    storage_kind = "internal" if STORAGE_TARGET == "internal" else "external"
    record_history(CHAT_ID, "telegram", file_name, file_size, DIRECT_URL, storage_kind, STORAGE_USING_PERSONAL_KEY)


def stage_failed():
    notify_failed(CHAT_ID, FAIL_REASON or "دانلود تلگرام ناموفق بود. لاگ Actions را بررسی کنید.")


def stage_process():
    """
    Applies the optional rename/zip options to the downloaded file, in place.
    Writes the final path to $GITHUB_OUTPUT as `final_path` so the workflow's
    "Create GitHub Release" step can pick it up without guessing.

    This does not touch Telegram at all — it's pure file handling, called
    between the "downloaded" and "uploading" notifications.
    """
    if not FILE_PATH or not os.path.isfile(FILE_PATH):
        print(f"❌ فایل موجود نیست: '{FILE_PATH}'")
        sys.exit(1)

    final_path = FILE_PATH

    if CUSTOM_NAME:
        directory = os.path.dirname(final_path)
        ext = os.path.splitext(final_path)[1]  # keep original extension
        safe_name = "".join(c for c in CUSTOM_NAME if c not in '/\\:*?"<>|').strip()
        if safe_name:
            renamed_path = os.path.join(directory, f"{safe_name}{ext}")
            shutil.move(final_path, renamed_path)
            final_path = renamed_path
            print(f"✏️ تغییر نام به: {final_path}")

    if ZIP:
        zip_path = f"{final_path}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(final_path, arcname=os.path.basename(final_path))
        print(f"📦 فشرده‌سازی شد: {zip_path}")
        final_path = zip_path

    _write_output("final_path", final_path)
    print(f"✅ فایل نهایی: {final_path}")


def _dir_size(path):
    """Total bytes of all files under `path` (tdl may write partial/temp
    files alongside the final one while downloading)."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass  # file may have been renamed/removed between listing and stat
    return total


def stage_run_download():
    """
    For a public/private-group t.me link: launches `tdl dl` in the
    background and polls the download directory's growing size to drive
    a live ProgressReporter. For the no-public-link fallback (forward
    from a user, a group, or hidden by privacy settings): fetches the
    message directly over MTProto, logged in as the bot itself — see
    _run_bot_mtproto_download for why. If the Worker already told us the
    expected file size (EXPECTED_SIZE — populated from a forwarded
    message's media metadata, see worker/telegram/handlers.js), we show a
    real percentage/ETA; otherwise we fall back to bytes-moved and speed
    only, still a clear "it's alive and moving" signal.
    """
    if not DOWNLOAD_DIR:
        print("❌ DOWNLOAD_DIR موجود نیست")
        sys.exit(1)

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    if PRIVATE_CHAT_ID and PRIVATE_MESSAGE_ID:
        ok = _run_bot_mtproto_download()
    elif TELEGRAM_URL:
        ok = _run_url_download()
    else:
        print("❌ نه TELEGRAM_URL و نه PRIVATE_CHAT_ID/PRIVATE_MESSAGE_ID موجوده")
        sys.exit(1)

    if not ok:
        sys.exit(1)


def _run_url_download():
    """The normal path: a public (or private-group) t.me message link."""
    cmd = [
        "tdl", "dl",
        "-n", TDL_NAMESPACE,
        "--storage", TDL_STORAGE,
        "-d", DOWNLOAD_DIR,
        "-u", TELEGRAM_URL,
        # Default template is "{{.DialogID}}_{{.MessageID}}_{{filenamify .FileName}}",
        # which produces ugly names like "2529543967_1269_video.mp4". We only
        # want the original filename on disk — no chat/message id prefix.
        "--template", "{{ filenamify .FileName }}",
    ]
    log_path = os.path.join(DOWNLOAD_DIR, "..", "tdl-download.log")
    return _run_tdl_download_with_progress(cmd, log_path)


def _run_bot_mtproto_download():
    """
    The fallback path for forwards with no public link (from a user, a
    group, or hidden by the sender's privacy settings — anything
    worker/telegram/forward.js couldn't build a t.me link for).

    Why the old `tdl chat export -c <chat_id>` approach here always found
    nothing (see handoff-forward-issue.md): `tdl` connects over MTProto as
    a *separate personal Telegram account* (TDL_SESSION). PRIVATE_CHAT_ID
    is the Bot API's id for this chat, which for a private bot<->user chat
    is just the human's own numeric user id — that id does not identify
    "the conversation with the bot" from the personal account's own point
    of view (if it resolves to anything there, it's that account's own
    Saved Messages). And even given the right chat, Telegram assigns
    message ids for private/basic-group chats from a counter that is
    scoped *per account*, not per conversation — so the id the Bot API
    reports for this message is simply a different number than the same
    message has in the personal account's own numbering. Neither piece
    can be bridged from outside; that's why `tdl chat export` kept
    finishing with exit code 0 but an empty/media-less result.

    Fix: don't use a separate account at all. Connect over MTProto *as
    the bot itself* (bot_token login, no personal account involved). That
    is the exact identity the Bot API webhook already talks to, so
    PRIVATE_CHAT_ID/PRIVATE_MESSAGE_ID from the webhook are valid as-is —
    the bot received this exact message in this exact chat, so it can
    always look it up directly. As a bonus, MTProto has no ~20MB download
    ceiling — that limit belongs only to the api.telegram.org Bot API
    HTTP bridge — so this also lifts the old size limit on this path.

    Requires TELEGRAM_API_ID/TELEGRAM_API_HASH (free, one-time, from
    https://my.telegram.org — any personal account can generate these,
    they're just app credentials, not a login) in addition to the
    existing TELEGRAM_TOKEN. Uses Kurigram (`pip install kurigram
    tgcrypto`), an actively maintained drop-in fork of Pyrogram — same
    `from pyrogram import ...` API.
    """
    if not (TELEGRAM_API_ID and TELEGRAM_API_HASH and TELEGRAM_TOKEN):
        print("❌ TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_TOKEN موجود نیست")
        if CHAT_ID:
            from notify import notify_failed
            notify_failed(CHAT_ID, "تنظیمات لازم برای دانلود این نوع فوروارد کامل نیست (TELEGRAM_API_ID/HASH).")
        return False

    try:
        chat_id = int(PRIVATE_CHAT_ID)
        message_id = int(PRIVATE_MESSAGE_ID)
    except ValueError:
        print(f"❌ chat_id/message_id نامعتبر: '{PRIVATE_CHAT_ID}' / '{PRIVATE_MESSAGE_ID}'")
        return False

    print(f"در حال دریافت پیام {message_id} از چت {chat_id} به‌عنوان خود ربات (MTProto)...")

    reporter = (
        ProgressReporter(CHAT_ID, label="در حال دانلود از تلگرام", total_bytes=EXPECTED_SIZE)
        if CHAT_ID
        else None
    )

    def on_progress(current, _total):
        # Pyrogram/Kurigram calls this off the event loop for sync
        # callbacks, so the blocking notify.py HTTP calls inside tick()
        # are fine here — this is the only thing running at the time.
        if reporter:
            reporter.tick(current)

    async def _do_download():
        from pyrogram import Client  # Kurigram ships as the `pyrogram` package

        app = Client(
            "bot_dl",
            api_id=int(TELEGRAM_API_ID),
            api_hash=TELEGRAM_API_HASH,
            bot_token=TELEGRAM_TOKEN,
            in_memory=True,  # bot-token login needs no persisted session file
        )
        async with app:
            msg = await app.get_messages(chat_id, message_id)
            if not msg or getattr(msg, "empty", False) or not msg.media:
                print(f"❌ پیام {message_id} در چت {chat_id} رسانه‌ای نداشت یا در دسترس نبود")
                return None
            return await app.download_media(
                msg,
                file_name=DOWNLOAD_DIR + os.sep,
                progress=on_progress,
            )

    if reporter:
        reporter.start()

    try:
        result_path = asyncio.run(_do_download())
    except Exception as e:
        print(f"❌ خطا در دانلود مستقیم MTProto: {e}")
        result_path = None

    if not result_path or not os.path.isfile(result_path):
        if reporter:
            reporter.stop("❌ دانلود ناموفق بود.")
        print("❌ فایلی دانلود نشد.")
        return False

    final_bytes = os.path.getsize(result_path)
    if reporter:
        reporter.stop(f"✅ دانلود کامل شد.\n📦 حجم: {format_bytes(final_bytes)}")
    print(f"✅ دانلود کامل شد ({format_bytes(final_bytes)})")
    return True


def _run_tdl_download_with_progress(cmd, log_path):
    """Shared "launch tdl dl in the background, poll disk size, drive
    ProgressReporter" logic used by both download paths above. Returns True
    on success, False on failure (after already notifying/logging)."""
    log_file = open(log_path, "w")
    process = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

    reporter = (
        ProgressReporter(CHAT_ID, label="در حال دانلود از تلگرام", total_bytes=EXPECTED_SIZE)
        if CHAT_ID
        else None
    )
    if reporter:
        reporter.start()

    while True:
        return_code = process.poll()
        current_bytes = _dir_size(DOWNLOAD_DIR)

        if reporter:
            reporter.tick(current_bytes)

        if return_code is not None:
            break

        time.sleep(POLL_SECONDS)

    log_file.close()

    if return_code != 0:
        print(f"❌ tdl dl با کد خطای {return_code} تمام شد. لاگ:")
        with open(log_path) as f:
            print(f.read()[-4000:])  # tail, in case the log is huge
        if reporter:
            reporter.stop("❌ دانلود ناموفق بود.")
        return False

    final_bytes = _dir_size(DOWNLOAD_DIR)
    if reporter:
        reporter.stop(f"✅ دانلود کامل شد.\n📦 حجم: {format_bytes(final_bytes)}")

    print(f"✅ دانلود کامل شد ({format_bytes(final_bytes)})")
    return True


def stage_run_upload():
    """
    Launches `gh release create` in the background. Unlike the download
    step, there's no byte counter we can poll for real progress (the
    upload happens inside gh's own process, and partial-upload size isn't
    exposed anywhere we can read from outside) — so instead of pretending
    to show a percentage, HeartbeatReporter sends periodic "still working"
    updates (with a rough one-time ETA based on the known file size) purely
    so the user can tell the job hasn't silently died.
    """
    if not FILE_PATH or not RELEASE_TAG or not GITHUB_REPOSITORY:
        print("❌ FILE_PATH، RELEASE_TAG یا GITHUB_REPOSITORY موجود نیست")
        sys.exit(1)

    cmd = [
        "gh", "release", "create", RELEASE_TAG, FILE_PATH,
        "--repo", GITHUB_REPOSITORY,
        "--title", RELEASE_TITLE or RELEASE_TAG,
        "--notes", RELEASE_NOTES or "",
    ]

    log_path = "/tmp/gh-release-create.log"
    log_file = open(log_path, "w")

    process = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

    file_size = os.path.getsize(FILE_PATH) if os.path.isfile(FILE_PATH) else None
    heartbeat = HeartbeatReporter(CHAT_ID, label="در حال آپلود", total_bytes=file_size) if CHAT_ID else None
    if heartbeat:
        heartbeat.start()

    while True:
        return_code = process.poll()
        if heartbeat:
            heartbeat.tick()
        if return_code is not None:
            break
        time.sleep(POLL_SECONDS)

    log_file.close()

    if return_code != 0:
        print(f"❌ gh release create با کد خطای {return_code} تمام شد. لاگ:")
        with open(log_path) as f:
            print(f.read()[-4000:])
        if heartbeat:
            heartbeat.stop("❌ آپلود ناموفق بود.")
        sys.exit(return_code)

    if heartbeat:
        heartbeat.stop("✅ آپلود کامل شد.")

    print("✅ آپلود کامل شد")


def stage_run_upload_internal():
    """
    Uploads FILE_PATH to the chosen internal S3-compatible provider instead
    of GitHub Releases. See the identical function in
    actions/direct_url_download/download.py for the full rationale (kept
    in sync between both flows on purpose) — short version: on failure this
    notifies with a retry/fallback/cancel choice and exits 0 rather than
    failing the whole Action run, since the user still has a path forward.
    """
    if not FILE_PATH or not os.path.isfile(FILE_PATH):
        print(f"❌ فایل موجود نیست: '{FILE_PATH}'")
        sys.exit(1)

    defaults = PROVIDER_DEFAULTS.get(STORAGE_PROVIDER, {})
    provider_label = defaults.get("label", STORAGE_PROVIDER or "provider داخلی")

    heartbeat = (
        HeartbeatReporter(CHAT_ID, label=f"در حال آپلود به {provider_label}", total_bytes=os.path.getsize(FILE_PATH))
        if CHAT_ID
        else None
    )
    if heartbeat:
        heartbeat.start()

    try:
        url = upload_to_s3_compatible(
            FILE_PATH,
            access_key=STORAGE_ACCESS_KEY,
            secret_key=STORAGE_SECRET_KEY,
            bucket=STORAGE_BUCKET,
            endpoint=STORAGE_ENDPOINT,
            default_endpoint=defaults.get("endpoint"),
            default_bucket=defaults.get("bucket"),
        )
    except StorageUploadError as e:
        print(f"❌ آپلود به {provider_label} ناموفق بود: {e}")
        if heartbeat:
            heartbeat.stop()
        if CHAT_ID:
            notify_storage_failed(CHAT_ID, provider_label, str(e), message_id=PROGRESS_MESSAGE_ID or None)
        sys.exit(0)

    if heartbeat:
        heartbeat.stop(f"✅ آپلود به {provider_label} کامل شد.")

    _write_output("direct_url", url)
    print(f"✅ آپلود به {provider_label} کامل شد -> {url}")


STAGES = {
    "started": stage_started,
    "downloaded": stage_downloaded,
    "process": stage_process,
    "run_download": stage_run_download,
    "run_upload": stage_run_upload,
    "run_upload_internal": stage_run_upload_internal,
    "done": stage_done,
    "failed": stage_failed,
}


if __name__ == "__main__":
    if STAGE not in STAGES:
        print(f"❌ STAGE نامعتبر: '{STAGE}' (باید یکی از {list(STAGES)} باشد)")
        sys.exit(1)

    # "process" and the run_* stages do real work even without a chat to
    # notify (e.g. manual workflow_dispatch runs) — only the pure
    # notification stages are safe to no-op without CHAT_ID.
    silent_ok_stages = {"process", "run_download", "run_upload", "run_upload_internal"}
    if STAGE not in silent_ok_stages and not CHAT_ID:
        print("⚠️ CHAT_ID موجود نیست، این اجرا احتمالا دستی (workflow_dispatch) بوده")
        sys.exit(0)

    STAGES[STAGE]()
      
