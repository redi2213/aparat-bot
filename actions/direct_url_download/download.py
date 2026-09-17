"""
actions/direct_url_download/download.py

Downloads a plain http(s) URL (not a Telegram link) via streaming HTTP,
optionally renames/zips it, uploads the file as a GitHub Release asset, and
reports progress/status to the user via actions/common/notify.py.

Unlike the Telegram flow (actions/telegram_download/download.py), a direct
URL usually gives us a Content-Length header up front, so the download
progress bar can show a real percentage instead of just bytes-moved — see
stage_run_download below.

Stage structure mirrors telegram_download/download.py on purpose (started /
downloaded / process / run_download / run_upload / done / failed), so the
two flows stay easy to compare and maintain side by side.
"""

import os
import shutil
import subprocess
import sys
import time
import zipfile
from urllib.parse import urlparse, unquote

import requests

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

SOURCE_URL = os.getenv("SOURCE_URL", "").strip()
CHAT_ID = os.getenv("CHAT_ID", "").strip()
STAGE = os.getenv("STAGE", "").strip()
FILE_PATH = os.getenv("FILE_PATH", "").strip()
DIRECT_URL = os.getenv("DIRECT_URL", "").strip()
FAIL_REASON = os.getenv("FAIL_REASON", "").strip()
CUSTOM_NAME = os.getenv("CUSTOM_NAME", "").strip()
ZIP = os.getenv("ZIP", "").strip().lower() in ("1", "true", "yes")

# Internal-storage (ArvanCloud etc) fields — see worker/telegram/handlers.js
# startJob() for how these are populated from client_payload. Empty strings
# (not missing) when storage_target is "external", so .strip() is safe.
STORAGE_TARGET = os.getenv("STORAGE_TARGET", "external").strip() or "external"
STORAGE_PROVIDER = os.getenv("STORAGE_PROVIDER", "").strip()
STORAGE_ACCESS_KEY = os.getenv("STORAGE_ACCESS_KEY", "").strip()
STORAGE_SECRET_KEY = os.getenv("STORAGE_SECRET_KEY", "").strip()
STORAGE_ENDPOINT = os.getenv("STORAGE_ENDPOINT", "").strip()
STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "").strip()
STORAGE_USING_PERSONAL_KEY = os.getenv("STORAGE_USING_PERSONAL_KEY", "").strip() in ("1", "true", "yes")
PROGRESS_MESSAGE_ID = os.getenv("PROGRESS_MESSAGE_ID", "").strip()

# Providers this Action knows the *default* endpoint/bucket for, so a user
# who left those blank when registering a personal key still gets a
# working upload. Mirrors worker/state/storageProviders.js — kept as a
# small local mirror rather than importing JS from Python; if a new
# provider is added on the Worker side, add its defaults here too.
PROVIDER_DEFAULTS = {
    "arvan": {
        "endpoint": "https://s3.ir-thr-at1.arvanstorage.ir",
        "bucket": "my-files-telegram",
        "label": "آروان‌کلاد",
    },
}

DOWNLOAD_DIR = os.getenv("DOWNLOAD_DIR", "").strip()
RELEASE_TAG = os.getenv("RELEASE_TAG", "").strip()
RELEASE_TITLE = os.getenv("RELEASE_TITLE", "").strip()
RELEASE_NOTES = os.getenv("RELEASE_NOTES", "").strip()
GITHUB_REPOSITORY = os.getenv("GITHUB_REPOSITORY", "").strip()
POLL_SECONDS = 2
CHUNK_SIZE = 1024 * 1024  # 1MB read chunks while streaming to disk


def _write_output(key, value):
    github_output = os.getenv("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"{key}={value}\n")


def _filename_from_url(url, content_disposition=None):
    if content_disposition:
        # crude but sufficient: filename="x.mp4" or filename*=UTF-8''x.mp4
        for part in content_disposition.split(";"):
            part = part.strip()
            if part.lower().startswith("filename*="):
                value = part.split("=", 1)[1].strip().strip('"')
                if "''" in value:
                    value = value.split("''", 1)[1]
                return unquote(value)
            if part.lower().startswith("filename="):
                return part.split("=", 1)[1].strip().strip('"')

    path = urlparse(url).path
    name = os.path.basename(unquote(path))
    return name or "downloaded_file"


def stage_started():
    notify_started(CHAT_ID, f"دانلود لینک مستقیم\n{SOURCE_URL}")


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
    record_history(CHAT_ID, "direct_url", file_name, file_size, DIRECT_URL, storage_kind, STORAGE_USING_PERSONAL_KEY)


def stage_failed():
    notify_failed(CHAT_ID, FAIL_REASON or "دانلود لینک مستقیم ناموفق بود. لاگ Actions را بررسی کنید.")


def stage_process():
    """Applies rename/zip, same behaviour as the Telegram flow's stage_process."""
    if not FILE_PATH or not os.path.isfile(FILE_PATH):
        print(f"❌ فایل موجود نیست: '{FILE_PATH}'")
        sys.exit(1)

    final_path = FILE_PATH

    if CUSTOM_NAME:
        directory = os.path.dirname(final_path)
        ext = os.path.splitext(final_path)[1]
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


def stage_run_download():
    """
    Streams SOURCE_URL to disk, reporting real percentage/speed/ETA when
    Content-Length is available. If the server doesn't report a size, falls
    back to the same bytes-only display the Telegram flow uses.
    """
    if not SOURCE_URL or not DOWNLOAD_DIR:
        print("❌ SOURCE_URL یا DOWNLOAD_DIR موجود نیست")
        sys.exit(1)

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    try:
        response = requests.get(SOURCE_URL, stream=True, timeout=30)
        response.raise_for_status()
    except Exception as e:
        print(f"❌ خطا در اتصال به لینک: {e}")
        if CHAT_ID:
            notify_failed(CHAT_ID, f"اتصال به لینک ناموفق بود: {e}")
        sys.exit(1)

    total_bytes = None
    content_length = response.headers.get("Content-Length")
    if content_length and content_length.isdigit():
        total_bytes = int(content_length)

    file_name = _filename_from_url(SOURCE_URL, response.headers.get("Content-Disposition"))
    # Keep filenames filesystem-safe the same way stage_process does for
    # rename, so a hostile/odd URL can't write outside DOWNLOAD_DIR or
    # collide with reserved characters.
    file_name = "".join(c for c in file_name if c not in '/\\:*?"<>|').strip() or "downloaded_file"
    dest_path = os.path.join(DOWNLOAD_DIR, file_name)

    reporter = ProgressReporter(CHAT_ID, label="در حال دانلود", total_bytes=total_bytes) if CHAT_ID else None
    if reporter:
        reporter.start()

    downloaded = 0
    last_tick_time = time.monotonic()

    try:
        with open(dest_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)

                # Only bother calling tick() every couple seconds of wall
                # time, not on every 1MB chunk — tick() itself also rate-
                # limits the actual Telegram edit, this just avoids the
                # (cheap but pointless) function-call overhead in between.
                now = time.monotonic()
                if reporter and (now - last_tick_time) >= POLL_SECONDS:
                    reporter.tick(downloaded)
                    last_tick_time = now
    except Exception as e:
        print(f"❌ خطا در حین دانلود: {e}")
        if reporter:
            reporter.stop("❌ دانلود ناموفق بود.")
        sys.exit(1)

    if reporter:
        reporter.tick(downloaded, force=True)
        reporter.stop(f"✅ دانلود کامل شد.\n📦 حجم: {format_bytes(downloaded)}")

    _write_output("downloaded_path", dest_path)
    print(f"✅ دانلود کامل شد ({format_bytes(downloaded)}) -> {dest_path}")


def stage_run_upload():
    """Identical strategy to telegram_download's stage_run_upload: launch
    `gh release create` in the background, heartbeat with a rough ETA based
    on the known file size since we have no real upload-progress signal."""
    if not FILE_PATH or not RELEASE_TAG or not GITHUB_REPOSITORY:
        print("❌ FILE_PATH، RELEASE_TAG یا GITHUB_REPOSITORY موجود نیست")
        sys.exit(1)

    cmd = [
        "gh", "release", "create", RELEASE_TAG, FILE_PATH,
        "--repo", GITHUB_REPOSITORY,
        "--title", RELEASE_TITLE or RELEASE_TAG,
        "--notes", RELEASE_NOTES or "",
    ]

    log_path = "/tmp/gh-release-create-direct.log"
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
    of GitHub Releases. On failure, does NOT sys.exit(1) the way the
    external path's stage_run_upload does — instead calls
    notify_storage_failed() to show the retry/fallback/cancel choice and
    exits 0, since from the workflow's point of view this was a handled
    outcome (the user gets a next step), not a crashed run. The Worker's
    handleStorageFailureChoice takes it from there if the user picks retry
    or fallback (see worker/telegram/handlers.js).
    """
    if not FILE_PATH or not os.path.isfile(FILE_PATH):
        print(f"❌ فایل موجود نیست: '{FILE_PATH}'")
        sys.exit(1)

    defaults = PROVIDER_DEFAULTS.get(STORAGE_PROVIDER, {})
    provider_label = defaults.get("label", STORAGE_PROVIDER or "provider داخلی")

    heartbeat = HeartbeatReporter(CHAT_ID, label=f"در حال آپلود به {provider_label}", total_bytes=os.path.getsize(FILE_PATH)) if CHAT_ID else None
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
        # Exit 0: this is a handled, user-facing outcome (they get a
        # retry/fallback/cancel choice), not an unrecoverable Action
        # failure — sys.exit(1) here would also mark the whole workflow
        # run as "failed" in GitHub's UI for something that isn't a bug.
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

    silent_ok_stages = {"process", "run_download", "run_upload", "run_upload_internal"}
    if STAGE not in silent_ok_stages and not CHAT_ID:
        print("⚠️ CHAT_ID موجود نیست، این اجرا احتمالا دستی (workflow_dispatch) بوده")
        sys.exit(0)

    STAGES[STAGE]()
