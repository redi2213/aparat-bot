// worker/github/dispatch.js
//
// Everything related to triggering GitHub Actions via repository_dispatch,
// and to finding + cancelling the specific workflow run that resulted from
// a given dispatch (for the cancel-download button).
//
// This is the "hand-off" point: the Worker's job ends here, the heavy
// lifting (download/upload) happens in the Action.

const REPO = "redi2213/aparat-bot";
const WORKFLOW_FILES = {
  telegram_download: "telegram-to-release.yml",
  direct_url_download: "direct-url-to-release.yml",
};

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

/**
 * repository_dispatch doesn't return a run_id directly — GitHub creates the
 * run asynchronously. To find it, we snapshot the latest run id for the
 * relevant workflow file *before* dispatching, then poll shortly after
 * until a newer run id shows up.
 *
 * Important: dispatch happens immediately and is NOT delayed by this
 * lookup — the Action starts running the moment dispatchGithubEvent
 * succeeds. Callers that want the cancel button to work should dispatch
 * synchronously (await dispatchGithubEvent) and run findRunIdAfterDispatch
 * via ctx.waitUntil so it continues in the background after the Telegram
 * response has already been sent — the user isn't kept waiting on this
 * lookup, and a cancel click that arrives before the id is found just shows
 * "still locating the job" (see handlers.js handleCancelJob).
 *
 * This is best-effort: if two jobs of the same type are dispatched
 * back-to-back, there's a small race window, but for a personal/small-team
 * bot that's an acceptable tradeoff for not needing to thread a correlation
 * id through GitHub's dispatch API (which doesn't expose client_payload in
 * the runs list without an extra fetch per run).
 *
 * @returns {Promise<number|null>} the run id, or null if we couldn't find it in time
 */
export async function findRunIdAfterDispatch(env, eventType, previousRunId) {
  const workflowFile = WORKFLOW_FILES[eventType];
  if (!workflowFile) return null;
  return pollForNewRun(env, workflowFile, previousRunId);
}

export async function getLatestRunId(env, eventType) {
  const workflowFile = WORKFLOW_FILES[eventType];
  if (!workflowFile) return null;
  const data = await fetchRunsList(env, workflowFile);
  if (data && data.workflow_runs && data.workflow_runs.length > 0) {
    return data.workflow_runs[0].id;
  }
  return null;
}

async function pollForNewRun(env, workflowFile, previousRunId, attempts = 6, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    const data = await fetchRunsList(env, workflowFile);
    const latest = data && data.workflow_runs && data.workflow_runs.length > 0 ? data.workflow_runs[0].id : null;
    if (latest && latest !== previousRunId) {
      return latest;
    }
  }
  return null;
}

async function fetchRunsList(env, workflowFile) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${workflowFile}/runs?per_page=1`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "aparat-bot-webhook",
    },
  });
  if (!response.ok) return null;
  return response.json();
}

/**
 * Cancels a workflow run. Returns true if GitHub accepted the cancel
 * request (202) — actual cancellation still takes a few seconds on
 * GitHub's side, this just confirms the request was accepted.
 */
export async function cancelWorkflowRun(env, runId) {
  if (!runId) return false;
  const url = `https://api.github.com/repos/${REPO}/actions/runs/${runId}/cancel`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "aparat-bot-webhook",
    },
  });
  return response.status === 202;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The two helpers below are kept for any external/future caller that just
// wants a simple "dispatch this download" without the run-tracking dance —
// handlers.js's startJob calls dispatchGithubEvent directly instead, since
// it also needs getLatestRunId/findRunIdAfterDispatch around the same call
// for the cancel button to work.
export async function triggerTelegramDownload(env, telegramUrl, chatId, options = {}) {
  return dispatchGithubEvent(env, "telegram_download", {
    telegram_url: telegramUrl,
    chat_id: chatId,
    zip: !!options.zip,
    custom_name: options.customName || "",
    expected_size: options.expectedSize || "",
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
