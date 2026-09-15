// worker/telegram/handlers.js
//
// Core message/callback routing. Each handler is small and delegates to
// the specialised modules (forward detection, github dispatch, session
// state, menus). This file owns the *flow* between those pieces:
//
//   telegram link/forward recognised
//     -> job options menu (rename / zip, combinable)
//     -> confirm start -> dispatch to GitHub Actions
//
// See state/session.js for how a job's in-progress configuration survives
// across multiple button taps (Workers have no memory between requests).

import { sendMessage, editMessageText, answerCallbackQuery } from "./client.js";
import { detectForward, detectMedia, mediaLabelFa, sourceLabelFa } from "./forward.js";
import { isDirectUrl, maxAllowedBytes, probeDirectUrl } from "./directUrl.js";
import { triggerTelegramDownload, triggerDirectUrlDownload } from "../github/dispatch.js";
import { createSession, getSession, updateSession, clearSession } from "../state/session.js";
import { isAdmin, isAuthorized as isAllowedUser, addUser, removeUser, listUsers } from "../state/users.js";
import { getHistory, removeHistoryEntry, getHistoryEntry } from "../state/history.js";
import {
  MAIN_MENU_TEXT,
  mainMenuKeyboard,
  HELP_TEXT,
  jobOptionsKeyboard,
  jobOptionsSummaryText,
  historyListText,
  historyKeyboard,
  settingsText,
  settingsKeyboard,
  userListText,
} from "./menus.js";

const TELEGRAM_LINK_RE = /^https?:\/\/t\.me\/[^/\s]+\/\d+(?:\?.*)?$/;

function isAuthorized(userId, env) {
  return isAllowedUser(userId, env);
}

export async function handleMessage(message, env) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();

  if (!(await isAuthorized(userId, env))) {
    await sendMessage(env, chatId, "❌ شما دسترسی ندارید");
    return;
  }

  // If we're waiting for a custom filename, any plain text message here is
  // the answer, not a new command — handle it and stop, regardless of what
  // it looks like.
  const existingSession = await getSession(env, userId);
  if (existingSession && existingSession.stage === "awaiting_name" && text) {
    await handleCustomNameReply(env, userId, chatId, text, existingSession);
    return;
  }

  // Admin flows that expect a plain-text reply (user id to add/remove).
  // These are gated on isAdmin, not just isAuthorized — a regular user
  // typing a number here should fall through to normal message handling.
  if (isAdmin(userId, env) && existingSession && existingSession.stage === "awaiting_add_user_id" && text) {
    await handleAddUserReply(env, userId, chatId, text);
    return;
  }
  if (isAdmin(userId, env) && existingSession && existingSession.stage === "awaiting_remove_user_id" && text) {
    await handleRemoveUserReply(env, userId, chatId, text);
    return;
  }

  // Forwarded message: check this before plain text routing, since a
  // forwarded message might carry media with no text/caption at all.
  const forward = detectForward(message);
  if (forward.isForwarded) {
    await handleForwardedMessage(message, forward, env, userId, chatId);
    return;
  }

  if (text === "/start" || text === "/menu") {
    await sendMessage(env, chatId, MAIN_MENU_TEXT, mainMenuKeyboard());
    return;
  }

  if (text.includes("t.me/")) {
    await handleTelegramLink(text, env, userId, chatId);
    return;
  }

  if (isDirectUrl(text)) {
    await handleDirectUrlLink(text, env, userId, chatId);
    return;
  }

  await sendMessage(env, chatId, "❓ متوجه نشدم. از /menu برای راهنما استفاده کنید.");
}

async function handleTelegramLink(link, env, userId, chatId) {
  if (!TELEGRAM_LINK_RE.test(link)) {
    await sendMessage(
      env,
      chatId,
      "❌ لینک پیام تلگرام نامعتبره.\n\n" + "مثال:\n" + "https://t.me/channel/123"
    );
    return;
  }

  const session = await createSession(env, userId, { source: "telegram", link, stage: "menu" });
  await sendMessage(env, chatId, jobOptionsSummaryText(session), jobOptionsKeyboard(session));
}

async function handleDirectUrlLink(link, env, userId, chatId) {
  const admin = isAdmin(userId, env);
  const cap = maxAllowedBytes(admin);

  const probe = await probeDirectUrl(link);

  if (!probe.ok) {
    await sendMessage(env, chatId, `❌ این لینک قابل دسترسی نیست.\n${probe.error || ""}`);
    return;
  }

  if (cap && probe.size && probe.size > cap) {
    await sendMessage(
      env,
      chatId,
      `❌ حجم فایل (${formatBytes(probe.size)}) بیشتر از سقف مجاز شما (${formatBytes(cap)}) هست.`
    );
    return;
  }

  const session = await createSession(env, userId, {
    source: "direct_url",
    link,
    stage: "menu",
    knownSize: probe.size,
    detectedName: probe.fileName,
  });
  await sendMessage(env, chatId, jobOptionsSummaryText(session), jobOptionsKeyboard(session));
}

/**
 * A forwarded message may or may not carry media, and may or may not come
 * from a source we can build a public t.me link for. We report what we
 * found, and only open the job-options menu when we have a usable public link.
 */
async function handleForwardedMessage(message, forward, env, userId, chatId) {
  const media = detectMedia(message);

  const sourceLine = forward.sourceName
    ? `${sourceLabelFa(forward.sourceType)}: ${forward.sourceName}`
    : sourceLabelFa(forward.sourceType);

  if (!media.hasMedia) {
    // Forwarded, but no file in it — nothing to download, just acknowledge.
    await sendMessage(env, chatId, `↪️ پیام فوروارد شده (${sourceLine}) — فایلی توش پیدا نشد.`);
    return;
  }

  const sizeLine = media.fileSize ? `\n📦 حجم: ${formatBytes(media.fileSize)}` : "";
  const nameLine = media.fileName ? `\n📄 نام: ${media.fileName}` : "";

  if (forward.publicLink) {
    await sendMessage(
      env,
      chatId,
      `↪️ پیام فوروارد شده از ${sourceLine}\n` +
        `🎞 نوع: ${mediaLabelFa(media.type)}${nameLine}${sizeLine}\n\n` +
        `🔗 لینک شناسایی شد.`
    );

    const session = await createSession(env, userId, {
      source: "telegram",
      link: forward.publicLink,
      stage: "menu",
    });
    await sendMessage(env, chatId, jobOptionsSummaryText(session), jobOptionsKeyboard(session));
    return;
  }

  // We know it has media, we know the source, but we can't build a public
  // link (private chat, private group, or a channel with no @username) —
  // tdl can't fetch it through the link-based flow in that case.
  await sendMessage(
    env,
    chatId,
    `↪️ پیام فوروارد شده از ${sourceLine}\n` +
      `🎞 نوع: ${mediaLabelFa(media.type)}${nameLine}${sizeLine}\n\n` +
      `⚠️ چون منبع عمومی (با یوزرنیم) نیست، امکان دانلود خودکار وجود نداره.`
  );
}

async function handleCustomNameReply(env, userId, chatId, name, session) {
  const cleaned = sanitizeFileName(name);

  if (!cleaned) {
    await sendMessage(env, chatId, "❌ نام نامعتبره. یه نام دیگه بفرستید.");
    return;
  }

  const updated = await updateSession(env, userId, {
    customName: cleaned,
    stage: "menu",
  });

  await sendMessage(env, chatId, `✏️ نام تنظیم شد: ${cleaned}\n\n${jobOptionsSummaryText(updated)}`, jobOptionsKeyboard(updated));
}

function sanitizeFileName(raw) {
  // Strip characters that are unsafe in filenames across common filesystems,
  // collapse whitespace, and cap the length so it stays reasonable.
  const stripped = raw.replace(/[\/\\:*?"<>|]/g, "").trim();
  if (!stripped) return null;
  return stripped.slice(0, 100);
}

async function handleAddUserReply(env, adminUserId, chatId, text) {
  const targetId = parseUserId(text);

  if (!targetId) {
    await sendMessage(env, chatId, "❌ این یک آیدی عددی معتبر نیست. یک آیدی عددی تلگرام بفرستید.");
    return;
  }

  await clearSession(env, adminUserId);

  const result = await addUser(env, targetId);

  if (result.isAdmin) {
    await sendMessage(env, chatId, "ℹ️ این آیدی همون خود شما (ادمین) هست، نیازی به افزودن نداره.");
    return;
  }
  if (!result.added) {
    await sendMessage(env, chatId, `ℹ️ کاربر ${targetId} از قبل مجاز بود.`);
    return;
  }

  await sendMessage(env, chatId, `✅ کاربر ${targetId} اضافه شد و حالا می‌تونه از ربات استفاده کنه.`);
}

async function handleRemoveUserReply(env, adminUserId, chatId, text) {
  const targetId = parseUserId(text);

  if (!targetId) {
    await sendMessage(env, chatId, "❌ این یک آیدی عددی معتبر نیست. یک آیدی عددی تلگرام بفرستید.");
    return;
  }

  await clearSession(env, adminUserId);

  const removed = await removeUser(env, targetId);
  await sendMessage(
    env,
    chatId,
    removed ? `✅ کاربر ${targetId} حذف شد.` : `ℹ️ کاربر ${targetId} در لیست مجازها پیدا نشد.`
  );
}

function parseUserId(text) {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

export async function handleCallback(callback, env) {
  const userId = callback.from.id;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const data = callback.data;

  if (!(await isAuthorized(userId, env))) {
    await answerCallbackQuery(env, callback.id, "❌ دسترسی ندارید", true);
    return;
  }

  if (data === "menu_main") {
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, MAIN_MENU_TEXT, mainMenuKeyboard());
    return;
  }

  if (data === "menu_help") {
    await answerCallbackQuery(env, callback.id);
    await sendMessage(env, chatId, HELP_TEXT);
    return;
  }

  if (data === "menu_history") {
    await answerCallbackQuery(env, callback.id);
    await showHistory(env, userId, chatId, messageId);
    return;
  }

  if (data.startsWith("hist_link_")) {
    await handleHistoryLink(env, callback, userId, chatId, data);
    return;
  }

  if (data.startsWith("hist_del_")) {
    await handleHistoryDelete(env, callback, userId, chatId, messageId, data);
    return;
  }

  if (data === "menu_settings") {
    await answerCallbackQuery(env, callback.id);
    await showSettings(env, userId, chatId, messageId);
    return;
  }

  if (data === "settings_add_user") {
    await handleSettingsAddUser(env, callback, userId, chatId, messageId);
    return;
  }

  if (data === "settings_remove_user") {
    await handleSettingsRemoveUser(env, callback, userId, chatId, messageId);
    return;
  }

  if (data === "settings_list_users") {
    await handleSettingsListUsers(env, callback, userId, chatId);
    return;
  }

  if (data.startsWith("opt_")) {
    await handleJobOption(env, callback, userId, chatId, messageId, data);
    return;
  }

  await answerCallbackQuery(env, callback.id);
}

// ---------------------------------------------------------------------------
// History

async function showHistory(env, userId, chatId, messageId) {
  const admin = isAdmin(userId, env);
  const entries = admin ? await getAllHistoryForAdmin(env) : await getHistory(env, userId);

  await editMessageText(
    env,
    chatId,
    messageId,
    historyListText(entries, { isAdminView: admin }),
    historyKeyboard(entries)
  );
}

/**
 * Admin sees everyone's history merged, newest first. Regular users never
 * hit this path — see showHistory. This walks the allow-list plus the
 * admin's own id; it's fine for the expected scale of a personal bot (a
 * handful of users), not meant for hundreds.
 */
async function getAllHistoryForAdmin(env) {
  const users = await listUsers(env);
  const allIds = [env.USER_ID, ...users.map((u) => u.id)];

  const perUser = await Promise.all(
    allIds.map(async (id) => {
      const entries = await getHistory(env, id);
      return entries.map((e) => ({ ...e, ownerId: id }));
    })
  );

  return perUser
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}

async function handleHistoryLink(env, callback, userId, chatId, data) {
  const entryId = data.replace("hist_link_", "");
  const admin = isAdmin(userId, env);

  // Admin can open any entry (it was rendered from the merged list above);
  // regular users can only ever see/open their own, since getHistoryEntry
  // is scoped to their own userId.
  const entry = admin
    ? await findEntryAnyUser(env, entryId)
    : await getHistoryEntry(env, userId, entryId);

  if (!entry) {
    await answerCallbackQuery(env, callback.id, "❌ پیدا نشد", true);
    return;
  }

  await answerCallbackQuery(env, callback.id);
  await sendMessage(env, chatId, entry.link);
}

async function handleHistoryDelete(env, callback, userId, chatId, messageId, data) {
  const entryId = data.replace("hist_del_", "");
  const admin = isAdmin(userId, env);

  const removed = admin
    ? await removeEntryAnyUser(env, entryId)
    : await removeHistoryEntry(env, userId, entryId);

  if (!removed) {
    await answerCallbackQuery(env, callback.id, "❌ پیدا نشد", true);
    return;
  }

  await answerCallbackQuery(env, callback.id, "🗑 حذف شد");
  await showHistory(env, userId, chatId, messageId);
}

async function findEntryAnyUser(env, entryId) {
  const users = await listUsers(env);
  const allIds = [env.USER_ID, ...users.map((u) => u.id)];
  for (const id of allIds) {
    const entry = await getHistoryEntry(env, id, entryId);
    if (entry) return entry;
  }
  return null;
}

async function removeEntryAnyUser(env, entryId) {
  const users = await listUsers(env);
  const allIds = [env.USER_ID, ...users.map((u) => u.id)];
  for (const id of allIds) {
    const removed = await removeHistoryEntry(env, id, entryId);
    if (removed) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Settings (admin-only actions gated inside each handler, not just the menu)

async function showSettings(env, userId, chatId, messageId) {
  const admin = isAdmin(userId, env);
  const users = admin ? await listUsers(env) : [];

  await editMessageText(
    env,
    chatId,
    messageId,
    settingsText({ isAdmin: admin, allowedUserCount: users.length }),
    settingsKeyboard({ isAdmin: admin })
  );
}

async function handleSettingsAddUser(env, callback, userId, chatId, messageId) {
  if (!isAdmin(userId, env)) {
    await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
    return;
  }

  // Reuse the session scratchpad purely as a "what am I waiting for next"
  // flag — this isn't a job configuration, just a one-shot text prompt.
  await createSession(env, userId, { source: "admin_flow", link: "", stage: "awaiting_add_user_id" });

  await answerCallbackQuery(env, callback.id);
  await editMessageText(env, chatId, messageId, "➕ آیدی عددی تلگرام کاربر جدید رو بفرستید:");
}

async function handleSettingsRemoveUser(env, callback, userId, chatId, messageId) {
  if (!isAdmin(userId, env)) {
    await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
    return;
  }

  await createSession(env, userId, { source: "admin_flow", link: "", stage: "awaiting_remove_user_id" });

  await answerCallbackQuery(env, callback.id);
  await editMessageText(env, chatId, messageId, "➖ آیدی عددی کاربری که می‌خواید حذف کنید رو بفرستید:");
}

async function handleSettingsListUsers(env, callback, userId, chatId) {
  if (!isAdmin(userId, env)) {
    await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
    return;
  }

  await answerCallbackQuery(env, callback.id);
  const users = await listUsers(env);
  await sendMessage(env, chatId, userListText(users));
}

async function handleJobOption(env, callback, userId, chatId, messageId, data) {
  const session = await getSession(env, userId);

  if (!session) {
    await answerCallbackQuery(env, callback.id, "❌ این درخواست منقضی شده", true);
    return;
  }

  if (data === "opt_cancel") {
    await clearSession(env, userId);
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, "❌ لغو شد.");
    return;
  }

  if (data === "opt_toggle_zip") {
    const updated = await updateSession(env, userId, { zip: !session.zip });
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, jobOptionsSummaryText(updated), jobOptionsKeyboard(updated));
    return;
  }

  if (data === "opt_toggle_rename") {
    if (session.rename) {
      // Turning rename off again — just clear the flag and name.
      const updated = await updateSession(env, userId, { rename: false, customName: null });
      await answerCallbackQuery(env, callback.id);
      await editMessageText(env, chatId, messageId, jobOptionsSummaryText(updated), jobOptionsKeyboard(updated));
      return;
    }

    // Turning rename on — ask for the name as a normal text reply.
    await updateSession(env, userId, { rename: true, stage: "awaiting_name" });
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, "✏️ نام جدید فایل رو بفرستید (بدون پسوند):");
    return;
  }

  if (data === "opt_start") {
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, "⏳ در حال پردازش...");
    await startJob(env, userId, chatId, session);
    return;
  }

  await answerCallbackQuery(env, callback.id);
}

async function startJob(env, userId, chatId, session) {
  const options = { zip: session.zip, customName: session.customName };
  const ok =
    session.source === "direct_url"
      ? await triggerDirectUrlDownload(env, session.link, chatId, options)
      : await triggerTelegramDownload(env, session.link, chatId, options);

  await clearSession(env, userId);

  if (ok) {
    await sendMessage(
      env,
      chatId,
      "✅ درخواست ارسال شد!\n" + "⏳ اسکریپت در حال اجرا است...\n\n" + "نتیجه تو چند دقیقه می‌ره"
    );
  } else {
    await sendMessage(env, chatId, "❌ خطا در ارسال درخواست به گیت‌هاب");
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
