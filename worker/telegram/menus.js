// worker/telegram/menus.js
//
// All inline-keyboard / menu definitions live here, separate from the
// handler logic that reacts to them (handlers.js) and the session state
// they operate on (state/session.js). Keeping menu *shape* separate from
// menu *behaviour* makes it easy to add new options later (rename, zip,
// and future ones) without hunting through handler code.

import { getProvider } from "../state/storageProviders.js";

export const MAIN_MENU_TEXT =
  "👋 سلام! به ربات دانلود تلگرام خوش اومدید.\n\n" +
  "چیکار می‌خواید بکنید؟";

/**
 * Shown when someone who isn't the admin and isn't on the allow-list sends
 * /start or /menu. Deliberately never reveals the admin's own numeric id —
 * just tells the person how to find their own id and that they need to
 * coordinate with whoever owns the bot to get added.
 */
export const UNAUTHORIZED_TEXT =
  "🚫 شما هنوز به این ربات دسترسی ندارید.\n\n" +
  "برای دسترسی:\n" +
  "1. آیدی عددی تلگرام خودتون رو از @userinfobot بگیرید\n" +
  "2. آیدی رو برای صاحب ربات ارسال کنید تا شما رو اضافه کنه\n\n" +
  "بعد از اضافه شدن، دوباره /start رو بزنید.";

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
  "بعد از شناسایی، یک منو براتون میاد که می‌تونید قبل از شروع، اسم فایل رو عوض کنید، ZIP کردنش رو فعال کنید، یا محل ذخیره (داخلی/خارجی) رو انتخاب کنید.\n\n" +
  "💾 محل ذخیره:\n" +
  "🇮🇷 داخلی — آپلود روی فضای ابری داخلی (آروان‌کلاد)، معمولاً سریع‌تر ولی سهمیه محدود.\n" +
  "🌍 خارجی — روش پیش‌فرض (GitHub Release).\n\n" +
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
  const storageLabel =
    session.storage === "internal" ? "💾 محل ذخیره: 🇮🇷 داخلی (نیم‌بها)" : "💾 محل ذخیره: 🌍 خارجی";

  return {
    inline_keyboard: [
      [{ text: renameLabel, callback_data: "opt_toggle_rename" }],
      [{ text: zipLabel, callback_data: "opt_toggle_zip" }],
      [{ text: storageLabel, callback_data: "opt_toggle_storage" }],
      [{ text: "▶️ شروع پردازش", callback_data: "opt_start" }],
      [{ text: "❌ لغو", callback_data: "opt_cancel" }],
    ],
  };
}

export function jobOptionsSummaryText(session) {
  const storageLine =
    session && session.storage === "internal"
      ? "\n💾 محل ذخیره: 🇮🇷 داخلی (نیم‌بها)"
      : "\n💾 محل ذخیره: 🌍 خارجی";

  if (session && session.source === "direct_url") {
    const sizeLine = session.knownSize ? `\n📦 حجم: ${formatBytesShort(session.knownSize)}` : "";
    const nameLine = session.detectedName ? `\n📄 نام: ${session.detectedName}` : "";
    return (
      `🔗 منبع: لینک مستقیم${nameLine}${sizeLine}${storageLine}\n\n` +
      "گزینه‌های زیر رو می‌تونید ترکیب کنید، بعد «شروع پردازش» رو بزنید:"
    );
  }

  return "↪️ منبع: تلگرام" + storageLine + "\n\n" + "گزینه‌های زیر رو می‌تونید ترکیب کنید، بعد «شروع پردازش» رو بزنید:";
}

/**
 * Shown once, the first time a job would try to use "داخلی" storage while
 * the internal quota (or a hard failure) blocks it — explains the two
 * storage options in plain terms so the toggle in jobOptionsKeyboard isn't
 * the only place this is explained.
 */
export const STORAGE_CHOICE_HELP_TEXT =
  "💾 محل ذخیره:\n\n" +
  "🇮🇷 داخلی (نیم‌بها) — آپلود روی فضای ابری داخل ایران (آروان‌کلاد). سریع‌تره ولی سهمیه محدود داره.\n" +
  "🌍 خارجی — همون روش فعلی (GitHub Release). سهمیه جداگانه، معمولاً نامحدود مگراینکه ادمین محدودش کرده باشه.";

/**
 * Shown when the chosen internal provider's upload actually fails at run
 * time (see actions/common/storage_upload.py) — offers three ways forward,
 * per the handoff spec: retry the same provider, fall back to GitHub, or
 * give up. callback_data encodes the storage-provider job's correlation
 * via the active-job state, not the callback itself (see handlers.js
 * handleStorageFailureChoice), so this keyboard stays static.
 */
export function storageFailureKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔁 تلاش مجدد (داخلی)", callback_data: "storage_fail_retry" }],
      [{ text: "☁️ آپلود به GitHub", callback_data: "storage_fail_fallback_github" }],
      [{ text: "❌ لغو", callback_data: "storage_fail_cancel" }],
    ],
  };
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
    rows.push([{ text: "🔑 کلید آروان (ادمین)", callback_data: "settings_admin_key" }]);
    rows.push([{ text: "📊 سهمیه کاربران", callback_data: "settings_quotas" }]);
  } else {
    rows.push([{ text: "🔑 کلید آروان شخصی من", callback_data: "settings_my_key" }]);
    rows.push([{ text: "📊 وضعیت سهمیه من", callback_data: "settings_my_quota" }]);
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

// ---------------------------------------------------------------------------
// Personal / admin provider-key management
//
// Keys are collected one field at a time (access key -> secret key ->
// bucket) via plain text replies, tracked through
// session.pendingKeyField/collectedKeyParts — see handlers.js
// handleProviderKeyReply. This keeps each prompt short and unambiguous
// rather than asking the user to paste three values in one message.

export function providerKeyStatusText(provider, record, { isAdmin } = {}) {
  const fields = providerKeyFieldNames(provider.id);
  const hasKey = !!(record[fields.accessKey] && record[fields.secretKey]);

  const who = isAdmin ? "ادمین" : "شما";
  const lines = [`🔑 کلید ${provider.label} (${who})`, ""];

  if (hasKey) {
    lines.push(`✅ کلید ثبت شده.`);
    lines.push(`📦 Bucket: ${record[fields.bucket] || provider.defaultBucket || "—"}`);
    if (record[fields.endpoint]) lines.push(`🌐 Endpoint سفارشی: ${record[fields.endpoint]}`);
  } else {
    lines.push("❌ هنوز کلیدی ثبت نشده.");
    if (!isAdmin) {
      lines.push("");
      lines.push("در صورت نبود کلید شخصی، از کلید و سهمیه‌ی ادمین استفاده می‌شه.");
    }
  }

  return lines.join("\n");
}

export function providerKeyKeyboard(provider, { hasKey, backCallback } = {}) {
  const rows = [[{ text: "✏️ ثبت / ویرایش کلید", callback_data: `key_set_${provider.id}` }]];
  if (hasKey) {
    rows.push([{ text: "🗑 حذف کلید", callback_data: `key_del_${provider.id}` }]);
  }
  rows.push([{ text: "📖 راهنمای گرفتن کلید", callback_data: `key_guide_${provider.id}` }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: backCallback || "menu_settings" }]);
  return { inline_keyboard: rows };
}

export function providerKeyGuideText(provider) {
  return provider.keyGuideTextFa || `برای گرفتن کلید ${provider.label} به پنل مربوطه مراجعه کنید.`;
}

const KEY_FIELD_PROMPTS_FA = {
  access: "🔑 Access Key رو بفرستید:",
  secret: "🔐 Secret Key رو بفرستید:",
  bucket: "📦 نام Bucket رو بفرستید (یا برای استفاده از پیش‌فرض، فقط - بفرستید):",
};

export function keyFieldPromptText(field) {
  return KEY_FIELD_PROMPTS_FA[field] || "مقدار رو بفرستید:";
}

function providerKeyFieldNames(providerId) {
  return {
    accessKey: `${providerId}AccessKey`,
    secretKey: `${providerId}SecretKey`,
    endpoint: `${providerId}Endpoint`,
    bucket: `${providerId}Bucket`,
  };
}

// ---------------------------------------------------------------------------
// Quota management (admin-only)

export function quotaUserListKeyboard(users) {
  const rows = users.map((u) => [{ text: `👥 کاربر ${u.id}`, callback_data: `quota_user_${u.id}` }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "menu_settings" }]);
  return { inline_keyboard: rows };
}

export function quotaUserListText(users) {
  if (users.length === 0) return "👥 هیچ کاربری برای تنظیم سهمیه وجود نداره.";
  return "📊 سهمیه‌ی کدوم کاربر رو می‌خواید تنظیم کنید؟";
}

export function quotaStatusText(userId, record, { isAdmin } = {}) {
  const who = isAdmin ? `کاربر ${userId}` : "شما";
  const lines = [`📊 وضعیت سهمیه‌ی ${who}`, ""];

  lines.push(formatQuotaLine("🇮🇷 داخلی", record.internalUsedBytes, record.internalQuotaBytes));
  lines.push(formatQuotaLine("🌍 خارجی", record.externalUsedBytes, record.externalQuotaBytes));

  if (record.quotaResetAt) {
    const resetDate = new Date(record.quotaResetAt).toLocaleDateString("fa-IR");
    lines.push("");
    lines.push(`🔄 ریست بعدی: ${resetDate}`);
  }

  return lines.join("\n");
}

function formatQuotaLine(label, used, quota) {
  const usedLabel = formatBytesShort(used || 0);
  if (quota === null || quota === undefined) {
    return `${label}: ${usedLabel} / نامحدود`;
  }
  return `${label}: ${usedLabel} / ${formatBytesShort(quota)}`;
}

export function quotaEditKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: "🇮🇷 تنظیم سهمیه داخلی", callback_data: `quota_edit_internal_${userId}` }],
      [{ text: "🌍 تنظیم سهمیه خارجی", callback_data: `quota_edit_external_${userId}` }],
      [{ text: "🔙 بازگشت", callback_data: "settings_quotas" }],
    ],
  };
}

export function quotaEditPromptText(kind) {
  const label = kind === "internal" ? "داخلی" : "خارجی";
  return (
    `📊 سقف سهمیه‌ی ${label} رو به گیگابایت بفرستید (مثلاً 50).\n` +
    "برای نامحدود کردن، عدد 0 رو بفرستید."
  );
}
