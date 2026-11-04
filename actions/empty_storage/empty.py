"""
actions/empty_storage/empty.py

Really empties the bot's storage:
  - GitHub : deletes every Release whose tag was made by the bot
             (tg-YYYYMMDD-HHMMSS / url-YYYYMMDD-HHMMSS) plus its git tag.
             Other releases in the repo are never touched.
  - Arvan  : deletes every object in the bucket of the admin's key.

Input comes from the repository_dispatch payload (GITHUB_EVENT_PATH):
  { chat_id, targets: "github"|"arvan"|"all",
    storage: { storage_access_key, storage_secret_key, storage_endpoint, storage_bucket } }

On success of each target it asks the Worker (/internal/history-purge) to
drop the now-dangling history entries, then reports the result in the chat.
"""

import json
import os
import re
import subprocess
import sys

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "common"))
from notify import notify  # noqa: E402

BOT_TAG_RE = re.compile(r"^(tg|url)-\d{8}-\d{6}$")
DEFAULT_ENDPOINT = "https://s3.ir-thr-at1.arvanstorage.ir"
DEFAULT_BUCKET = "my-files-telegram"

WORKER_URL = os.getenv("WORKER_URL", "").rstrip("/")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET")


def load_payload():
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        return json.load(f).get("client_payload", {}) or {}


def mask(value):
    if value:
        print(f"::add-mask::{value}")


def empty_github():
    out = subprocess.run(
        ["gh", "release", "list", "--limit", "1000", "--json", "tagName"],
        capture_output=True, text=True, check=True,
    ).stdout
    tags = [r["tagName"] for r in json.loads(out or "[]")]
    mine = [t for t in tags if BOT_TAG_RE.match(t)]
    deleted, failed = 0, []
    for tag in mine:
        r = subprocess.run(
            ["gh", "release", "delete", tag, "--cleanup-tag", "--yes"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            deleted += 1
        else:
            failed.append(f"{tag}: {r.stderr.strip()[:120]}")
    return deleted, failed


def _s3_client(storage):
    import boto3
    from botocore.client import Config

    kwargs = dict(signature_version="s3v4", s3={"addressing_style": "path"})
    try:
        # Newer botocore adds CRC32 checksums some S3-compatible providers
        # reject; only send them when an operation strictly requires it.
        cfg = Config(request_checksum_calculation="when_required", response_checksum_validation="when_required", **kwargs)
    except TypeError:
        cfg = Config(**kwargs)
    return boto3.client(
        "s3",
        endpoint_url=storage.get("storage_endpoint") or DEFAULT_ENDPOINT,
        aws_access_key_id=storage["storage_access_key"],
        aws_secret_access_key=storage["storage_secret_key"],
        config=cfg,
        region_name="default",
    )


def empty_arvan(storage):
    client = _s3_client(storage)
    bucket = storage.get("storage_bucket") or DEFAULT_BUCKET
    deleted, failed = 0, []

    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        keys = [o["Key"] for o in page.get("Contents", [])]
        if not keys:
            continue
        try:
            resp = client.delete_objects(
                Bucket=bucket, Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True}
            )
            errors = resp.get("Errors", [])
            deleted += len(keys) - len(errors)
            failed += [f"{e.get('Key')}: {e.get('Code')}" for e in errors]
        except Exception as e:  # noqa: BLE001 — fall back to one-by-one for providers lacking bulk delete
            print(f"⚠️ bulk delete failed ({e}); falling back to per-object delete")
            for k in keys:
                try:
                    client.delete_object(Bucket=bucket, Key=k)
                    deleted += 1
                except Exception as e2:  # noqa: BLE001
                    failed.append(f"{k}: {e2}")
    return deleted, failed, bucket


def purge_history(which):
    if not WORKER_URL or not INTERNAL_SECRET:
        print("⚠️ WORKER_URL/INTERNAL_SECRET missing — history not purged")
        return False
    try:
        r = requests.post(
            f"{WORKER_URL}/internal/history-purge",
            headers={"Content-Type": "application/json", "X-Internal-Secret": INTERNAL_SECRET},
            json={"storage": which},
            timeout=20,
        )
        if not r.ok:
            print(f"⚠️ history purge failed: {r.status_code} {r.text}")
        return r.ok
    except Exception as e:  # noqa: BLE001
        print(f"⚠️ history purge error: {e}")
        return False


def main():
    payload = load_payload()
    chat_id = payload.get("chat_id")
    targets = payload.get("targets", "")
    storage = payload.get("storage") or {}
    mask(storage.get("storage_access_key"))
    mask(storage.get("storage_secret_key"))

    do_gh = targets in ("github", "all")
    do_arvan = targets in ("arvan", "all")
    lines, ok_all = [], True

    if do_gh:
        try:
            n, failed = empty_github()
            lines.append(f"🌍 GitHub: {n} ریلیز حذف شد." + (f" ({len(failed)} ناموفق)" if failed else ""))
            for f in failed[:5]:
                lines.append(f"   ❌ {f}")
            if not failed:
                purge_history("github")
            else:
                ok_all = False
        except Exception as e:  # noqa: BLE001
            ok_all = False
            lines.append(f"🌍 GitHub: ❌ {e}")

    if do_arvan:
        try:
            if not storage.get("storage_access_key"):
                raise RuntimeError("کلید آروان در درخواست نبود")
            n, failed, bucket = empty_arvan(storage)
            lines.append(f"🇮🇷 آروان ({bucket}): {n} فایل حذف شد." + (f" ({len(failed)} ناموفق)" if failed else ""))
            for f in failed[:5]:
                lines.append(f"   ❌ {f}")
            if not failed:
                purge_history("arvan")
            else:
                ok_all = False
        except Exception as e:  # noqa: BLE001
            ok_all = False
            lines.append(f"🇮🇷 آروان: ❌ {str(e)[:200]}")

    header = "🧹 خالی‌سازی مخزن تموم شد." if ok_all else "⚠️ خالی‌سازی با مشکل تموم شد."
    notify(
        chat_id,
        header + "\n\n" + "\n".join(lines),
        reply_markup={"inline_keyboard": [[{"text": "🔙 بازگشت به منو", "callback_data": "menu_main"}]]},
    )
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
