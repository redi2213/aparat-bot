// worker/telegram/handlers.js
//
// Core message/callback routing. Each handler is small and delegates to
// the specialised modules (forward detection, github dispatch, session
// state, menus). This file owns the *flow* between those pieces:
//
//   link/forward recognised
//     -> (aparat only) pick quality
//     -> job options menu (rename / zip, combinable)
//     -> confirm start -> dispatch to GitHub Actions
//
// See state/session.js for how a job's in-progress configuration survives
// across multiple button taps (Workers have no memory between requests).

import { sendMessage, editMessageText, answerCallbackQuery } from "./client.js";
import { detectForward, detectMedia, mediaLabelFa, sourceLabelFa } from "./forward.js";
import { triggerAparatDownload, triggerTelegramDownload } from "../github/dispatch.js";
import { createSession, getSession, updateSession, clearSession } from "../state/session.js";
import {
  MAIN_MENU_TEXT,
  mainMenuKeyboard,
  HELP_TEXT,
  aparatQualityKeyboard,
  jobOptionsKeyboard,
  jobOptionsSummaryText,
} from "./menus.js";

const TELEGRAM_LINK_RE = /^https?:\/\/t\.me\/[^/\s]+\/\d+(?:\?.*)?$/;

function isAuthorized(userId, env) {
  return String(userId) === String(env.USER_ID);
}

export async function handleMessage(message, env) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();

  if (!isAuthorized(userId, env)) {
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

  if (text.includes("aparat.com")) {
    await handleAparatLink(text, env, userId, chatId);
    return;
  }

  if (text.includes("t.me/")) {
    await handleTelegramLink(text, env, userId, chatId);
    return;
  }

  await sendMessage(env, chatId, "❓ متوجه نشدم. از /menu برای راهنما استفاده کنید.");
}

async function handleAparatLink(link, env, userId, chatId) {
  if (!link.includes("/playlist/") && !link.includes("/v/")) {
    await sendMessage(env, chatId, "❌ لینک نامعتبره. لینک صحیح بفرستید.");
    return;
  }

  // Quality has to be picked before the session is fully "ready", so we
  // stash just the link+source here; quality gets filled in once the user
  // taps a quality_* button (see handleCallback).
  await createSession(env, userId, { source: "aparat", link, stage: "picking_quality" });

  await sendMessage(env, chatId, "⬇️ کیفیت رو انتخاب کنید:", aparatQualityKeyboard());
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

export async function handleCallback(callback, env) {
  const userId = callback.from.id;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const data = callback.data;

  if (!isAuthorized(userId, env)) {
    await answerCallbackQuery(env, callback.id, "❌ دسترسی ندارید", true);
    return;
  }

  if (data === "menu_help") {
    await answerCallbackQuery(env, callback.id);
    await sendMessage(env, chatId, HELP_TEXT);
    return;
  }

  if (data === "menu_history") {
    await answerCallbackQuery(env, callback.id);
    await sendMessage(env, chatId, "🕘 تاریخچه فایل‌ها به‌زودی اضافه می‌شه.");
    return;
  }

  if (data === "menu_settings") {
    await answerCallbackQuery(env, callback.id);
    await sendMessage(env, chatId, "⚙️ تنظیمات به‌زودی اضافه می‌شه.");
    return;
  }

  if (data.startsWith("quality_")) {
    await handleQualityPicked(env, callback, userId, chatId, messageId, data);
    return;
  }

  if (data.startsWith("opt_")) {
    await handleJobOption(env, callback, userId, chatId, messageId, data);
    return;
  }

  await answerCallbackQuery(env, callback.id);
}

async function handleQualityPicked(env, callback, userId, chatId, messageId, data) {
  const session = await getSession(env, userId);

  if (!session || session.stage !== "picking_quality") {
    await answerCallbackQuery(env, callback.id, "❌ این درخواست منقضی شده", true);
    return;
  }

  const quality = data.replace("quality_", "");
  const updated = await updateSession(env, userId, { quality, stage: "menu" });

  await answerCallbackQuery(env, callback.id);
  await editMessageText(env, chatId, messageId, jobOptionsSummaryText(updated), jobOptionsKeyboard(updated));
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
    session.source === "aparat"
      ? await triggerAparatDownload(env, session.link, session.quality || "best", chatId, options)
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
