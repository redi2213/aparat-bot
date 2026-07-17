import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import telebot
import sys

API_BASE_URL = "https://www.aparat.com/api/fa/v1"
OUTFILE = "/tmp/Aparat.txt"

# متغیرهای محیط از GitHub Actions
LINK = os.getenv('LINK', '').strip()
QUALITY = os.getenv('QUALITY', 'best')
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN')
USER_ID = int(os.getenv('USER_ID', 0))

headers = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.aparat.com/"
}

def get_video(uid, playlist=None):
    q = f"?playlist={playlist}&pr=1&mf=1" if playlist else ""
    try:
        j = requests.get(
            f"{API_BASE_URL}/video/video/show/videohash/{uid}{q}",
            headers=headers,
            timeout=15
        ).json()
        
        if 'data' not in j or 'attributes' not in j['data']:
            return []
        
        a = j["data"]["attributes"]
        
        return [
            {
                "title": a.get("title", "Unknown"),
                "profile": x["profile"],
                "url": x["urls"][0]
            }
            for x in a.get("file_link_all", [])
        ]
    except Exception as e:
        print(f"Error in get_video: {e}")
        return []

def scrape_aparat(url):
    """اسکریپت اپارات"""
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
            videos.append(get_video(vid))
        else:
            j = requests.get(
                f"{API_BASE_URL}/video/playlist/one/playlist_id/{pid}",
                headers=headers,
                timeout=15
            ).json()
            
            ids = [
                x["attributes"]["uid"]
                for x in j.get("included", [])
                if x["type"] == "Video"
            ]
            
            if not ids:
                return None, "❌ هیچ ویدیویی پیدا نشد"
            
            with ThreadPoolExecutor(max_workers=10) as ex:
                fs = [ex.submit(get_video, i, pid) for i in ids]
                for f in as_completed(fs):
                    result = f.result()
                    if result:
                        videos.append(result)
        
        if not videos:
            return None, "❌ نتیجه‌ای پیدا نشد"
        
        # استخراج کیفیت‌های موجود
        qualities = sorted(
            {q["profile"] for v in videos for q in v},
            key=lambda x: int(x[:-1]) if x[:-1].isdigit() else 0,
            reverse=True
        )
        
        if not qualities:
            return None, "❌ کیفیتی موجود نیست"
        
        # انتخاب کیفیت
        selected = QUALITY
        if selected == "best":
            selected = qualities[0]
        elif selected not in qualities:
            selected = qualities[0]
        
        # جمع‌آوری لینک‌ها
        results = []
        for video in videos:
            for q in video:
                if q["profile"] == selected:
                    results.append(q["url"])
                    break
        
        if not results:
            return None, "❌ لینکی پیدا نشد"
        
        # ذخیره فایل
        with open(OUTFILE, "w", encoding="utf-8") as f:
            f.write("\n".join(results))
        
        return results, f"✅ {len(results)} لینک دریافت شد (کیفیت: {selected})"
    
    except Exception as e:
        return None, f"❌ خطا: {str(e)}"

def send_to_telegram(results, message):
    """نتیجه رو برای تلگرام بفرستید"""
    if not TELEGRAM_TOKEN or not USER_ID:
        print("❌ توک
