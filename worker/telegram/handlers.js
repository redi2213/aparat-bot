// worker/telegram/handlers.js
//
// Core message/callback routing. Each handler is small and delegates to
// the specialised modules (forward detection, github dispatch, session
// state, menus). This file owns the *flow* between those pieces:
//
//   telegram link/forward recognised
//     -> job options menu (rename / zip / storage, combinable)
//     -> confirm start -> quota check -> dispatch to GitHub Actions
//
// See state/session.js for how a job's in-progress configuration survives
// across multiple button taps (Workers have no memory between requests).
//
// Storage-provider feature (internal/ArvanCloud vs external/GitHub
// Release): the job-options menu gained a third toggle (opt_toggle_storage)
// alongside rename/zip. Personal provider keys and admin/user quotas live
// in state/users.js; the static provider catalog lives in
// state/storageProviders.js. If a GitHub Actions upload to the chosen
// internal provider fails at run time, the Action edits the progress
// message with storageFailureKeyboard(), and handleStorageFailureChoice
// below handles the three follow-up choices (retry / fall back to GitHub /
// cancel).

import { sendMessage, sendMessageGetId, editMessageText, answerCallbackQuery } from "./client.js";
import { detectForward, detectMedia, mediaLabelFa, sourceLabelFa } from "./forward.js";
import { isDirectUrl, maxAllowedBytes, probeDirectUrl } from "./directUrl.js";
import { dispatchGithubEvent, getLatestRunId, findRunIdAfterDispatch, cancelWorkflowRun } from "../github/dispatch.js";
import { createSession, getSession, updateSession, clearSession } from "../state/session.js";
import { setActiveJob, getActiveJob, updateActiveJob, clearActiveJob } from "../state/activeJob.js";
import {
  isAdmin,
  isAuthorized as isAllowedUser,
  addUser,
  removeUser,
  listUsers,
  getUserRecord,
  getAdminRecord,
  updateUserRecord,
  updateAdminRecord,
  setUserQuotas,
  checkQuota,
} from "../state/users.js";
import { getHistory, removeHistoryEntry, getHistoryEntry } from "../state/history.js";
import { getProvider, DEFAULT_INTERNAL_PROVIDER_ID } from "../state/storageProviders.js";
import {
  MAIN_MENU_TEXT,
  mainMenuKeyboard,
  UNAUTHORIZED_TEXT,
  HELP_TEXT,
  jobOptionsKeyboard,
  jobOptionsSummaryText,
  progressKeyboard,
  backToMenuKeyboard,
  historyScopeText,
  historyScopeKeyboard,
  historyListText,
  historyKeyboard,
  settingsText,
  settingsKeyboard,
  userListText,
  providerKeyStatusText,
  providerKeyKeyboard,
  providerKeyGuideText,
  keyFieldPromptText,
  quotaUserListKeyboard,
  quotaUserListText,
  quotaStatusText,
  quotaEditKeyboard,
  quotaEditPromptText,
} from "./menus.js";

// Matches both public message links (t.me/username/123) and private
// group/supergroup/channel message links (t.me/c/chat_id/message_id) —
// the latter is what official Telegram clients give you via "Copy Message
// Link" inside a private group/supergroup the user's account is a member
// of. Note: this format does NOT work for one-on-one private chats (e.g.
// this bot's own chat with the user) — Telegram has no equivalent public
// link for those; see handleForwardedMessage's fallback message for that case.
const TELEGRAM_LINK_RE = /^https?:\/\/t\.me\/(?:c\/\d+\/\d+|[^/\s]+\/\d+)(?:\?.*)?$/;

const GB = 1024 * 1024 * 1024;

function isAuthorized(userId, env) {
  return isAllowedUser(userId, env);
}

export async function handleMessage(message, env, ctx) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();

  if (!(await isAuthorized(userId, env))) {
    if (text === "/start" || text === "/menu") {
      await sendMessage(env, chatId, UNAUTHORIZED_TEXT);
      return;
    }
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

  // Provider-key collection (personal or admin) — one field at a time.
  if (existingSession && existingSession.stage === "awaiting_provider_key" && text) {
    await handleProviderKeyReply(env, userId, chatId, text, existingSession);
    return;
  }

  // Admin quota input (in GB, per the prompt) for a specific user.
  if (isAdmin(userId, env) && existingSession && existingSession.stage === "awaiting_quota_input" && text) {
    await handleQuotaInputReply(env, userId, chatId, text, existingSession);
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

  await sendMessage(env, chatId, "❓ متوجه نشدم. از /menu برای راهنما استفاده کنید.", backToMenuKeyboard());
}

async function handleTelegramLink(link, env, userId, chatId) {
  if (!TELEGRAM_LINK_RE.test(link)) {
    await sendMessage(
      env,
      chatId,
      "❌ لینک پیام تلگرام نامعتبره.\n\n" + "مثال:\n" + "https://t.me/channel/123",
      backToMenuKeyboard()
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
    await sendMessage(env, chatId, `❌ این لینک قابل دسترسی نیست.\n${probe.error || ""}`, backToMenuKeyboard());
    return;
  }

  if (cap && probe.size && probe.size > cap) {
    await sendMessage(
      env,
      chatId,
      `❌ حجم فایل (${formatBytes(probe.size)}) بیشتر از سقف مجاز شما (${formatBytes(cap)}) هست.`,
      backToMenuKeyboard()
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
 * from a source we can build a public t.me link for.
 *
 * When we can't (private chat, private group, or a channel with no
 * @username), we don't give up: chatId/message.message_id here are this
 * bot's own Bot-API-scoped ids for the message it just received, and the
 * Action fetches it straight back over MTProto logged in *as the bot
 * itself* (see actions/telegram_download/download.py,
 * _run_bot_mtproto_download) — no public link needed, and no id
 * translation needed either, since it's the same identity the webhook
 * already talks to. This replaces two earlier attempts that both failed:
 * a t.me/c/... link (only works for supergroups/channels, not one-on-one
 * private chats) and `tdl chat export -c <chat_id>` via a *separate*
 * personal-account session (TDL_SESSION), which doesn't share this bot's
 * chat/message id numbering — see the Action script for the full story.
 */
async function handleForwardedMessage(message, forward, env, userId, chatId) {
  const media = detectMedia(message);

  const sourceLine = forward.sourceName
    ? `${sourceLabelFa(forward.sourceType)}: ${forward.sourceName}`
    : sourceLabelFa(forward.sourceType);

  if (!media.hasMedia) {
    // Forwarded, but no file in it — nothing to download, just acknowledge.
    await sendMessage(env, chatId, `↪️ پیام فوروارد شده (${sourceLine}) — فایلی توش پیدا نشد.`, backToMenuKeyboard());
    return;
  }

  const sizeLine = media.fileSize ? `\n📦 حجم: ${formatBytes(media.fileSize)}` : "";
  const nameLine = media.fileName ? `\n📄 نام: ${media.fileName}` : "";

  const sessionBase = {
    source: "telegram",
    stage: "menu",
    expectedSize: media.fileSize || null,
  };

  if (forward.publicLink) {
    await sendMessage(
      env,
      chatId,
      `↪️ پیام فوروارد شده از ${sourceLine}\n` +
        `🎞 نوع: ${mediaLabelFa(media.type)}${nameLine}${sizeLine}\n\n` +
        `🔗 لینک شناسایی شد.`
    );

    const session = await createSession(env, userId, { ...sessionBase, link: forward.publicLink });
    await sendMessage(env, chatId, jobOptionsSummaryText(session), jobOptionsKeyboard(session));
    return;
  }

  // No public link — fall back to exporting this exact message from the
  // bot's own chat with the user, by numeric chat id. See the function
  // docstring for why this works where a t.me/c/ link wouldn't.
  await sendMessage(
    env,
    chatId,
    `↪️ پیام فوروارد شده از ${sourceLine}\n` +
      `🎞 نوع: ${mediaLabelFa(media.type)}${nameLine}${sizeLine}\n\n` +
      `🔗 لینک عمومی نداشت، ولی از همین پیام مستقیم دانلود می‌شه.`
  );

  const session = await createSession(env, userId, {
    ...sessionBase,
    link: "", // no message link — the Action uses privateChatId/messageId instead
    privateChatId: chatId,
    privateMessageId: message.message_id,
  });
  await sendMessage(env, chatId, jobOptionsSummaryText(session), jobOptionsKeyboard(session));
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

// ---------------------------------------------------------------------------
// Provider-key collection (personal or admin), one field at a time.
//
// Flow: settings_my_key / settings_admin_key -> key_set_<providerId> ->
// three text replies in sequence (access -> secret -> bucket), tracked via
// session.pendingKeyField / collectedKeyParts. Only written to the
// user/admin record once all three are collected, so a half-entered key
// never partially overwrites a working one.

async function handleProviderKeyReply(env, userId, chatId, text, session) {
  const providerId = session.pendingProviderId;
  const provider = getProvider(providerId);
  if (!provider) {
    await clearSession(env, userId);
    await sendMessage(env, chatId, "❌ خطای داخلی: provider نامعتبر.", backToMenuKeyboard());
    return;
  }

  const field = session.pendingKeyField;
  const collected = { ...(session.collectedKeyParts || {}) };
  const trimmed = text.trim();

  if (field === "access") {
    collected.accessKey = trimmed;
    await updateSession(env, userId, { pendingKeyField: "secret", collectedKeyParts: collected });
    await sendMessage(env, chatId, keyFieldPromptText("secret"));
    return;
  }

  if (field === "secret") {
    collected.secretKey = trimmed;
    await updateSession(env, userId, { pendingKeyField: "bucket", collectedKeyParts: collected });
    await sendMessage(env, chatId, keyFieldPromptText("bucket"));
    return;
  }

  if (field === "bucket") {
    collected.bucket = trimmed === "-" ? null : trimmed; // "-" means "use provider default"

    const admin = isAdmin(userId, env);
    const fields = {
      accessKey: `${providerId}AccessKey`,
      secretKey: `${providerId}SecretKey`,
      bucket: `${providerId}Bucket`,
    };
    const patch = {
      [fields.accessKey]: collected.accessKey,
      [fields.secretKey]: collected.secretKey,
      [fields.bucket]: collected.bucket,
    };

    if (admin) {
      await updateAdminRecord(env, patch);
    } else {
      await updateUserRecord(env, userId, patch);
    }

    await clearSession(env, userId);
    await sendMessage(env, chatId, `✅ کلید ${provider.label} ثبت شد.`, backToMenuKeyboard());
    return;
  }

  // Shouldn't normally happen — unknown pendingKeyField value.
  await clearSession(env, userId);
  await sendMessage(env, chatId, "❌ خطای داخلی در ثبت کلید.", backToMenuKeyboard());
}

async function handleQuotaInputReply(env, adminUserId, chatId, text, session) {
  const targetId = session.pendingQuotaTargetId;
  const kind = session.pendingQuotaKind;
  const trimmed = text.trim();

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    await sendMessage(env, chatId, "❌ یک عدد معتبر (گیگابایت) بفرستید. برای نامحدود، 0 بفرستید.");
    return;
  }

  const gb = parseFloat(trimmed);
  const bytes = gb === 0 ? null : Math.round(gb * GB);

  const patch = kind === "internal" ? { internalQuotaBytes: bytes } : { externalQuotaBytes: bytes };
  const updated = await setUserQuotas(env, targetId, patch);

  await clearSession(env, adminUserId);

  if (!updated) {
    await sendMessage(env, chatId, `❌ کاربر ${targetId} پیدا نشد.`, backToMenuKeyboard());
    return;
  }

  await sendMessage(
    env,
    chatId,
    `✅ سهمیه‌ی ${kind === "internal" ? "داخلی" : "خارجی"} کاربر ${targetId} تنظیم شد.`,
    quotaEditKeyboard(targetId)
  );
}

export async function handleCallback(callback, env, ctx) {
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
    await showHistoryEntry(env, userId, chatId, messageId);
    return;
  }

  if (data === "hist_scope_self") {
    await answerCallbackQuery(env, callback.id);
    await showHistoryForScope(env, userId, chatId, messageId, { kind: "self" });
    return;
  }

  if (data === "hist_scope_all") {
    await answerCallbackQuery(env, callback.id);
    await showHistoryForScope(env, userId, chatId, messageId, { kind: "all" });
    return;
  }

  if (data.startsWith("hist_scope_user_")) {
    const targetId = data.replace("hist_scope_user_", "");
    await answerCallbackQuery(env, callback.id);
    await showHistoryForScope(env, userId, chatId, messageId, { kind: "user", targetId });
    return;
  }

  if (data.startsWith("hist_link_")) {
    await handleHistoryLink(env, callback, userId, chatId, messageId, data);
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

  if (data === "settings_my_key") {
    await answerCallbackQuery(env, callback.id);
    await showProviderKeyStatus(env, userId, chatId, messageId, { isAdmin: false });
    return;
  }

  if (data === "settings_admin_key") {
    if (!isAdmin(userId, env)) {
      await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
      return;
    }
    await answerCallbackQuery(env, callback.id);
    await showProviderKeyStatus(env, userId, chatId, messageId, { isAdmin: true });
    return;
  }

  if (data.startsWith("key_set_")) {
    await handleKeySetStart(env, callback, userId, chatId, messageId, data);
    return;
  }

  if (data.startsWith("key_del_")) {
    await handleKeyDelete(env, callback, userId, chatId, messageId, data);
    return;
  }

  if (data.startsWith("key_guide_")) {
    await handleKeyGuide(env, callback, chatId, data);
    return;
  }

  if (data === "settings_my_quota") {
    await answerCallbackQuery(env, callback.id);
    await showMyQuota(env, userId, chatId, messageId);
    return;
  }

  if (data === "settings_quotas") {
    if (!isAdmin(userId, env)) {
      await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
      return;
    }
    await answerCallbackQuery(env, callback.id);
    await showQuotaUserList(env, chatId, messageId);
    return;
  }

  if (data.startsWith("quota_user_")) {
    if (!isAdmin(userId, env)) {
      await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
      return;
    }
    const targetId = data.replace("quota_user_", "");
    await answerCallbackQuery(env, callback.id);
    await showQuotaForUser(env, chatId, messageId, targetId);
    return;
  }

  if (data.startsWith("quota_edit_internal_") || data.startsWith("quota_edit_external_")) {
    await handleQuotaEditStart(env, callback, userId, chatId, messageId, data);
    return;
  }

  if (data === "job_cancel") {
    await handleCancelJob(env, callback, userId, chatId, messageId, ctx);
    return;
  }

  if (data.startsWith("storage_fail_")) {
    await handleStorageFailureChoice(env, callback, userId, chatId, messageId, data, ctx);
    return;
  }

  if (data.startsWith("opt_")) {
    await handleJobOption(env, callback, userId, chatId, messageId, data, ctx);
    return;
  }

  await answerCallbackQuery(env, callback.id);
}

// ---------------------------------------------------------------------------
// History
//
// Regular users only ever see their own history — showHistoryEntry sends
// them straight there. Admins get a scope picker first (own / a specific
// user / everyone merged) so a busy user's downloads don't bury the
// admin's own history by default, per the earlier discussion.

async function showHistoryEntry(env, userId, chatId, messageId) {
  if (!isAdmin(userId, env)) {
    await showHistoryForScope(env, userId, chatId, messageId, { kind: "self" });
    return;
  }

  const users = await listUsers(env);
  await editMessageText(env, chatId, messageId, historyScopeText(), historyScopeKeyboard(users));
}

/**
 * @param {{kind: "self"|"user"|"all", targetId?: string}} scope
 */
async function showHistoryForScope(env, userId, chatId, messageId, scope) {
  const admin = isAdmin(userId, env);

  let entries;
  let scopeLabel;
  let backCallback = admin ? "menu_history" : "menu_main";

  if (scope.kind === "self") {
    entries = await getHistory(env, userId);
    scopeLabel = "خودم";
  } else if (scope.kind === "user" && admin) {
    entries = (await getHistory(env, scope.targetId)).map((e) => ({ ...e, ownerId: scope.targetId }));
    scopeLabel = `کاربر ${scope.targetId}`;
  } else if (scope.kind === "all" && admin) {
    entries = await getAllHistoryForAdmin(env);
    scopeLabel = "همه (ترکیبی)";
  } else {
    // A non-admin somehow sent a scope_user/scope_all callback — refuse
    // rather than silently falling back to their own history, since that
    // would mask what's actually a permissions bug.
    entries = [];
    scopeLabel = null;
  }

  // Remember the scope on the session so hist_link_/hist_del_ know where to
  // look without re-parsing callback_data (entry ids alone don't say which
  // user owns them for non-merged views).
  await createSession(env, userId, { source: "admin_flow", link: "", stage: "menu", historyScope: scope });

  await editMessageText(
    env,
    chatId,
    messageId,
    historyListText(entries, { isAdminView: admin && scope.kind !== "self", scopeLabel }),
    historyKeyboard(entries, { backCallback })
  );
}

/**
 * Admin's merged view: everyone's history combined, newest first. Walks
 * the allow-list plus the admin's own id; fine for the expected scale of a
 * personal bot (a handful of users), not meant for hundreds.
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

/**
 * Resolves which user id(s) to search for a given history entry, based on
 * the scope the list was rendered under (stashed in the session by
 * showHistoryForScope). Falls back to "search everyone the admin can see"
 * if for some reason the scope wasn't found, rather than failing outright.
 */
async function resolveHistoryLookupIds(env, userId) {
  if (!isAdmin(userId, env)) return [userId];

  const session = await getSession(env, userId);
  const scope = session && session.historyScope;

  if (scope && scope.kind === "self") return [userId];
  if (scope && scope.kind === "user" && scope.targetId) return [scope.targetId];

  const users = await listUsers(env);
  return [env.USER_ID, ...users.map((u) => u.id)];
}

async function handleHistoryLink(env, callback, userId, chatId, messageId, data) {
  const entryId = data.replace("hist_link_", "");
  const candidateIds = await resolveHistoryLookupIds(env, userId);

  let entry = null;
  for (const id of candidateIds) {
    entry = await getHistoryEntry(env, id, entryId);
    if (entry) break;
  }

  if (!entry) {
    await answerCallbackQuery(env, callback.id, "❌ پیدا نشد", true);
    return;
  }

  await answerCallbackQuery(env, callback.id);
  await sendMessage(env, chatId, entry.link);
}

/**
 * Deletion works from any scope an admin is looking at — including another
 * user's history — which is the point: if a user sends something that
 * shouldn't be there, the admin can remove it from here directly, without
 * needing separate tooling.
 */
async function handleHistoryDelete(env, callback, userId, chatId, messageId, data) {
  const entryId = data.replace("hist_del_", "");
  const candidateIds = await resolveHistoryLookupIds(env, userId);

  let removed = false;
  for (const id of candidateIds) {
    removed = await removeHistoryEntry(env, id, entryId);
    if (removed) break;
  }

  if (!removed) {
    await answerCallbackQuery(env, callback.id, "❌ پیدا نشد", true);
    return;
  }

  await answerCallbackQuery(env, callback.id, "🗑 حذف شد");

  const session = await getSession(env, userId);
  const scope = (session && session.historyScope) || { kind: "self" };
  await showHistoryForScope(env, userId, chatId, messageId, scope);
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

// ---------------------------------------------------------------------------
// Provider-key settings (personal, or admin's own)

async function showProviderKeyStatus(env, userId, chatId, messageId, { isAdmin: adminView }) {
  const provider = getProvider(DEFAULT_INTERNAL_PROVIDER_ID);
  const record = adminView ? await getAdminRecord(env) : await getUserRecord(env, userId);

  const fields = { accessKey: `${provider.id}AccessKey`, secretKey: `${provider.id}SecretKey` };
  const hasKey = !!(record && record[fields.accessKey] && record[fields.secretKey]);

  await editMessageText(
    env,
    chatId,
    messageId,
    providerKeyStatusText(provider, record || {}, { isAdmin: adminView }),
    providerKeyKeyboard(provider, { hasKey, backCallback: "menu_settings" })
  );
}

async function handleKeySetStart(env, callback, userId, chatId, messageId, data) {
  const providerId = data.replace("key_set_", "");
  const provider = getProvider(providerId);
  if (!provider) {
    await answerCallbackQuery(env, callback.id, "❌ provider نامعتبر", true);
    return;
  }

  await createSession(env, userId, {
    source: "admin_flow",
    link: "",
    stage: "awaiting_provider_key",
    pendingProviderId: providerId,
    pendingKeyField: "access",
    collectedKeyParts: {},
  });

  await answerCallbackQuery(env, callback.id);
  await editMessageText(env, chatId, messageId, keyFieldPromptText("access"));
}

async function handleKeyDelete(env, callback, userId, chatId, messageId, data) {
  const providerId = data.replace("key_del_", "");
  const provider = getProvider(providerId);
  if (!provider) {
    await answerCallbackQuery(env, callback.id, "❌ provider نامعتبر", true);
    return;
  }

  const adminView = isAdmin(userId, env);
  const fields = {
    accessKey: `${providerId}AccessKey`,
    secretKey: `${providerId}SecretKey`,
    endpoint: `${providerId}Endpoint`,
    bucket: `${providerId}Bucket`,
  };
  const patch = { [fields.accessKey]: null, [fields.secretKey]: null, [fields.endpoint]: null, [fields.bucket]: null };

  if (adminView) {
    await updateAdminRecord(env, patch);
  } else {
    await updateUserRecord(env, userId, patch);
  }

  await answerCallbackQuery(env, callback.id, "🗑 حذف شد");
  await showProviderKeyStatus(env, userId, chatId, messageId, { isAdmin: adminView });
}

async function handleKeyGuide(env, callback, chatId, data) {
  const providerId = data.replace("key_guide_", "");
  const provider = getProvider(providerId);

  await answerCallbackQuery(env, callback.id);
  if (!provider) return;
  await sendMessage(env, chatId, providerKeyGuideText(provider));
}

// ---------------------------------------------------------------------------
// Quota settings

async function showMyQuota(env, userId, chatId, messageId) {
  const record = await getUserRecord(env, userId);
  if (!record) {
    // Admin has no stored quota record — unlimited by definition.
    await editMessageText(
      env,
      chatId,
      messageId,
      "📊 شما (ادمین) هیچ محدودیت سهمیه‌ای ندارید.",
      backToMenuKeyboard()
    );
    return;
  }
  await editMessageText(env, chatId, messageId, quotaStatusText(userId, record, { isAdmin: false }), backToMenuKeyboard());
}

async function showQuotaUserList(env, chatId, messageId) {
  const users = await listUsers(env);
  await editMessageText(env, chatId, messageId, quotaUserListText(users), quotaUserListKeyboard(users));
}

async function showQuotaForUser(env, chatId, messageId, targetId) {
  const record = await getUserRecord(env, targetId);
  if (!record) {
    await editMessageText(env, chatId, messageId, `❌ کاربر ${targetId} پیدا نشد.`, backToMenuKeyboard());
    return;
  }
  await editMessageText(
    env,
    chatId,
    messageId,
    quotaStatusText(targetId, record, { isAdmin: true }),
    quotaEditKeyboard(targetId)
  );
}

async function handleQuotaEditStart(env, callback, userId, chatId, messageId, data) {
  if (!isAdmin(userId, env)) {
    await answerCallbackQuery(env, callback.id, "❌ فقط ادمین می‌تونه", true);
    return;
  }

  const isInternal = data.startsWith("quota_edit_internal_");
  const targetId = data.replace(isInternal ? "quota_edit_internal_" : "quota_edit_external_", "");
  const kind = isInternal ? "internal" : "external";

  await createSession(env, userId, {
    source: "admin_flow",
    link: "",
    stage: "awaiting_quota_input",
    pendingQuotaKind: kind,
    pendingQuotaTargetId: targetId,
  });

  await answerCallbackQuery(env, callback.id);
  await editMessageText(env, chatId, messageId, quotaEditPromptText(kind));
}

// ---------------------------------------------------------------------------
// Job options (rename / zip / storage) and dispatch

async function handleJobOption(env, callback, userId, chatId, messageId, data, ctx) {
  const session = await getSession(env, userId);

  if (!session) {
    await answerCallbackQuery(env, callback.id, "❌ این درخواست منقضی شده", true);
    return;
  }

  if (data === "opt_cancel") {
    await clearSession(env, userId);
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, "❌ لغو شد.", backToMenuKeyboard());
    return;
  }

  if (data === "opt_toggle_zip") {
    const updated = await updateSession(env, userId, { zip: !session.zip });
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, jobOptionsSummaryText(updated), jobOptionsKeyboard(updated));
    return;
  }

  if (data === "opt_toggle_storage") {
    const nextStorage = session.storage === "internal" ? "external" : "internal";
    const updated = await updateSession(env, userId, { storage: nextStorage });
    await answerCallbackQuery(
      env,
      callback.id,
      nextStorage === "internal" ? "🇮🇷 داخلی انتخاب شد" : "🌍 خارجی انتخاب شد"
    );
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

    // Quota pre-check before we even dispatch, so an over-quota user gets
    // told immediately rather than after a GitHub Actions run has already
    // spun up. Uses the known/expected size when we have one (forwards
    // with metadata, direct URLs with Content-Length); jobs whose size is
    // only known after download (public t.me links via tdl) skip the
    // pre-check and get their usage recorded after the fact instead — see
    // actions/common/notify.py record_history and storage_upload.py.
    const admin = isAdmin(userId, env);
    const quotaKind = session.storage === "internal" ? "internal" : "external";
    const knownBytes = session.knownSize || session.expectedSize || null;

    const quota = await checkQuota(env, userId, quotaKind, knownBytes, admin);
    if (!quota.allowed) {
      const label = quotaKind === "internal" ? "داخلی" : "خارجی";
      await editMessageText(
        env,
        chatId,
        messageId,
        `❌ سهمیه‌ی ${label} شما کافی نیست (باقی‌مانده: ${formatBytes(quota.remainingBytes || 0)}).\n\n` +
          "می‌تونید از منو محل ذخیره رو عوض کنید یا با ادمین هماهنگ کنید.",
        jobOptionsKeyboard(session)
      );
      return;
    }

    await editMessageText(env, chatId, messageId, "⏳ در حال ارسال درخواست...");
    await startJob(env, userId, chatId, messageId, session, ctx);
    return;
  }

  await answerCallbackQuery(env, callback.id);
}

/**
 * Resolves which provider credentials to hand the Action for an "internal"
 * storage job: the user's own personal key set if they have one (bypasses
 * their internal quota entirely — it's their own account being billed),
 * otherwise the admin's key set (subject to the user's internal quota).
 * Returns null if neither is configured, in which case the caller should
 * fail the job before ever dispatching to GitHub — no silent fallback to
 * GitHub Release here, since the user explicitly chose "داخلی".
 */
async function resolveStorageCredentials(env, userId, isAdminUser, providerId) {
  const fields = {
    accessKey: `${providerId}AccessKey`,
    secretKey: `${providerId}SecretKey`,
    endpoint: `${providerId}Endpoint`,
    bucket: `${providerId}Bucket`,
  };

  if (!isAdminUser) {
    const userRecord = await getUserRecord(env, userId);
    if (userRecord && userRecord[fields.accessKey] && userRecord[fields.secretKey]) {
      return {
        usingPersonalKey: true,
        accessKey: userRecord[fields.accessKey],
        secretKey: userRecord[fields.secretKey],
        endpoint: userRecord[fields.endpoint] || null,
        bucket: userRecord[fields.bucket] || null,
      };
    }
  }

  const adminRecord = await getAdminRecord(env);
  if (adminRecord && adminRecord[fields.accessKey] && adminRecord[fields.secretKey]) {
    return {
      usingPersonalKey: false,
      accessKey: adminRecord[fields.accessKey],
      secretKey: adminRecord[fields.secretKey],
      endpoint: adminRecord[fields.endpoint] || null,
      bucket: adminRecord[fields.bucket] || null,
    };
  }

  return null;
}

/**
 * Dispatches the job to GitHub Actions and returns to the user immediately
 * — the Action starts running the instant dispatchGithubEvent succeeds, it
 * is NOT delayed by anything below. Locating the run's id (needed for the
 * cancel button) happens via ctx.waitUntil so it continues after this
 * function returns and the Telegram response has already been sent; a
 * cancel click that arrives in that brief window is handled gracefully
 * (see handleCancelJob) rather than by making the user wait here.
 */
async function startJob(env, userId, chatId, messageId, session, ctx) {
  const eventType = session.source === "direct_url" ? "direct_url_download" : "telegram_download";
  const options = { zip: session.zip, customName: session.customName };
  const admin = isAdmin(userId, env);

  let storagePayload = { storage_target: "external" };

  if (session.storage === "internal") {
    const providerId = DEFAULT_INTERNAL_PROVIDER_ID;
    const creds = await resolveStorageCredentials(env, userId, admin, providerId);

    if (!creds) {
      const provider = getProvider(providerId);
      await sendMessage(
        env,
        chatId,
        `❌ کلید ${provider.label} تنظیم نشده (نه شخصی، نه ادمین). از تنظیمات کلید ثبت کنید یا محل ذخیره رو به خارجی تغییر بدید.`,
        backToMenuKeyboard()
      );
      await clearSession(env, userId);
      return;
    }

    storagePayload = {
      storage_target: "internal",
      storage_provider: providerId,
      storage_access_key: creds.accessKey,
      storage_secret_key: creds.secretKey,
      storage_endpoint: creds.endpoint || "",
      storage_bucket: creds.bucket || "",
      // Passed through so the Worker can attribute usage to the right
      // quota bucket after the fact (see /internal/history-add and
      // record_history in notify.py) without re-deriving it.
      storage_using_personal_key: creds.usingPersonalKey ? "1" : "",
    };
  }

  const previousRunId = await getLatestRunId(env, eventType);

  const clientPayload =
    session.source === "direct_url"
      ? {
          source_url: session.link,
          chat_id: chatId,
          zip: !!options.zip,
          custom_name: options.customName || "",
          ...storagePayload,
        }
      : {
          telegram_url: session.link || "",
          // Present only for the private-chat export fallback (see
          // handleForwardedMessage) — empty strings otherwise, so the
          // workflow can tell which mode to use.
          private_chat_id: session.privateChatId || "",
          private_message_id: session.privateMessageId || "",
          chat_id: chatId,
          zip: !!options.zip,
          custom_name: options.customName || "",
          expected_size: session.expectedSize || "",
          ...storagePayload,
        };

  const ok = await dispatchGithubEvent(env, eventType, clientPayload);

  await clearSession(env, userId);

  if (!ok) {
    await sendMessage(env, chatId, "❌ خطا در ارسال درخواست به گیت‌هاب", backToMenuKeyboard());
    return;
  }

  const progressMessageId = await sendMessageGetId(
    env,
    chatId,
    "✅ درخواست ارسال شد!\n" + "⏳ اسکریپت در حال اجرا است...\n\n" + "نتیجه تو چند دقیقه می‌ره",
    progressKeyboard()
  );

  await setActiveJob(env, userId, {
    eventType,
    runId: null,
    messageId: progressMessageId,
    startedAt: Date.now(),
    storage: session.storage,
    // Kept so a run-time upload failure (see handleStorageFailureChoice)
    // can re-dispatch the same job without asking the user to resend
    // everything — this is the exact payload that was just dispatched.
    retryPayload: clientPayload,
  });

  const locateRun = async () => {
    const runId = await findRunIdAfterDispatch(env, eventType, previousRunId);
    if (runId) {
      // Only record it if the job wasn't already cancelled/replaced while
      // we were looking (e.g. user cancelled, or started a second job).
      const current = await getActiveJob(env, userId);
      if (current && current.messageId === progressMessageId) {
        await updateActiveJob(env, userId, { runId });
      }
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(locateRun());
  } else {
    // Fallback for contexts without waitUntil (e.g. local testing) — just
    // await it directly rather than silently skipping run-id tracking.
    await locateRun();
  }
}

/**
 * The cancel button on the progress message. Handles three cases:
 *   1. No active job recorded at all (e.g. already finished) -> tell the user
 *   2. Job recorded but run id not located yet -> try a quick direct lookup
 *      (the background waitUntil from startJob may still be in flight);
 *      if still not found, ask the user to try again in a moment rather
 *      than silently failing.
 *   3. Run id known -> cancel it on GitHub and confirm to the user.
 */
async function handleCancelJob(env, callback, userId, chatId, messageId, ctx) {
  const job = await getActiveJob(env, userId);

  if (!job) {
    await answerCallbackQuery(env, callback.id, "❌ کار فعالی برای لغو پیدا نشد", true);
    return;
  }

  await answerCallbackQuery(env, callback.id, "⏳ در حال لغو...");

  let runId = job.runId;
  if (!runId) {
    // Best-effort quick re-check — cheap single API call, not the full
    // multi-attempt poll — in case the background lookup already finished
    // between startJob's waitUntil kicking off and this click arriving.
    runId = await getLatestRunId(env, job.eventType);
    if (runId) {
      await updateActiveJob(env, userId, { runId });
    }
  }

  if (!runId) {
    await editMessageText(
      env,
      chatId,
      messageId,
      "⏳ هنوز در حال پیدا کردن اجرای دقیق کار هستیم. چند ثانیه صبر کنید و دوباره «لغو» رو بزنید.",
      progressKeyboard()
    );
    return;
  }

  const cancelled = await cancelWorkflowRun(env, runId);
  await clearActiveJob(env, userId);

  await editMessageText(
    env,
    chatId,
    messageId,
    cancelled ? "⛔ لغو شد." : "⚠️ درخواست لغو ارسال شد، ولی گیت‌هاب هنوز تاییدش نکرده. اگه فایل بازم رسید، طبیعیه (لغو دیر رسیده بوده).",
    backToMenuKeyboard()
  );
}

/**
 * Handles the three-way choice offered when an internal-storage upload
 * fails at run time (see actions/common/storage_upload.py and
 * actions/common/notify.py — the Action edits the progress message with
 * storageFailureKeyboard() on failure). Re-dispatches a fresh job with the
 * same file-source parameters but possibly a different storage_target,
 * reusing the original dispatch's retryPayload stashed on the active-job
 * record by startJob.
 *
 * Note: since the original download already completed inside the failed
 * run (only the *upload* step failed), retry/fallback here re-dispatches
 * the whole job from scratch rather than resuming — the Action has no way
 * to resume a finished, torn-down runner. This costs a re-download, an
 * accepted tradeoff for keeping this path simple; if re-downloads turn out
 * to be a real pain point later, the Action could instead cache the
 * downloaded file as a workflow artifact and have this path re-trigger
 * just the upload step, but that's a bigger change than this feature needs
 * today.
 */
async function handleStorageFailureChoice(env, callback, userId, chatId, messageId, data, ctx) {
  const job = await getActiveJob(env, userId);

  if (!job || !job.retryPayload) {
    await answerCallbackQuery(env, callback.id, "❌ اطلاعات این کار دیگه در دسترس نیست، دوباره از اول امتحان کنید.", true);
    await editMessageText(env, chatId, messageId, "❌ این کار منقضی شده. لینک/فایل رو دوباره بفرستید.", backToMenuKeyboard());
    return;
  }

  if (data === "storage_fail_cancel") {
    await clearActiveJob(env, userId);
    await answerCallbackQuery(env, callback.id);
    await editMessageText(env, chatId, messageId, "❌ لغو شد.", backToMenuKeyboard());
    return;
  }

  await answerCallbackQuery(env, callback.id, "⏳ در حال ارسال دوباره...");

  const eventType = job.eventType;
  const clientPayload = { ...job.retryPayload };

  if (data === "storage_fail_fallback_github") {
    clientPayload.storage_target = "external";
    delete clientPayload.storage_provider;
    delete clientPayload.storage_access_key;
    delete clientPayload.storage_secret_key;
    delete clientPayload.storage_endpoint;
    delete clientPayload.storage_bucket;
    delete clientPayload.storage_using_personal_key;
  }
  // storage_fail_retry: clientPayload already has the same internal
  // storage_* fields from the original attempt, so nothing to change.

  const previousRunId = await getLatestRunId(env, eventType);
  const ok = await dispatchGithubEvent(env, eventType, clientPayload);

  if (!ok) {
    await editMessageText(env, chatId, messageId, "❌ خطا در ارسال دوباره‌ی درخواست به گیت‌هاب", backToMenuKeyboard());
    await clearActiveJob(env, userId);
    return;
  }

  await editMessageText(env, chatId, messageId, "✅ دوباره ارسال شد!\n⏳ در حال اجرا...", progressKeyboard());

  await setActiveJob(env, userId, {
    eventType,
    runId: null,
    messageId,
    startedAt: Date.now(),
    storage: clientPayload.storage_target === "internal" ? "internal" : "external",
    retryPayload: job.retryPayload, // keep it around in case this attempt also fails
  });

  const locateRun = async () => {
    const runId = await findRunIdAfterDispatch(env, eventType, previousRunId);
    if (runId) {
      const current = await getActiveJob(env, userId);
      if (current && current.messageId === messageId) {
        await updateActiveJob(env, userId, { runId });
      }
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(locateRun());
  } else {
    await locateRun();
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
