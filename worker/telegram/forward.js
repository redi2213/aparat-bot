// worker/telegram/forward.js
//
// Everything related to inspecting a Telegram message for:
//   1) whether it was forwarded, and from where
//   2) whether it carries a media file, and what kind
//   3) whether we can build a public t.me link for it (only possible
//      when the forward origin is a channel/group with a public @username)
//
// Telegram Bot API note: as of Bot API 7.0, forward info comes via the
// `forward_origin` field. Older clients / cached updates may still send
// the legacy `forward_from` / `forward_from_chat` fields, so we check both.

/**
 * @typedef {Object} ForwardInfo
 * @property {boolean} isForwarded
 * @property {"channel"|"group"|"user"|"hidden"|null} sourceType
 * @property {string|null} sourceName      - display name of the origin
 * @property {string|null} sourceUsername  - public @username, if any
 * @property {number|null} messageId       - original message id in the source chat (channel/group only)
 * @property {string|null} publicLink      - t.me/username/id, only when buildable
 */

/**
 * @typedef {Object} MediaInfo
 * @property {boolean} hasMedia
 * @property {"video"|"photo"|"audio"|"voice"|"document"|"animation"|"video_note"|null} type
 * @property {string|null} fileName
 * @property {number|null} fileSize        - bytes, when Telegram reports it
 * @property {string|null} mimeType
 */

/**
 * Builds a t.me/c/<chat_id>/<message_id> link pointing at the forwarded
 * message itself — inside the bot's own chat with the user, not the
 * original source. This works regardless of where the forward originally
 * came from (channel, group, user, even a multi-hop forward where Telegram
 * has discarded the original source info — see detectForward's user/hidden
 * cases) because it only needs two things we always have: this chat's id
 * and this message's id.
 *
 * Why this works: `tdl` authenticates as the *user's own* Telegram account
 * (TDL_SESSION), and that account is a participant in its own chat with
 * the bot — so it already has access to read this message, the same way
 * it can read any other private chat it's part of. No public @username is
 * needed for this path.
 *
 * The numeric chat id format tdl/Telegram links expect (`/c/<id>/...`)
 * strips the `-100` prefix that Bot API uses for supergroup/channel-style
 * chat ids; regular private-chat ids (positive, no prefix) are used as-is.
 */
export function buildPrivateChatLink(chatId, messageId) {
  if (!chatId || !messageId) return null;
  const idStr = String(chatId).replace(/^-100/, "").replace(/^-/, "");
  return `https://t.me/c/${idStr}/${messageId}`;
}

export function detectForward(message) {
  const origin = message.forward_origin;

  if (origin) {
    // New-style forward_origin (Bot API 7.0+)
    if (origin.type === "channel") {
      const chat = origin.chat;
      const username = chat && chat.username ? chat.username : null;
      const messageId = origin.message_id || null;
      return {
        isForwarded: true,
        sourceType: "channel",
        sourceName: chat ? chat.title : null,
        sourceUsername: username,
        messageId,
        publicLink: username && messageId ? `https://t.me/${username}/${messageId}` : null,
      };
    }
    if (origin.type === "chat") {
      // Forwarded from a group (or a channel without a public identity in this context)
      const chat = origin.sender_chat;
      const username = chat && chat.username ? chat.username : null;
      return {
        isForwarded: true,
        sourceType: "group",
        sourceName: chat ? chat.title : null,
        sourceUsername: username,
        messageId: null, // groups don't expose a stable public message id this way
        publicLink: null,
      };
    }
    if (origin.type === "user") {
      const user = origin.sender_user;
      return {
        isForwarded: true,
        sourceType: "user",
        sourceName: user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : null,
        sourceUsername: user && user.username ? user.username : null,
        messageId: null,
        publicLink: null,
      };
    }
    if (origin.type === "hidden_user") {
      return {
        isForwarded: true,
        sourceType: "hidden",
        sourceName: origin.sender_user_name || null,
        sourceUsername: null,
        messageId: null,
        publicLink: null,
      };
    }
  }

  // Legacy fields fallback
  if (message.forward_from_chat) {
    const chat = message.forward_from_chat;
    const username = chat.username || null;
    const messageId = message.forward_from_message_id || null;
    return {
      isForwarded: true,
      sourceType: chat.type === "channel" ? "channel" : "group",
      sourceName: chat.title || null,
      sourceUsername: username,
      messageId,
      publicLink: username && messageId ? `https://t.me/${username}/${messageId}` : null,
    };
  }

  if (message.forward_from) {
    const user = message.forward_from;
    return {
      isForwarded: true,
      sourceType: "user",
      sourceName: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      sourceUsername: user.username || null,
      messageId: null,
      publicLink: null,
    };
  }

  if (message.forward_sender_name) {
    // User forwarded with privacy setting hiding their account
    return {
      isForwarded: true,
      sourceType: "hidden",
      sourceName: message.forward_sender_name,
      sourceUsername: null,
      messageId: null,
      publicLink: null,
    };
  }

  return {
    isForwarded: false,
    sourceType: null,
    sourceName: null,
    sourceUsername: null,
    messageId: null,
    publicLink: null,
  };
}

const MEDIA_FIELDS = [
  ["video", "video"],
  ["photo", "photo"], // photo is an array of sizes; handled specially below
  ["audio", "audio"],
  ["voice", "voice"],
  ["document", "document"],
  ["animation", "animation"],
  ["video_note", "video_note"],
];

export function detectMedia(message) {
  for (const [field, type] of MEDIA_FIELDS) {
    const value = message[field];
    if (!value) continue;

    if (field === "photo") {
      // Telegram sends multiple resolutions; the last one is the largest.
      const largest = value[value.length - 1];
      return {
        hasMedia: true,
        type: "photo",
        fileName: null,
        fileSize: largest.file_size || null,
        mimeType: "image/jpeg",
      };
    }

    return {
      hasMedia: true,
      type,
      fileName: value.file_name || null,
      fileSize: value.file_size || null,
      mimeType: value.mime_type || null,
    };
  }

  return { hasMedia: false, type: null, fileName: null, fileSize: null, mimeType: null };
}

const MEDIA_LABELS_FA = {
  video: "ویدیو",
  photo: "عکس",
  audio: "موزیک",
  voice: "پیام صوتی",
  document: "فایل/سند",
  animation: "گیف/انیمیشن",
  video_note: "ویدیو گرد",
};

const SOURCE_LABELS_FA = {
  channel: "کانال",
  group: "گروه",
  user: "کاربر",
  hidden: "کاربر (مخفی)",
};

export function mediaLabelFa(type) {
  return MEDIA_LABELS_FA[type] || "فایل";
}

export function sourceLabelFa(type) {
  return SOURCE_LABELS_FA[type] || "منبع نامشخص";
}
