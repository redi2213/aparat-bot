"""
actions/common/storage_upload.py

Uploads a local file to an S3-compatible "internal" storage provider
(ArvanCloud Object Storage today; any other S3-compatible provider a bucket
gets added for later — Asiatech, etc — needs no changes here, only a new
entry in worker/state/storageProviders.js on the Worker side and a
matching endpoint/bucket passed through the same client_payload fields).

Deliberately provider-agnostic: this module knows nothing about
"ArvanCloud" specifically. Everything provider-specific (endpoint, bucket,
credentials) arrives via function arguments, sourced from the
client_payload's storage_* fields set by worker/telegram/handlers.js
startJob(). This is what makes adding a second provider later a
config-only change instead of a code change.

Uses boto3's generic S3 client pointed at a custom endpoint_url — this is
the standard way to talk to any S3-compatible object storage (ArvanCloud,
Asiatech, MinIO, Backblaze B2, etc all support this).
"""

import os
import mimetypes
from urllib.parse import quote

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError


class StorageUploadError(Exception):
    """Raised on any failure uploading to the internal provider — network,
    auth, bucket-not-found, quota-on-the-provider's-own-side, etc. The
    caller (download.py) catches this and falls through to
    notify_storage_failed() rather than letting the whole Action fail
    silently with a stack trace the user never sees."""

    pass


def upload_to_s3_compatible(
    file_path,
    *,
    access_key,
    secret_key,
    bucket,
    endpoint=None,
    default_endpoint=None,
    default_bucket=None,
    key_prefix="",
    public_read=True,
):
    """
    Uploads file_path to the given bucket on an S3-compatible endpoint and
    returns a public direct-download URL.

    endpoint/bucket fall back to default_endpoint/default_bucket (the
    provider's catalog defaults — see storageProviders.js) when not given,
    so a user who registered a personal key but left endpoint/bucket blank
    (the "-" shortcut in the bot's key-collection flow) still gets a
    working upload against the provider's standard region/bucket-naming.

    Raises StorageUploadError on any failure — never lets a raw boto3
    exception escape, since the caller needs a clean message to show the
    user via notify_storage_failed().
    """
    resolved_endpoint = endpoint or default_endpoint
    resolved_bucket = bucket or default_bucket

    if not resolved_endpoint:
        raise StorageUploadError("Endpoint برای این provider تنظیم نشده.")
    if not resolved_bucket:
        raise StorageUploadError("نام Bucket تنظیم نشده.")
    if not access_key or not secret_key:
        raise StorageUploadError("Access Key / Secret Key تنظیم نشده.")
    if not os.path.isfile(file_path):
        raise StorageUploadError(f"فایل برای آپلود پیدا نشد: {file_path}")

    file_name = os.path.basename(file_path)
    object_key = f"{key_prefix.rstrip('/')}/{file_name}" if key_prefix else file_name

    content_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"

    try:
        client = boto3.client(
            "s3",
            endpoint_url=resolved_endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            # ArvanCloud (and most S3-compatible providers) work fine with
            # virtual-host-style addressing off, i.e. path-style, and
            # signature v4 — the boto3 default for a generic S3-compatible
            # endpoint. 's3v4' is explicit here rather than relying on
            # boto3's auto-detection, since auto-detection is tuned for AWS
            # itself and can guess wrong against a third-party endpoint.
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
            # Region is meaningless for most S3-compatible providers, but
            # boto3 requires *some* value be set — any non-empty string
            # works since the endpoint_url is what actually routes the
            # request, not this.
            region_name="default",
        )

        extra_args = {"ContentType": content_type}
        if public_read:
            extra_args["ACL"] = "public-read"

        client.upload_file(file_path, resolved_bucket, object_key, ExtraArgs=extra_args)

    except (BotoCoreError, ClientError) as e:
        raise StorageUploadError(_friendly_error(e)) from e
    except Exception as e:  # noqa: BLE001 — this is the top-level boundary; anything unexpected still becomes a StorageUploadError, never a bare crash
        raise StorageUploadError(str(e)) from e

    return _build_public_url(resolved_endpoint, resolved_bucket, object_key)


def _friendly_error(e):
    """boto3/botocore exceptions are informative but verbose (full XML
    error bodies etc) — trims to something short enough to show in a
    Telegram message, per notify_storage_failed()."""
    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "")
        message = e.response.get("Error", {}).get("Message", str(e))
        if code:
            return f"{code}: {message}"
        return message
    return str(e)


def _build_public_url(endpoint, bucket, object_key):
    """
    Path-style public URL: {endpoint}/{bucket}/{key}. This matches
    ArvanCloud's public-read object URL format (and is the standard
    path-style layout most S3-compatible providers also serve public
    objects at) — no presigned URL needed since the object is uploaded
    with ACL public-read above.

    object_key is URL-encoded here (safe="/", so path separators stay
    literal) — a renamed or zipped file's name can contain spaces or other
    characters that are fine as an S3 object key but break as a literal,
    un-encoded URL. An unencoded space in particular gets read by Telegram
    as the end of the link, silently truncating/splitting it — exactly the
    bug this was fixed for. Bucket/endpoint aren't encoded since they're
    provider-controlled values, not derived from a user-chosen filename.
    """
    base = endpoint.rstrip("/")
    return f"{base}/{bucket}/{quote(object_key, safe='/')}"
