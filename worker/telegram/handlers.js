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

import { sendMessage, sendMessageGetId, editMessageText, answerCallbackQuery } from "./client.js";
import { detectForward, detectMedia, mediaLabelFa, sourceLabelFa } from "./forward.js";
import { isDirectUrl, maxAllowedBytes, probeDirectUrl } from "./directUrl.js";
import { dispatchGithubEvent, getLatestRunId, findRunIdAfterDispatch, cancelWorkflowRun } from "../github/dispatch.js";
import { createSession, getSession, updateSession, clearSession } from "../state/session.js";
import { setActiveJob, getActiveJob, updateActiveJob, clearActiveJob } from "../state/activeJob.js";
import { isAdmin, isAuthorized as isAllowedUser, addUser, removeUser, listUsers } from "../state/users.js";
import { getHistory, removeHistoryEntry, getHistoryEntry } from "../state/history.js";
import {
  MAIN_MENU_TEXT,
  mainMenuKeyboard,
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
