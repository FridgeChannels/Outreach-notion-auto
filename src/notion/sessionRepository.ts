import {
  PROP,
  SESSION_DATA_SOURCE_URL,
  SESSION_STATUS,
  NEXT_ACTION,
  type SessionStatus,
  type NextAction,
} from "../config.js";
import { InvalidCompletionError } from "../errors.js";
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
  isFullPage,
  withNotionRetry,
} from "./helpers.js";

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
  wakePayloadJson: string | null;
  wakeReason: string | null;
}

let cachedDsId: string | null = null;
let cachedIds: PropIds | null = null;

async function dsId(): Promise<string> {
  if (!cachedDsId) cachedDsId = await resolveDataSourceId(SESSION_DATA_SOURCE_URL);
  return cachedDsId;
}

async function propIds(): Promise<PropIds> {
  if (cachedIds) return cachedIds;
  const client = getNotionClient();
  const ds = await client.dataSources.retrieve({ data_source_id: await dsId() });
  const props = ("properties" in ds && ds.properties) || {};
  const req = (name: string) => {
    const id = findPropertyId(props, name);
    if (!id) throw new Error(`Session property not found: ${name}`);
    return id;
  };
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
  const wakeIso = new Date().toISOString();
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.retryCount]: { number: currentRetryCount + 1 },
      [ids.nextWakeAt]: { date: { start: wakeIso } },
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
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const props = ("properties" in ds && ds.properties) || {};
  const statusProp = props[ids.status] as { type?: string } | undefined;
  const nextActionProp = props[ids.nextAction] as { type?: string } | undefined;
  const nowIso = new Date().toISOString();

  const statusFilter =
    statusProp?.type === "status"
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
    nextActionProp?.type === "status"
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
  };
}

export function resetSessionCache(): void {
  cachedDsId = null;
  cachedIds = null;
}
