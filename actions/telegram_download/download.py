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
    format_bytes,
    record_history,
    ProgressReporter,
    HeartbeatReporter,
)

TELEGRAM_URL = os.getenv("TELEGRAM_URL", "").strip()
CHAT_ID = os.getenv("CHAT_ID", "").strip()
STAGE = os.getenv("STAGE", "").strip()  # set by the workflow step calling us
FILE_PATH = os.getenv("FILE_PATH", "").strip()
DIRECT_URL = os.getenv("DIRECT_URL", "").strip()
FAIL_REASON = os.getenv("FAIL_REASON", "").strip()
CUSTOM_NAME = os.getenv("CUSTOM_NAME", "").strip()
ZIP = os.getenv("ZIP", "").strip().lower() in ("1", "true", "yes")

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


def _write_output(key, value):
    github_output = os.getenv("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"{key}={value}\n")


def stage_started():
    notify_started(CHAT_ID, f"دانلود پیام تلگرام\n{TELEGRAM_URL}")


def stage_downloaded():
    size_label = None
    if FILE_PATH and os.path.isfile(FILE_PATH):
        size_label = format_bytes(os.path.getsize(FILE_PATH))
    notify_downloaded(CHAT_ID, size_label)


def stage_done():
    notify_done(CHAT_ID, "دانلود با موفقیت انجام شد!", link=DIRECT_URL)

    file_name = os.path.basename(FILE_PATH) if FILE_PATH else None
    file_size = os.path.getsize(FILE_PATH) if FILE_PATH and os.path.isfile(FILE_PATH) else None
    record_history(CHAT_ID, "telegram", file_name, file_size, DIRECT_URL)


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
    Launches `tdl dl` in the background and polls the download directory's
    growing size to drive a live ProgressReporter. We don't know the exact
    target file size ahead of time (tdl reports it internally, not to us),
    so the bar shows bytes-transferred-so-far and speed rather than a
    percentage — still gives the user a clear "it's alive and moving" signal.
    """
    if not TELEGRAM_URL or not DOWNLOAD_DIR:
        print("❌ TELEGRAM_URL یا DOWNLOAD_DIR موجود نیست")
        sys.exit(1)

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

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
    log_file = open(log_path, "w")

    process = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)

    reporter = ProgressReporter(CHAT_ID, label="در حال دانلود از تلگرام") if CHAT_ID else None
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
        sys.exit(return_code)

    final_bytes = _dir_size(DOWNLOAD_DIR)
    if reporter:
        reporter.stop(f"✅ دانلود کامل شد.\n📦 حجم: {format_bytes(final_bytes)}")

    print(f"✅ دانلود کامل شد ({format_bytes(final_bytes)})")


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


STAGES = {
    "started": stage_started,
    "downloaded": stage_downloaded,
    "process": stage_process,
    "run_download": stage_run_download,
    "run_upload": stage_run_upload,
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
    silent_ok_stages = {"process", "run_download", "run_upload"}
    if STAGE not in silent_ok_stages and not CHAT_ID:
        print("⚠️ CHAT_ID موجود نیست، این اجرا احتمالا دستی (workflow_dispatch) بوده")
        sys.exit(0)

    STAGES[STAGE]()
