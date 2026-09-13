// worker/telegram/menus.js
//
// All inline-keyboard / menu definitions live here, separate from the
// handler logic that reacts to them (handlers.js) and the session state
// they operate on (state/session.js). Keeping menu *shape* separate from
// menu *behaviour* makes it easy to add new options later (rename, zip,
// and future ones) without hunting through handler code.

export const MAIN_MENU_TEXT =
  "👋 سلام! به ربات آپارات و تلگرام خوش اومدید.\n\n" +
  "چیکار می‌خواید بکنید؟";

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📎 راهنمای ارسال لینک", callback_data: "menu_help" }],
      [{ text: "🕘 تاریخچه فایل‌ها", callback_data: "menu_history" }],
      [{ text: "⚙️ تنظیمات", callback_data: "menu_settings" }],
    ],
  };
}

export const HELP_TEXT =
  "📎 روش‌های ارسال:\n\n" +
  "• لینک ویدیو آپارات: https://www.aparat.com/v/VIDEO_ID\n" +
  "• لینک پلی‌لیست آپارات: https://www.aparat.com/playlist/PLAYLIST_ID\n" +
  "• لینک پیام عمومی تلگرام: https://t.me/channel/123\n" +
  "• فوروارد یک پیام حاوی فایل از کانال/گروه عمومی\n\n" +
  "بعد از شناسایی، یک منو براتون میاد که می‌تونید قبل از شروع، اسم فایل رو عوض کنید یا ZIP کردنش رو فعال کنید.";

export function aparatQualityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🎬 Best", callback_data: "quality_best" },
        { text: "1080p", callback_data: "quality_1080p" },
      ],
      [
        { text: "720p", callback_data: "quality_720p" },
        { text: "480p", callback_data: "quality_480p" },
      ],
    ],
  };
}

/**
 * The pre-processing options menu: shown after a link/quality (or a
 * telegram forward) is resolved, before dispatching the actual job.
 * Rename and Zip are togglable and combine freely; Start commits the job
 * with whatever combination is currently active.
 *
 * Note: rename/zip only apply to jobs that actually download a file onto
 * our side (the telegram_download flow, which re-uploads to a Release).
 * The aparat flow only resolves a direct CDN link — nothing is downloaded
 * or re-hosted by us (see "دانلود بدون تغییر/Encode مجدد") — so there's no
 * file to rename or zip, and those options are hidden for that source.
 */
export function jobOptionsKeyboard(session) {
  if (session.source === "aparat") {
    return {
      inline_keyboard: [
        [{ text: "▶️ شروع پردازش", callback_data: "opt_start" }],
        [{ text: "❌ لغو", callback_data: "opt_cancel" }],
      ],
    };
  }

  const renameLabel = session.rename
    ? `✏️ تغییر نام: روشن${session.customName ? ` (${session.customName})` : ""}`
    : "✏️ تغییر نام: خاموش";
  const zipLabel = session.zip ? "📦 ZIP: روشن" : "📦 ZIP: خاموش";

  return {
    inline_keyboard: [
      [{ text: renameLabel, callback_data: "opt_toggle_rename" }],
      [{ text: zipLabel, callback_data: "opt_toggle_zip" }],
      [{ text: "▶️ شروع پردازش", callback_data: "opt_start" }],
      [{ text: "❌ لغو", callback_data: "opt_cancel" }],
    ],
  };
}

export function jobOptionsSummaryText(session) {
  const lines = [];

  if (session.source === "aparat") {
    lines.push("🎬 منبع: آپارات");
    lines.push(`📊 کیفیت: ${session.quality || "best"}`);
    lines.push("");
    lines.push("برای این منبع فقط لینک مستقیم دریافت می‌شه (بدون دانلود/تغییر روی سرور ما).");
  } else {
    lines.push("↪️ منبع: تلگرام");
    lines.push("");
    lines.push("گزینه‌های زیر رو می‌تونید ترکیب کنید، بعد «شروع پردازش» رو بزنید:");
  }

  return lines.join("\n");
}
