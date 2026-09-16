// worker/telegram/menus.js
//
// All inline-keyboard / menu definitions live here, separate from the
// handler logic that reacts to them (handlers.js) and the session state
// they operate on (state/session.js). Keeping menu *shape* separate from
// menu *behaviour* makes it easy to add new options later (rename, zip,
// and future ones) without hunting through handler code.

export const MAIN_MENU_TEXT =
  "👋 سلام! به ربات دانلود تلگرام خوش اومدید.\n\n" +
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
  "• لینک پیام عمومی تلگرام: https://t.me/channel/123\n" +
  "• فوروارد یک پیام حاوی فایل از کانال/گروه عمومی\n" +
  "• لینک مستقیم http/https به یک فایل (مثلاً از یک سایت دیگه)\n\n" +
  "بعد از شناسایی، یک منو براتون میاد که می‌تونید قبل از شروع، اسم فایل رو عوض کنید یا ZIP کردنش رو فعال کنید.\n\n" +
  "⚠️ برای کاربران عادی، حجم لینک مستقیم حداکثر ۲ گیگابایت مجازه.";

/**
 * The pre-processing options menu: shown after a telegram link/forward is
 * resolved, before dispatching the actual job. Rename and Zip are togglable
 * and combine freely; Start commits the job with whatever combination is
 * currently active.
 */
export function jobOptionsKeyboard(session) {
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
  if (session && session.source === "direct_url") {
    const sizeLine = session.knownSize ? `\n📦 حجم: ${formatBytesShort(session.knownSize)}` : "";
    const nameLine = session.detectedName ? `\n📄 نام: ${session.detectedName}` : "";
    return (
      `🔗 منبع: لینک مستقیم${nameLine}${sizeLine}\n\n` +
      "گزینه‌های زیر رو می‌تونید ترکیب کنید، بعد «شروع پردازش» رو بزنید:"
    );
  }

  return "↪️ منبع: تلگرام\n\n" + "گزینه‌های زیر رو می‌تونید ترکیب کنید، بعد «شروع پردازش» رو بزنید:";
}

/**
 * Shown alongside the progress message once a job has been dispatched.
 * Cancel is always offered — see handlers.js handleCancelJob for what
 * happens if the run id hasn't been located yet.
 */
export function progressKeyboard() {
  return {
    inline_keyboard: [[{ text: "⛔ لغو دانلود", callback_data: "job_cancel" }]],
  };
}

/**
 * A single "back to main menu" row, appended after terminal messages
 * (success/failure/cancelled) so the user is never stuck without a menu —
 * they don't have to remember /menu or retype /start.
 */
export function backToMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: "🔙 بازگشت به منو", callback_data: "menu_main" }]],
  };
}

// ---------------------------------------------------------------------------
// History menu

const SOURCE_ICON = { telegram: "↪️", direct_url: "🔗" };

/**
 * Admin landing screen before picking whose history to view — own history
 * stays separate from other users' by default so one admin's personal
 * downloads aren't mixed in with (and don't get buried by) a busy user's
 * history. "همه" is still offered as an explicit merged view when the
 * admin actually wants the combined picture.
 */
export function historyScopeText() {
  return "🕘 تاریخچه‌ی کدوم رو می‌خواید ببینید؟";
}

export function historyScopeKeyboard(users) {
  const rows = [[{ text: "👤 تاریخچه‌ی خودم", callback_data: "hist_scope_self" }]];
  for (const u of users) {
    rows.push([{ text: `👥 کاربر ${u.id}`, callback_data: `hist_scope_user_${u.id}` }]);
  }
  if (users.length > 0) {
    rows.push([{ text: "📋 همه (ترکیبی)", callback_data: "hist_scope_all" }]);
  }
  rows.push([{ text: "🔙 بازگشت", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

export function historyListText(entries, { isAdminView, scopeLabel } = {}) {
  if (entries.length === 0) {
    return scopeLabel ? `🕘 تاریخچه‌ی ${scopeLabel} خالیه.` : "🕘 هنوز هیچ فایلی در تاریخچه نیست.";
  }

  const lines = [scopeLabel ? `🕘 تاریخچه‌ی ${scopeLabel}:` : "🕘 تاریخچه:", ""];

  entries.forEach((e, i) => {
    const icon = SOURCE_ICON[e.source] || "📄";
    const date = new Date(e.createdAt).toLocaleDateString("fa-IR");
    const sizeLabel = e.fileSize ? ` — ${formatBytesShort(e.fileSize)}` : "";
    const ownerLabel = isAdminView && e.ownerId ? ` (کاربر ${e.ownerId})` : "";
    lines.push(`${i + 1}. ${icon} ${e.fileName || "بدون‌نام"}${sizeLabel} — ${date}${ownerLabel}`);
  });

  return lines.join("\n");
}

/**
 * One row per entry (copy-link + delete), so the list stays usable even
 * with many entries. Telegram caps callback_data at 64 bytes, so we key
 * off the short history entry id, never the full link/name. The delete
 * button works the same way whether the admin is looking at their own
 * history or someone else's — see handlers.js handleHistoryDelete, which
 * resolves the entry against whichever user id owns it.
 */
export function historyKeyboard(entries, { backCallback } = {}) {
  const rows = entries.map((e, i) => [
    { text: `🔗 ${i + 1}`, callback_data: `hist_link_${e.id}` },
    { text: "🗑", callback_data: `hist_del_${e.id}` },
  ]);
  rows.push([{ text: "🔙 بازگشت", callback_data: backCallback || "menu_history" }]);
  return { inline_keyboard: rows };
}

function formatBytesShort(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

// ---------------------------------------------------------------------------
// Settings menu (admin-only bits are added conditionally by the caller)

export function settingsText({ isAdmin, allowedUserCount }) {
  if (!isAdmin) {
    return "⚙️ تنظیمات";
  }
  return (
    "⚙️ تنظیمات (ادمین)\n\n" + `👥 تعداد کاربران مجاز (غیر از شما): ${allowedUserCount}`
  );
}

export function settingsKeyboard({ isAdmin }) {
  const rows = [];
  if (isAdmin) {
    rows.push([{ text: "➕ افزودن کاربر", callback_data: "settings_add_user" }]);
    rows.push([{ text: "➖ حذف کاربر", callback_data: "settings_remove_user" }]);
    rows.push([{ text: "👥 لیست کاربران", callback_data: "settings_list_users" }]);
  }
  rows.push([{ text: "🔙 بازگشت", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

export function userListText(users) {
  if (users.length === 0) return "👥 هیچ کاربر دیگری اضافه نشده.";
  const lines = ["👥 کاربران مجاز:", ""];
  users.forEach((u, i) => {
    const date = new Date(u.addedAt).toLocaleDateString("fa-IR");
    lines.push(`${i + 1}. ${u.id} — افزوده‌شده در ${date}`);
  });
  return lines.join("\n");
}
