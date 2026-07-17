import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import telebot
import sys

API_BASE_URL = "https://www.aparat.com/api/fa/v1"

LINK = os.getenv('LINK', '').strip()
QUALITY = os.getenv('QUALITY', 'best')
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN')
USER_ID = int(os.getenv('USER_ID', '0'))
CHAT_ID = os.getenv('CHAT_ID', '0')

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
                headers=headers,
                timeout=15
            ).json()
            
            ids = [
                x["attributes"]["uid"]
                for x in j.get("included", [])
                if x["type"] == "Video"
            ]
            
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
            reverse=True
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

def send_to_telegram(results, message):
    if not TELEGRAM_TOKEN or not CHAT_ID or CHAT_ID == '0':
        print(f"⚠️ توکن یا CHAT_ID موجود نیست")
        if results:
            print(f"\n📥 لینک‌ها:\n")
            for link in results:
                print(link)
        return
    
    try:
        bot = telebot.TeleBot(TELEGRAM_TOKEN)
        
        bot.send_message(CHAT_ID, message)
        
        if results:
            text = "\n".join(results)
            
            if len(text) > 4000:
                for i in range(0, len(text), 4000):
                    bot.send_message(
                        CHAT_ID,
                        f"```\n{text[i:i+4000]}\n```",
                        parse_mode="Markdown"
                    )
            else:
                bot.send_message(
                    CHAT_ID,
                    f"```\n{text}\n```",
                    parse_mode="Markdown"
                )
        
        print("✅ نتیجه برای تلگرام ارسال شد")
    
    except Exception as e:
        print(f"❌ خطا در ارسال تلگرام: {e}")

if __name__ == "__main__":
    if not LINK:
        print("❌ لینک موجود نیست")
        sys.exit(1)
    
    print(f"🔍 در حال پردازش: {LINK}")
    print(f"📊 کیفیت: {QUALITY}\n")
    
    results, message = scrape_aparat(LINK)
    
    print(f"\n{message}\n")
    send_to_telegram(results, message)
