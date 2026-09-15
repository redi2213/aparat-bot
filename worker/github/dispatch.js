// worker/github/dispatch.js
//
// Everything related to triggering GitHub Actions via repository_dispatch.
// This is the "hand-off" point: the Worker's job ends here, the heavy
// lifting (download/upload) happens in the Action.

const REPO = "redi2213/aparat-bot";

/**
 * Fires a repository_dispatch event. Returns true on success (GitHub
 * replies 204 No Content), false otherwise.
 */
export async function dispatchGithubEvent(env, eventType, clientPayload) {
  const url = `https://api.github.com/repos/${REPO}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "aparat-bot-webhook",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });

  return response.status === 204;
}

export async function triggerTelegramDownload(env, telegramUrl, chatId, options = {}) {
  return dispatchGithubEvent(env, "telegram_download", {
    telegram_url: telegramUrl,
    chat_id: chatId,
    zip: !!options.zip,
    custom_name: options.customName || "",
  });
}

export async function triggerDirectUrlDownload(env, sourceUrl, chatId, options = {}) {
  return dispatchGithubEvent(env, "direct_url_download", {
    source_url: sourceUrl,
    chat_id: chatId,
    zip: !!options.zip,
    custom_name: options.customName || "",
  });
}
