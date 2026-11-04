#!/usr/bin/env python3
"""Release cleanup of the Telegram bot's releases (run by cleanup-releases.yml).

A FILE of a bot release (tag tg-* / url-*) is removed OLD_DAYS (7) days after it was uploaded,
unless it was extended from the YT Bridge app (the hidden keep block of the release description).
When a release loses its last file the release goes too. A release with no file at all is left
alone (it may keep its files on Arvan Cloud, listed in its description).

Files that already existed when the rule started are safe until GRACE_UNTIL (see
scripts/retention_core.py, the same file the YT Bridge repo uses).
DRY_RUN=true only prints what would be deleted.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import retention_core as retention  # noqa: E402

REPO = os.environ["GITHUB_REPOSITORY"]
DRY_RUN = os.environ.get("DRY_RUN", "false").strip().lower() == "true"


def gh(*args):
    p = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:200])
    return p.stdout


def all_releases():
    out = gh("api", "--paginate", f"repos/{REPO}/releases?per_page=100", "--jq", ".[]")
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def plan(rel, now):
    """``("release", reason)``, ``("assets", [(asset, reason)])`` or None."""
    tag = rel.get("tag_name") or ""
    assets = rel.get("assets") or []
    if retention.kind_of(tag, bot=True) is None or rel.get("draft") or not assets:
        return None
    keep = retention.parse_keep(rel.get("body"))
    old = []
    for a in assets:
        due = retention.expires_at("bot", a.get("created_at") or rel.get("published_at"), keep, a.get("id"))
        if due is not None and now > due:
            old.append((a, f"older than {retention.OLD_DAYS} days (due {retention.iso(due)})"))
    if not old:
        return None
    if len(old) == len(assets):
        return ("release", old[0][1])
    return ("assets", old)


def main():
    now = datetime.now(timezone.utc)
    deleted = failed = kept = 0
    label = "WOULD DELETE" if DRY_RUN else "Deleting"
    for rel in all_releases():
        tag = rel.get("tag_name") or ""
        todo = plan(rel, now)
        if not todo:
            kept += 1
            continue
        try:
            if todo[0] == "release":
                print(f"{label} {tag} ({rel.get('name')}): {todo[1]}", flush=True)
                if not DRY_RUN:
                    gh("release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag")
                deleted += 1
            else:
                for asset, reason in todo[1]:
                    print(f"{label} file {asset.get('name')} of {tag}: {reason}", flush=True)
                    if not DRY_RUN:
                        gh("api", "-X", "DELETE", f"repos/{REPO}/releases/assets/{asset['id']}")
                    deleted += 1
        except RuntimeError as e:
            failed += 1
            print(f"::warning::could not delete {tag}: {e}")
    print(f"Done: {deleted} {'would be ' if DRY_RUN else ''}deleted, {kept} kept, {failed} failed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
