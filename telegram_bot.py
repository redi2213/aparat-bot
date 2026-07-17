import telebot
import requests
import os
from telebot import types

TOKEN = os.getenv('TELEGRAM_TOKEN')
USER_ID = int(os.getenv('USER_ID'))
GITHUB_TOKEN = os.getenv('GH_TOKEN')
REPO = "redi2213/aparat-bot"  # تغییر دهید اگر ریپو‌تون اسم دیگه‌ای داره

bot = telebot.TeleBot(TOKEN)

# ذخیره وضعیت کاربر
user_data = {}

@bot.message_handler(commands=['start'])
def start(message):
    if message.from_user.id != USER_ID:
        bot.reply_to(message, "❌ شما دسترسی ندارید")
        return
    
    bot.reply_to(message, "👋 سلام!\n\nلینک آپارات رو بفرستید:\n\n• ویدیو: https://www.aparat.com/v/VIDEO_ID\n• پلی‌لیست: https://www.aparat.com/playlist/PLAYLIST_ID")

@bot.message_handler(func=lambda msg: "aparat.com" in msg.text)
def handle_link(message):
    if message.from_user.id != USER_ID:
        bot.reply_to(message, "❌ شما دسترسی ندارید")
        return
    
    link = message.text.strip()
    
    # چک کنید لینک درست باشه
    if "/playlist/" not in link and "/v/" not in link:
        bot.reply_to(message, "❌ لینک نامعتبره. لینک صحیح بفرستید.")
        return
    
    # ذخیره لینک
    user_data[message.from_user.id] = {'link': link, 'message_id': message.message_id}
    
    # دکمه‌های کیفیت
    markup = types.InlineKeyboardMarkup()
    markup.add(
        types.InlineKeyboardButton("🎬 Best", callback_data="quality_best"),
        types.InlineKeyboardButton("1080p", callback_data="quality_1080p")
    )
    markup.add(
        types.InlineKeyboardButton("720p", callback_data="quality_720p"),
        types.InlineKeyboardButton("480p", callback_data="quality_480p")
    )
    
    bot.reply_to(message, "⬇️ کیفیت رو انتخاب کنید:", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("quality_"))
def handle_quality(call):
    if call.from_user.id != USER_ID:
        bot.answer_callback_query(call.id, "❌ دسترسی ندارید", show_alert=True)
        return
    
    quality = call.data.replace("quality_", "")
    link = user_data.get(call.from_user.id, {}).get('link')
    
    if not link:
        bot.answer_callback_query(call.id, "❌ لینک گم شد", show_alert=True)
        return
    
    # ویرایش پیام
    bot.edit_message_text(
        "⏳ در حال پردازش...",
        call.message.chat.id,
        call.message.message_id
    )
    
    # فعال کردن GitHub Actions
    trigger_github_action(link, quality, call.message.chat.id, call.message.message_id)

def trigger_github_action(link, quality, chat_id, message_id):
    """GitHub Actions رو فعال کنید"""
    url = f"https://api.github.com/repos/{REPO}/dispatches"
    
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    payload = {
        "event_type": "run_aparat",
        "client_payload": {
            "link": link,
            "quality": quality,
            "chat_id": chat_id,
            "message_id": message_id
        }
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers)
        if response.status_code == 204:
            bot.send_message(chat_id, "✅ درخواست ارسال شد!\n⏳ اسکریپت در حال اجرا است...")
        else:
            bot.send_message(chat_id, f"❌ خطا: {response.text}")
    except Exception as e:
        bot.send_message(chat_id, f"❌ خطا: {str(e)}")

@bot.message_handler(func=lambda msg: True)
def unknown_message(message):
    if message.from_user.id == USER_ID:
        bot.reply_to(message, "❓ متوجه نشدم. لینک آپارات بفرستید.")

if __name__ == "__main__":
    print("🤖 ربات شروع شد...")
    bot.infinity_polling()
