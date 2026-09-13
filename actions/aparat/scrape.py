"""
actions/aparat/scrape.py

Fetches direct download links for an Aparat video or playlist and reports
progress to Telegram via actions/common/notify.py.

This deliberately does NOT re-encode or re-host the video: Aparat already
serves direct CDN links per quality profile, so we just resolve and hand
those back (see requirement: "دانلود بدون تغییر/Encode مجدد").
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "common"))
from notify import notify_started, notify_done, notify_failed  # noqa: E402

API_BASE_URL = "https://www.aparat.com/api/fa/v1"

LINK = os.getenv("LINK", "").strip()
QUALITY = os.getenv("QUALITY", "best")
CHAT_ID = os.getenv("CHAT_ID", "").strip()

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.aparat.com/",
}


def get_video(uid, playlist=None):
    q = f"?playlist={playlist}&pr=1&mf=1" if playlist else ""
    try:
        j = requests.get(
            f"{API_BASE_URL}/video/video/show/videohash/{uid}{q}",
            headers=HEADERS,
            timeout=15,
        ).json()

        if "data" not in j or "attributes" not in j["data"]:
            return []

        a = j["data"]["attributes"]

        return [
            {"title": a.get("title", "Unknown"), "profile": x["profile"], "url": x["urls"][0]}
            for x in a.get("file_link_all", [])
        ]
    except Exception as e:
        print(f"❌ خطا در get_video: {e}")
        return []


def scrape_aparat(url):
    url = url.rstrip("/")

    if "/playlist/" in url:
        mode = "playlist"
        pid = url.split("/")[-1]
    elif "/v/" in url:
        mode = "video"
        vid = url.split("/")[-1]
    else:
        return None, "❌ لینک نامعتبره"

    videos = []

    try:
        if mode == "video":
            print(f"🎬 دریافت ویدیو: {vid}")
            videos.append(get_video(vid))
        else:
            print(f"📋 دریافت پلی‌لیست: {pid}")
            j = requests.get(
                f"{API_BASE_URL}/video/playlist/one/playlist_id/{pid}",
                headers=HEADERS,
                timeout=15,
            ).json()

            ids = [x["attributes"]["uid"] for x in j.get("included", []) if x["type"] == "Video"]

            print(f"📺 {len(ids)} ویدیو پیدا شد")

            if not ids:
                return None, "❌ هیچ ویدیویی پیدا نشد"

            with ThreadPoolExecutor(max_workers=5) as ex:
                fs = [ex.submit(get_video, i, pid) for i in ids]
                for i, f in enumerate(as_completed(fs), 1):
                    result = f.result()
                    if result:
                        videos.append(result)
                        print(f"✅ {i}/{len(ids)}")

        if not videos or all(not v for v in videos):
            return None, "❌ نتیجه‌ای پیدا نشد"

        qualities = sorted(
            {q["profile"] for v in videos for q in v if v},
            key=lambda x: int(x[:-1]) if x[:-1].isdigit() else 0,
            reverse=True,
        )

        print(f"📊 کیفیت‌های موجود: {', '.join(qualities)}")

        if not qualities:
            return None, "❌ کیفیتی موجود نیست"

        selected = QUALITY
        if selected == "best" or selected not in qualities:
            selected = qualities[0]

        print(f"🎯 کیفیت انتخاب‌شده: {selected}")

        results = []
        for video in videos:
            for q in video:
                if q["profile"] == selected:
                    results.append(q["url"])
                    break

        if not results:
            return None, "❌ لینکی پیدا نشد"

        return results, f"✅ {len(results)} لینک دریافت شد (کیفیت: {selected})"

    except Exception as e:
        return None, f"❌ خطا: {str(e)}"


def send_results(results, message):
    if not CHAT_ID:
        print("⚠️ CHAT_ID موجود نیست")
        if results:
            print("\n📥 لینک‌ها:\n")
            for link in results:
                print(link)
        return

    if not results:
        notify_failed(CHAT_ID, message)
        return

    text = "\n".join(results)
    notify_done(CHAT_ID, message, link=text if len(text) <= 3500 else None)

    # For long lists, chunk separately rather than cramming into one message
    # (same limit-avoidance behaviour as before, just delegated to notify()).
    if len(text) > 3500:
        from notify import notify

        for i in range(0, len(text), 3500):
            notify(CHAT_ID, f"```\n{text[i:i + 3500]}\n```", parse_mode="Markdown")


if __name__ == "__main__":
    if not LINK:
        print("❌ لینک موجود نیست")
        sys.exit(1)

    print(f"🔍 در حال پردازش: {LINK}")
    print(f"📊 کیفیت: {QUALITY}\n")

    notify_started(CHAT_ID, "دریافت اطلاعات از آپارات")

    results, message = scrape_aparat(LINK)

    print(f"\n{message}\n")
    send_results(results, message)
