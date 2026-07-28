import {
  PROP,
  SESSION_DATA_SOURCE_URL,
  SESSION_STATUS,
  NEXT_ACTION,
  STALE_CLAIM_MS,
  MAX_TECHNICAL_RETRIES,
  TECHNICAL_SESSION_ERROR_RE,
  RUNNING_VISIBILITY_TIMEOUT_MS,
  TECHNICAL_RETRY_BACKOFF_BASE_MS,
  type SessionStatus,
  type NextAction,
} from "../config.js";
import { InvalidCompletionError, RunningVisibilityError } from "../errors.js";
import {
  getNotionClient,
  resolveDataSourceId,
  findPropertyId,
  getRichText,
  getUrl,
  getSelectName,
  getDateStart,
  getNumber,
  getRelationPageIds,
  pageIdToUrl,
  parsePageUrl,
  statusUpdatePayload,
  namedOptionUpdatePayload,
  isFullPage,
  withNotionRetry,
} from "./helpers.js";
import {
  isReconcileableControlJson,
  isStaleClaimOrRunning,
  parseSessionControlJson,
  type ParsedControlJson,
} from "./controlJson.js";
import { isLockHeld } from "../locks.js";
import { logger } from "../logging.js";

export interface SessionRecord {
  pageId: string;
  pageUrl: string;
  sessionId: string;
  clientPageId: string | null;
  clientPageUrl: string | null;
  status: SessionStatus | null;
  nextAction: NextAction | null;
  conversationUrl: string | null;
  model: string | null;
  nextWakeAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastControlJson: string | null;
  wakeReason: string | null;
  wakePayloadEventId: string | null;
  retryCount: number;
  clientDnc: boolean;
  hasLatestInteraction: boolean;
}

interface PropIds {
  sessionId: string;
  client: string;
  status: string;
  conversationUrl: string;
  model: string;
  nextWakeAt: string;
  lastRunAt: string;
  lastError: string;
  lastControlJson: string;
  retryCount: string;
  nextAction: string;
  latestMeeting: string | null;
  latestInteraction: string | null;
  wakePayloadJson: string | null;
  wakeReason: string | null;
}

let cachedDsId: string | null = null;
let cachedIds: PropIds | null = null;
let cachedStatusFieldType: "status" | "select" = "status";
let cachedNextActionFieldType: "status" | "select" = "select";

async function dsId(): Promise<string> {
  if (!cachedDsId) cachedDsId = await resolveDataSourceId(SESSION_DATA_SOURCE_URL);
  return cachedDsId;
}

function statusEqualsFilter(statusPropId: string, name: string): Record<string, unknown> {
  return cachedStatusFieldType === "status"
    ? { property: statusPropId, status: { equals: name } }
    : { property: statusPropId, select: { equals: name } };
}

async function propIds(): Promise<PropIds> {
  if (cachedIds) return cachedIds;
  const client = getNotionClient();
  const ds = await withNotionRetry("sessionDataSource.retrieve", async () =>
    client.dataSources.retrieve({ data_source_id: await dsId() }),
  );
  const props = ("properties" in ds && ds.properties) || {};
  const req = (name: string) => {
    const id = findPropertyId(props, name);
    if (!id) throw new Error(`Session property not found: ${name}`);
    return id;
  };
  const statusProp = props[req(PROP.STATUS)] as { type?: string } | undefined;
  const nextActionProp = props[req(PROP.NEXT_ACTION)] as { type?: string } | undefined;
  cachedStatusFieldType = statusProp?.type === "status" ? "status" : "select";
  cachedNextActionFieldType = nextActionProp?.type === "status" ? "status" : "select";
  cachedIds = {
    sessionId: req(PROP.SESSION_ID),
    client: req(PROP.CLIENT),
    status: req(PROP.STATUS),
    conversationUrl: req(PROP.CONVERSATION_URL),
    model: req(PROP.MODEL),
    nextWakeAt: req(PROP.NEXT_WAKE_AT),
    lastRunAt: req(PROP.LAST_RUN_AT),
    lastError: req(PROP.LAST_ERROR),
    lastControlJson: req(PROP.LAST_CONTROL_JSON),
    retryCount: req(PROP.RETRY_COUNT),
    nextAction: req(PROP.NEXT_ACTION),
    latestMeeting: findPropertyId(props, PROP.LATEST_MEETING),
    latestInteraction: findPropertyId(props, PROP.LATEST_INTERACTION),
    wakePayloadJson: findPropertyId(props, PROP.WAKE_PAYLOAD_JSON),
    wakeReason: findPropertyId(props, PROP.WAKE_REASON),
  };
  return cachedIds;
}

async function fetchClientDnc(clientPageId: string): Promise<boolean> {
  try {
    const page = await getNotionClient().pages.retrieve({ page_id: clientPageId });
    if (!isFullPage(page)) return false;
    for (const prop of Object.values(page.properties as Record<string, unknown>)) {
      const p = prop as { type?: string; name?: string; checkbox?: boolean };
      if (p.type === "checkbox" && p.name === PROP.DNC) return p.checkbox === true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function resolveClientPageId(
  sessionProps: Record<string, unknown>,
  ids: PropIds,
): Promise<string | null> {
  const direct = getRelationPageIds(sessionProps, ids.client);
  if (direct[0]) return direct[0];
  if (!ids.latestMeeting) return null;
  const meetingId = getRelationPageIds(sessionProps, ids.latestMeeting)[0];
  if (!meetingId) return null;
  const meeting = await getNotionClient().pages.retrieve({ page_id: meetingId });
  if (!isFullPage(meeting)) return null;
  const meetingProps = meeting.properties as Record<string, unknown>;
  for (const [propId, prop] of Object.entries(meetingProps)) {
    const p = prop as { type?: string; name?: string };
    if (p.type !== "relation") continue;
    if (p.name === PROP.MEETING_CLIENT || propId === PROP.MEETING_CLIENT) {
      const idsFound = getRelationPageIds(meetingProps, propId);
      if (idsFound[0]) return idsFound[0];
    }
  }
  return null;
}

export async function loadSession(sessionPageUrl: string): Promise<SessionRecord> {
  const pageId = parsePageUrl(sessionPageUrl);
  if (!pageId) throw new Error(`Invalid session page URL: ${sessionPageUrl}`);
  const ids = await propIds();
  const page = await getNotionClient().pages.retrieve({ page_id: pageId });
  if (!isFullPage(page)) throw new Error("Session page is not a full page");
  const props = page.properties as Record<string, unknown>;
  const clientPageId = await resolveClientPageId(props, ids);
  const wakePayloadRaw = ids.wakePayloadJson
    ? getRichText(props, ids.wakePayloadJson)
    : "";
  let wakePayloadEventId: string | null = null;
  if (wakePayloadRaw) {
    try {
      const obj = JSON.parse(wakePayloadRaw) as Record<string, unknown>;
      const key =
        (typeof obj.meeting_event_key === "string" && obj.meeting_event_key) ||
        (typeof obj.event_id === "string" && obj.event_id) ||
        (typeof obj.eventId === "string" && obj.eventId) ||
        null;
      wakePayloadEventId = key;
    } catch {
      wakePayloadEventId = null;
    }
  }
  return {
    pageId,
    pageUrl: pageIdToUrl(pageId),
    sessionId: getRichText(props, ids.sessionId) || pageId,
    clientPageId,
    clientPageUrl: clientPageId ? pageIdToUrl(clientPageId) : null,
    status: getSelectName(props, ids.status) as SessionStatus | null,
    nextAction: getSelectName(props, ids.nextAction) as NextAction | null,
    conversationUrl: getUrl(props, ids.conversationUrl) || null,
    model: getRichText(props, ids.model) || null,
    nextWakeAt: getDateStart(props, ids.nextWakeAt),
    lastRunAt: getDateStart(props, ids.lastRunAt),
    lastError: getRichText(props, ids.lastError) || null,
    lastControlJson: getRichText(props, ids.lastControlJson) || null,
    wakeReason: ids.wakeReason ? getRichText(props, ids.wakeReason) || null : null,
    wakePayloadEventId,
    retryCount: getNumber(props, ids.retryCount),
    clientDnc: clientPageId ? await fetchClientDnc(clientPageId) : false,
    hasLatestInteraction: ids.latestInteraction
      ? getRelationPageIds(props, ids.latestInteraction).length > 0
      : false,
  };
}

export async function claimSession(pageId: string): Promise<void> {
  const ids = await propIds();
  const payload = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.CLAIMED);
  await getNotionClient().pages.update({ page_id: pageId, properties: payload });
}

export async function releaseClaimToPending(pageId: string): Promise<void> {
  const ids = await propIds();
  const payload = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.PENDING);
  await getNotionClient().pages.update({ page_id: pageId, properties: payload });
}

/** Pending + Last Error, without bumping Retry Count (stale claim reclaim). */
export async function releaseToPendingWithError(
  pageId: string,
  errorMessage: string,
  nextWakeAt: Date = new Date(),
): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.PENDING);
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.nextWakeAt]: { date: { start: nextWakeAt.toISOString() } },
      [ids.lastError]: {
        rich_text: [{ type: "text", text: { content: errorMessage.slice(0, 2000) } }],
      },
    },
  });
}

export async function markRunning(pageId: string, startedAt: Date): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.RUNNING);
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.lastRunAt]: { date: { start: startedAt.toISOString() } },
    },
  });
}

export interface RunningVisibilityExpectation {
  nextAction: string;
  clientPageId: string;
}

/** Pure check — exported for unit tests. */
export function isRunningVisibilityReady(
  session: SessionRecord,
  expected: RunningVisibilityExpectation,
  startedAt: Date,
  now = new Date(),
): boolean {
  if (session.status !== SESSION_STATUS.RUNNING) return false;
  if (!session.lastRunAt) return false;
  if (new Date(session.lastRunAt).getTime() < startedAt.getTime() - 60_000) return false;
  if (session.clientPageId !== expected.clientPageId) return false;
  if (!session.nextAction || session.nextAction !== expected.nextAction) return false;
  if (
    session.nextAction === NEXT_ACTION.NONE ||
    session.nextAction === NEXT_ACTION.HUMAN_REVIEW
  ) {
    return false;
  }
  if (!session.nextWakeAt) return false;
  if (new Date(session.nextWakeAt).getTime() > now.getTime()) return false;
  return true;
}

/**
 * After markRunning, poll until Notion API read-back shows Running + expected
 * Next Action / Wake At so the AI Controller sees a consistent Session row.
 */
export async function waitForRunningVisibility(
  sessionPageUrl: string,
  expected: RunningVisibilityExpectation,
  startedAt: Date,
  timeoutMs = RUNNING_VISIBILITY_TIMEOUT_MS,
): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;
  let pollMs = 500;
  let last = await loadSession(sessionPageUrl);
  while (Date.now() < deadline) {
    if (isRunningVisibilityReady(last, expected, startedAt)) {
      logger.info("Running visibility confirmed", {
        pageId: last.pageId,
        nextAction: last.nextAction,
        nextWakeAt: last.nextWakeAt,
      });
      return last;
    }
    await new Promise((r) => setTimeout(r, pollMs));
    pollMs = Math.min(1_000, Math.round(pollMs * 1.5));
    last = await loadSession(sessionPageUrl);
  }
  throw new RunningVisibilityError(
    `Running visibility not confirmed within ${timeoutMs}ms: status=${last.status}, nextAction=${last.nextAction}, nextWakeAt=${last.nextWakeAt}`,
  );
}

/** Stagger retries when many workers hit the same consistency window. */
export function technicalRetryWakeAt(retryCount: number, now = new Date()): Date {
  const delayMs =
    TECHNICAL_RETRY_BACKOFF_BASE_MS * (retryCount + 1) +
    Math.floor(Math.random() * 15_000);
  return new Date(now.getTime() + delayMs);
}

export async function saveConversationUrl(pageId: string, url: string): Promise<void> {
  const ids = await propIds();
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: { [ids.conversationUrl]: { url: url.trim() || null } },
  });
}

export async function clearTechnicalError(pageId: string): Promise<void> {
  const ids = await propIds();
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: { [ids.lastError]: { rich_text: [] } },
  });
}

/**
 * Only clear Worker technical Last Error when the Session is still in a
 * schedulable state. Never wipe Prompt-written business pause reasons
 * (Paused / Human Owned / Closed / Error).
 */
export async function clearWorkerTechnicalErrorIfSafe(session: SessionRecord): Promise<boolean> {
  if (
    session.status !== SESSION_STATUS.PENDING &&
    session.status !== SESSION_STATUS.SLEEPING
  ) {
    return false;
  }
  await clearTechnicalError(session.pageId);
  return true;
}

export async function scheduleTechnicalRetry(
  pageId: string,
  errorMessage: string,
  currentRetryCount: number,
): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.PENDING);
  const wakeAt = technicalRetryWakeAt(currentRetryCount);
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.retryCount]: { number: currentRetryCount + 1 },
      [ids.nextWakeAt]: { date: { start: wakeAt.toISOString() } },
      [ids.lastError]: {
        rich_text: [{ type: "text", text: { content: errorMessage.slice(0, 2000) } }],
      },
    },
  });
}

export async function markAmbiguousOrError(
  pageId: string,
  errorMessage: string,
  phase: string,
): Promise<void> {
  const ids = await propIds();
  const msg =
    phase === "post-submit-ambiguous"
      ? `Ambiguous execution state: ${errorMessage}`
      : errorMessage;
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, SESSION_STATUS.ERROR);
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.lastError]: {
        rich_text: [{ type: "text", text: { content: msg.slice(0, 2000) } }],
      },
    },
  });
}

export interface DueSessionRow {
  pageId: string;
  pageUrl: string;
  nextWakeAt: string;
}

/** Status IN (Pending, Sleeping) AND Next Action NOT IN (None, Human Review) AND Next Wake At <= now */
export async function fetchDueSessions(limit = 20): Promise<DueSessionRow[]> {
  return withNotionRetry("fetchDueSessions", async () => {
  const client = getNotionClient();
  const ids = await propIds();
  const dataSourceId = await dsId();
  const nowIso = new Date().toISOString();

  const statusFilter =
    cachedStatusFieldType === "status"
      ? {
          or: [
            { property: ids.status, status: { equals: SESSION_STATUS.PENDING } },
            { property: ids.status, status: { equals: SESSION_STATUS.SLEEPING } },
          ],
        }
      : {
          or: [
            { property: ids.status, select: { equals: SESSION_STATUS.PENDING } },
            { property: ids.status, select: { equals: SESSION_STATUS.SLEEPING } },
          ],
        };

  // Notion API has no "not_in"; exclude None / Human Review via AND of does_not_equal
  const nextActionFilter =
    cachedNextActionFieldType === "status"
      ? {
          and: [
            { property: ids.nextAction, status: { does_not_equal: NEXT_ACTION.NONE } },
            { property: ids.nextAction, status: { does_not_equal: NEXT_ACTION.HUMAN_REVIEW } },
          ],
        }
      : {
          and: [
            { property: ids.nextAction, select: { does_not_equal: NEXT_ACTION.NONE } },
            { property: ids.nextAction, select: { does_not_equal: NEXT_ACTION.HUMAN_REVIEW } },
          ],
        };

  const response = await client.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      and: [
        statusFilter,
        nextActionFilter,
        { property: ids.nextWakeAt, date: { on_or_before: nowIso } },
      ],
    },
    sorts: [{ property: ids.nextWakeAt, direction: "ascending" }],
    page_size: limit,
    result_type: "page",
  });

  const rows: DueSessionRow[] = [];
  for (const page of response.results ?? []) {
    if (!page || !("id" in page)) continue;
    const pageProps = "properties" in page ? (page.properties as Record<string, unknown>) : {};
    const wake = getDateStart(pageProps, ids.nextWakeAt);
    if (!wake) continue;
    rows.push({ pageId: page.id, pageUrl: pageIdToUrl(page.id), nextWakeAt: wake });
  }
  return rows;
  });
}

/**
 * After the chat UI looks idle, poll Session until Prompt writeback leaves Running/Claimed.
 * Notion Agent often finishes UI before Session properties update.
 */
export async function waitForSessionWriteback(
  sessionPageUrl: string,
  startedAt: Date,
  timeoutMs: number,
): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;
  let last = await loadSession(sessionPageUrl);
  while (Date.now() < deadline) {
    const leftRunning =
      last.status !== SESSION_STATUS.CLAIMED && last.status !== SESSION_STATUS.RUNNING;
    const controlUpdated = Boolean(last.lastControlJson?.trim());
    const runAtFresh =
      last.lastRunAt &&
      new Date(last.lastRunAt).getTime() >= startedAt.getTime() - 60_000;
    if (leftRunning && controlUpdated && runAtFresh) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 2_000));
    last = await loadSession(sessionPageUrl);
  }
  return last;
}

export function validateSuccessfulSessionUpdate(session: SessionRecord, startedAt: Date): void {
  if (!session.lastRunAt) {
    throw new InvalidCompletionError("Last Run At is empty after run");
  }
  if (new Date(session.lastRunAt).getTime() < startedAt.getTime() - 60_000) {
    throw new InvalidCompletionError("Last Run At was not updated after this run");
  }
  if (
    session.status === SESSION_STATUS.CLAIMED ||
    session.status === SESSION_STATUS.RUNNING
  ) {
    throw new InvalidCompletionError(`Session still in ${session.status} after AI completion`);
  }
  if (!session.lastControlJson?.trim()) {
    throw new InvalidCompletionError("Last Control JSON was not updated after run");
  }

  switch (session.status) {
    case SESSION_STATUS.SLEEPING:
      if (!session.nextAction || session.nextAction === NEXT_ACTION.NONE) {
        throw new InvalidCompletionError("Sleeping requires Next Action");
      }
      if (!session.nextWakeAt) {
        throw new InvalidCompletionError("Sleeping requires Next Wake At");
      }
      break;
    case SESSION_STATUS.PENDING:
      if (!session.nextAction || session.nextAction === NEXT_ACTION.NONE) {
        throw new InvalidCompletionError("Pending requires Next Action");
      }
      if (!session.nextWakeAt) {
        throw new InvalidCompletionError("Pending requires Next Wake At");
      }
      break;
    case SESSION_STATUS.CLOSED:
    case SESSION_STATUS.HUMAN_OWNED:
      if (session.nextAction && session.nextAction !== NEXT_ACTION.NONE) {
        throw new InvalidCompletionError(`${session.status} requires Next Action=None`);
      }
      if (session.nextWakeAt) {
        throw new InvalidCompletionError(`${session.status} should have empty Next Wake At`);
      }
      break;
    case SESSION_STATUS.PAUSED:
      if (
        session.nextAction !== NEXT_ACTION.HUMAN_REVIEW &&
        !session.wakeReason?.trim() &&
        !session.lastError?.trim()
      ) {
        throw new InvalidCompletionError(
          "Paused requires Next Action=Human Review or a Wake Reason / Last Error",
        );
      }
      break;
    case SESSION_STATUS.ERROR:
      if (!session.lastError?.trim()) {
        throw new InvalidCompletionError("Error status requires Last Error");
      }
      break;
    default:
      break;
  }
}

export function sessionSnapshot(session: SessionRecord): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    status: session.status,
    next_action: session.nextAction,
    conversation_url: session.conversationUrl,
    next_wake_at: session.nextWakeAt,
    last_run_at: session.lastRunAt,
    last_control_json: session.lastControlJson,
    last_error: session.lastError,
    wake_reason: session.wakeReason,
    wake_payload_event_id: session.wakePayloadEventId,
    retry_count: session.retryCount,
    has_latest_interaction: session.hasLatestInteraction,
  };
}

export function resetSessionCache(): void {
  cachedDsId = null;
  cachedIds = null;
  cachedStatusFieldType = "status";
  cachedNextActionFieldType = "select";
}

export async function applyControlJsonWriteback(
  pageId: string,
  control: ParsedControlJson,
): Promise<void> {
  if (!control.sessionStatus) {
    throw new Error("applyControlJsonWriteback requires sessionStatus");
  }
  const ids = await propIds();
  const dataSourceId = await dsId();
  const properties: Record<string, unknown> = {
    ...(await statusUpdatePayload(dataSourceId, ids.status, control.sessionStatus)),
  };
  if (control.nextAction) {
    Object.assign(
      properties,
      await namedOptionUpdatePayload(dataSourceId, ids.nextAction, control.nextAction),
    );
  }
  if (
    control.sessionStatus === SESSION_STATUS.CLOSED ||
    control.sessionStatus === SESSION_STATUS.HUMAN_OWNED
  ) {
    properties[ids.nextWakeAt] = { date: null };
  } else if (control.nextWakeAt) {
    properties[ids.nextWakeAt] = { date: { start: control.nextWakeAt } };
  }
  await getNotionClient().pages.update({ page_id: pageId, properties });
}

/**
 * If Status is stuck Claimed/Running but Last Control JSON already describes a
 * terminal/schedulable state, apply Status / Next Action / Next Wake At from JSON.
 */
export async function reconcileSessionFromControlJson(
  session: SessionRecord,
): Promise<SessionRecord | null> {
  if (
    session.status !== SESSION_STATUS.CLAIMED &&
    session.status !== SESSION_STATUS.RUNNING &&
    session.status !== SESSION_STATUS.ERROR
  ) {
    return null;
  }
  const parsed = parseSessionControlJson(session.lastControlJson);
  if (!isReconcileableControlJson(parsed)) return null;
  // Only auto-reconcile Error when control says we already left Running.
  if (
    session.status === SESSION_STATUS.ERROR &&
    (parsed!.sessionStatus === SESSION_STATUS.ERROR ||
      parsed!.sessionStatus === SESSION_STATUS.CLAIMED ||
      parsed!.sessionStatus === SESSION_STATUS.RUNNING)
  ) {
    return null;
  }
  logger.info("Reconciling Session from Last Control JSON", {
    pageId: session.pageId,
    fromStatus: session.status,
    toStatus: parsed!.sessionStatus,
    nextAction: parsed!.nextAction,
  });
  await applyControlJsonWriteback(session.pageId, parsed!);
  await clearTechnicalError(session.pageId);
  return loadSession(session.pageUrl);
}

export interface ReclaimResult {
  reclaimed: number;
  reconciled: number;
  details: Array<{ pageId: string; action: string; reason: string }>;
}

export async function reclaimStuckSessions(now = new Date()): Promise<ReclaimResult> {
  const result: ReclaimResult = { reclaimed: 0, reconciled: 0, details: [] };
  try {
    const client = getNotionClient();
    const ids = await propIds();
    const dataSourceId = await dsId();

    const response = await withNotionRetry("reclaimStuckSessions", async () =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        filter: {
          or: [
            statusEqualsFilter(ids.status, SESSION_STATUS.CLAIMED),
            statusEqualsFilter(ids.status, SESSION_STATUS.RUNNING),
            statusEqualsFilter(ids.status, SESSION_STATUS.ERROR),
          ],
        },
        page_size: 100,
        result_type: "page",
      }),
    );

    // Snapshot IDs before mutations so cursor pagination cannot skip rows.
    const pageIds = (response.results ?? [])
      .filter((p): p is { id: string } => Boolean(p && "id" in p))
      .map((p) => p.id);

    const nowMs = now.getTime();

    for (const pageId of pageIds) {
      try {
        const session = await loadSession(pageIdToUrl(pageId));

        if (
          session.status === SESSION_STATUS.RUNNING ||
          session.status === SESSION_STATUS.CLAIMED
        ) {
          // Never reclaim a Session another worker is actively holding —
          // Claimed with empty Last Run At looks "stale" until markRunning,
          // and reclaiming it to Pending is what Controller then reads.
          if (await isLockHeld("session", session.pageId)) {
            result.details.push({
              pageId: session.pageId,
              action: "skipped_locked",
              reason: "active_session_lock",
            });
            continue;
          }

          const reconciled = await reconcileSessionFromControlJson(session);
          if (reconciled) {
            result.reconciled++;
            result.details.push({
              pageId: session.pageId,
              action: "reconciled",
              reason: `control_json -> ${reconciled.status}`,
            });
            continue;
          }
          if (
            isStaleClaimOrRunning(session.status, session.lastRunAt, nowMs, STALE_CLAIM_MS)
          ) {
            await releaseToPendingWithError(session.pageId, "reclaimed_stale_claim");
            result.reclaimed++;
            result.details.push({
              pageId: session.pageId,
              action: "reclaimed_pending",
              reason: "stale_claim_or_running",
            });
          }
          continue;
        }

        if (session.status === SESSION_STATUS.ERROR) {
          const reconciled = await reconcileSessionFromControlJson(session);
          if (reconciled) {
            result.reconciled++;
            result.details.push({
              pageId: session.pageId,
              action: "reconciled",
              reason: `error_control_json -> ${reconciled.status}`,
            });
            continue;
          }
          const err = session.lastError || "";
          if (
            TECHNICAL_SESSION_ERROR_RE.test(err) &&
            session.retryCount < MAX_TECHNICAL_RETRIES
          ) {
            await scheduleTechnicalRetry(session.pageId, err, session.retryCount);
            result.reclaimed++;
            result.details.push({
              pageId: session.pageId,
              action: "reclaimed_pending",
              reason: "technical_error",
            });
          }
        }
      } catch (e) {
        logger.warn("reclaimStuckSessions: skip one session", {
          pageId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    const cause =
      e instanceof Error && e.cause instanceof Error
        ? `${e.message} (${e.cause.message})`
        : e instanceof Error
          ? e.message
          : String(e);
    logger.warn(
      "reclaimStuckSessions failed (non-fatal; poll will continue): " + cause,
    );
  }

  return result;
}

export type SessionStatusCounts = Record<string, number>;

export async function countSessionsByStatus(): Promise<SessionStatusCounts> {
  return withNotionRetry("countSessionsByStatus", async () => {
    const client = getNotionClient();
    const ids = await propIds();
    const dataSourceId = await dsId();
    const counts: SessionStatusCounts = {};
    let cursor: string | undefined;
    do {
      const response = await client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        start_cursor: cursor,
        result_type: "page",
      });
      for (const page of response.results ?? []) {
        if (!page || !("properties" in page)) continue;
        const pageProps = page.properties as Record<string, unknown>;
        const status = getSelectName(pageProps, ids.status) || "unknown";
        counts[status] = (counts[status] || 0) + 1;
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return counts;
  });
}

export interface MissingInteractionRow {
  pageId: string;
  pageUrl: string;
  sessionName: string;
  status: string | null;
  nextAction: string | null;
  nextWakeAt: string | null;
  lastError: string | null;
}

/** Due-ish sessions missing Latest Interaction (diagnose). */
export async function listDueMissingLatestInteraction(
  limit = 50,
): Promise<MissingInteractionRow[]> {
  const client = getNotionClient();
  const ids = await propIds();
  const dataSourceId = await dsId();
  if (!ids.latestInteraction) return [];

  const nowIso = new Date().toISOString();
  const response = await client.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      and: [
        { property: ids.nextWakeAt, date: { on_or_before: nowIso } },
        { property: ids.latestInteraction, relation: { is_empty: true } },
      ],
    },
    sorts: [{ property: ids.nextWakeAt, direction: "ascending" }],
    page_size: limit,
    result_type: "page",
  });

  const rows: MissingInteractionRow[] = [];
  for (const page of response.results ?? []) {
    if (!page || !("id" in page) || !("properties" in page)) continue;
    const pageProps = page.properties as Record<string, unknown>;
    const titleProp = Object.values(pageProps).find(
      (p) => (p as { type?: string }).type === "title",
    ) as { title?: Array<{ plain_text?: string }> } | undefined;
    const name =
      titleProp?.title?.map((t) => t.plain_text || "").join("") || page.id;
    rows.push({
      pageId: page.id,
      pageUrl: pageIdToUrl(page.id),
      sessionName: name,
      status: getSelectName(pageProps, ids.status),
      nextAction: getSelectName(pageProps, ids.nextAction),
      nextWakeAt: getDateStart(pageProps, ids.nextWakeAt),
      lastError: getRichText(pageProps, ids.lastError) || null,
    });
  }
  return rows;
}

/** One-shot heal: Claimed → Pending; technical Error → Pending or reconcile. */
export async function healStuckSessions(): Promise<{
  releasedClaimed: number;
  releasedErrors: number;
  reconciled: number;
}> {
  const client = getNotionClient();
  const ids = await propIds();
  const dataSourceId = await dsId();
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const props = ("properties" in ds && ds.properties) || {};
  const statusProp = props[ids.status] as { type?: string } | undefined;
  const statusEquals = (name: string) =>
    statusProp?.type === "status"
      ? { property: ids.status, status: { equals: name } }
      : { property: ids.status, select: { equals: name } };

  // Collect IDs first — mutating during cursor pagination skips rows.
  const pageIds: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        or: [statusEquals(SESSION_STATUS.CLAIMED), statusEquals(SESSION_STATUS.ERROR)],
      },
      page_size: 100,
      start_cursor: cursor,
      result_type: "page",
    });
    for (const page of response.results ?? []) {
      if (page && "id" in page) pageIds.push(page.id);
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  let releasedClaimed = 0;
  let releasedErrors = 0;
  let reconciled = 0;

  for (const pageId of pageIds) {
    const session = await loadSession(pageIdToUrl(pageId));
    if (session.status === SESSION_STATUS.CLAIMED) {
      await releaseToPendingWithError(session.pageId, "healed_claimed");
      releasedClaimed++;
      continue;
    }
    if (session.status !== SESSION_STATUS.ERROR) continue;

    const fromControl = await reconcileSessionFromControlJson(session);
    if (fromControl) {
      reconciled++;
      continue;
    }
    if (TECHNICAL_SESSION_ERROR_RE.test(session.lastError || "")) {
      await releaseToPendingWithError(
        session.pageId,
        session.lastError || "technical_heal",
      );
      releasedErrors++;
    }
  }

  return { releasedClaimed, releasedErrors, reconciled };
}
