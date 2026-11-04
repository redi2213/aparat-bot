"""How long a release file lives (shared by the cleanup workflows and the app).

Pure Python, nothing here talks to the network. Rules:

* A file in a ``run-*`` release, an Auto follow release (``auto-*``) or a Telegram bot
  release (``tg-*`` / ``url-*``) is deleted OLD_DAYS (7) days after it was uploaded.
  ``job-*`` releases (Upload File) are not touched by the age rule (JOB_EXPIRES).
* Auto follow and bot files that already existed when this rule started get a fresh
  grace period: nothing of them is deleted before GRACE_UNTIL.
* The user can push the deletion date of one file later (or keep it forever). That is
  written in the release description as a hidden block::

      <!--ytb-keep:{"files": {"<asset id>": "2026-11-20T00:00:00Z" | "forever"}}-->

  A file's deletion date is the LATER of its normal date and the date written there.
"""
import json
import re
from datetime import datetime, timedelta, timezone

OLD_DAYS = 7
GRACE_UNTIL = "2026-11-11T23:59:59Z"
FOREVER = "forever"
JOB_EXPIRES = False          # True: job-* releases follow the same 7-day rule
EXTEND_PRESETS = (3, 7, 14, 30)

_KEEP_RE = re.compile(r"<!--ytb-keep:(.*?)-->\n?", re.S)
_ISO = "%Y-%m-%dT%H:%M:%SZ"


def parse_iso(text):
    """'2026-11-04T10:15:00Z' (also with fractions / +00:00) -> aware UTC datetime, or None."""
    if not text or not isinstance(text, str):
        return None
    try:
        return datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime(_ISO)


def parse_keep(body):
    """The keep block of a release description as ``{"files": {...}}`` (empty when none)."""
    m = _KEEP_RE.search(body or "")
    if m:
        try:
            data = json.loads(m.group(1))
        except ValueError:
            data = None
        if isinstance(data, dict):
            files = data.get("files")
            return {"files": dict(files) if isinstance(files, dict) else {}}
    return {"files": {}}


def with_keep(body, keep):
    """``body`` with its keep block replaced by ``keep`` (removed when ``keep`` is empty)."""
    body = _KEEP_RE.sub("", body or "").rstrip("\n")
    files = {str(k): v for k, v in (keep.get("files") or {}).items()}
    if not files:
        return body
    block = "<!--ytb-keep:" + json.dumps({"files": files}, sort_keys=True) + "-->"
    return (body + "\n" if body else "") + block


def kind_of(tag, bot=False):
    """'run' / 'job' / 'auto' / 'bot', or None for a release the rules never touch."""
    tag = tag or ""
    if bot:
        return "bot" if tag.startswith(("tg-", "url-")) else None
    for prefix in ("run", "job", "auto"):
        if tag.startswith(prefix + "-"):
            return prefix
    return None


def is_forever(keep, asset_id):
    return (keep.get("files") or {}).get(str(asset_id)) == FOREVER


def expires_at(kind, created, keep, asset_id):
    """When a file is deleted: an aware UTC datetime, or None when it never is.
    ``created``: the upload time of the file (a datetime or an ISO text)."""
    if kind is None or (kind == "job" and not JOB_EXPIRES) or is_forever(keep, asset_id):
        return None
    created = created if isinstance(created, datetime) else parse_iso(created)
    if created is None:
        return None
    when = created + timedelta(days=OLD_DAYS)
    if kind in ("auto", "bot"):
        when = max(when, parse_iso(GRACE_UNTIL))
    later = parse_iso((keep.get("files") or {}).get(str(asset_id)))
    if later and later > when:
        when = later
    return when


def extended(current, days, now):
    """The new deletion date after adding ``days`` to ``current`` (an overdue file counts from now)."""
    base = max(current or now, now)
    return base + timedelta(days=int(days))


def days_left(when, now):
    """Fractional days until ``when`` (negative once it has passed); None when there is no date."""
    if when is None:
        return None
    return (when - now).total_seconds() / 86400.0


def deadline_text(when, forever, now):
    """Short English text for a file's deadline (the Persian forms are in core/fa_strings_more.py)."""
    if forever:
        return "Kept forever"
    left = days_left(when, now)
    if left is None:
        return "No time limit"
    if left <= 0:
        return "Due for deletion"
    if left < 1:
        return "Less than 1 day left"
    n = int(left)
    return f"{n} day left" if n == 1 else f"{n} days left"
