// worker/telegram/client.js
//
// Thin wrapper around the Telegram Bot API. No business logic here —
// just the raw HTTP calls other modules build on top of.

const TELEGRAM_API = (token) => `https://api.telegram.org/bot${token}`;

async function callTelegram(env, method, body) {
  const res = await fetch(`${TELEGRAM_API(env.TELEGRAM_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Telegram always returns JSON, even on failure. We don't throw here —
  // callers decide whether a failed send is fatal for their flow.
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response; treat as failure below.
  }

  return { ok: res.ok && data && data.ok, data };
}

export async function sendMessage(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return callTelegram(env, "sendMessage", body);
}

export async function editMessageText(env, chatId, messageId, text, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return callTelegram(env, "editMessageText", body);
}

export async function answerCallbackQuery(env, callbackId, text, showAlert) {
  return callTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: !!showAlert,
  });
}
