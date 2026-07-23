import {
  MAILBOX_PROP,
  MAILBOX_STATE_DATA_SOURCE_URL,
  MAILBOX_STATUS,
  type MailboxStatus,
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
  pageIdToUrl,
  parsePageUrl,
  statusUpdatePayload,
  isFullPage,
  withNotionRetry,
} from "./helpers.js";

export interface MailboxRecord {
  pageId: string;
  pageUrl: string;
  mailbox: string;
  status: MailboxStatus | null;
  conversationUrl: string | null;
  model: string | null;
  nextScanAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
}

interface PropIds {
  status: string;
  conversationUrl: string;
  model: string;
  nextScanAt: string;
  lastCheckedAt: string;
  lastSuccessfulAt: string;
  lastError: string;
  mailbox: string;
}

let cachedDsId: string | null = null;
let cachedIds: PropIds | null = null;

async function dsId(): Promise<string> {
  if (!cachedDsId) cachedDsId = await resolveDataSourceId(MAILBOX_STATE_DATA_SOURCE_URL);
  return cachedDsId;
}

async function propIds(): Promise<PropIds> {
  if (cachedIds) return cachedIds;
  const client = getNotionClient();
  const ds = await client.dataSources.retrieve({ data_source_id: await dsId() });
  const props = ("properties" in ds && ds.properties) || {};
  const req = (name: string) => {
    const id = findPropertyId(props, name);
    if (!id) throw new Error(`Mailbox property not found: ${name}`);
    return id;
  };
  cachedIds = {
    status: req(MAILBOX_PROP.STATUS),
    conversationUrl: req(MAILBOX_PROP.CONVERSATION_URL),
    model: req(MAILBOX_PROP.MODEL),
    nextScanAt: req(MAILBOX_PROP.NEXT_SCAN_AT),
    lastCheckedAt: req(MAILBOX_PROP.LAST_CHECKED_AT),
    lastSuccessfulAt: req(MAILBOX_PROP.LAST_SUCCESSFUL_AT),
    lastError: req(MAILBOX_PROP.LAST_ERROR),
    mailbox: req(MAILBOX_PROP.MAILBOX),
  };
  return cachedIds;
}

export async function loadMailbox(pageUrl: string): Promise<MailboxRecord> {
  const pageId = parsePageUrl(pageUrl);
  if (!pageId) throw new Error(`Invalid mailbox page URL: ${pageUrl}`);
  const ids = await propIds();
  const page = await getNotionClient().pages.retrieve({ page_id: pageId });
  if (!isFullPage(page)) throw new Error("Mailbox page is not a full page");
  const props = page.properties as Record<string, unknown>;
  return {
    pageId,
    pageUrl: pageIdToUrl(pageId),
    mailbox: getRichText(props, ids.mailbox),
    status: getSelectName(props, ids.status) as MailboxStatus | null,
    conversationUrl: getUrl(props, ids.conversationUrl) || null,
    model: getRichText(props, ids.model) || null,
    nextScanAt: getDateStart(props, ids.nextScanAt),
    lastCheckedAt: getDateStart(props, ids.lastCheckedAt),
    lastSuccessfulAt: getDateStart(props, ids.lastSuccessfulAt),
    lastError: getRichText(props, ids.lastError) || null,
  };
}

export async function markScanning(pageId: string, now: Date): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, MAILBOX_STATUS.SCANNING);
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.lastCheckedAt]: { date: { start: now.toISOString() } },
      [ids.lastError]: { rich_text: [] },
    },
  });
}

export async function saveMailboxConversationUrl(pageId: string, url: string): Promise<void> {
  const ids = await propIds();
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: { [ids.conversationUrl]: { url: url.trim() || null } },
  });
}

export async function markMailboxError(pageId: string, errorMessage: string): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, MAILBOX_STATUS.ERROR);
  const next = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await getNotionClient().pages.update({
    page_id: pageId,
    properties: {
      ...statusPart,
      [ids.lastError]: {
        rich_text: [{ type: "text", text: { content: errorMessage.slice(0, 2000) } }],
      },
      [ids.nextScanAt]: { date: { start: next } },
    },
  });
}

export async function releaseScanningToActive(pageId: string): Promise<void> {
  const ids = await propIds();
  const statusPart = await statusUpdatePayload(await dsId(), ids.status, MAILBOX_STATUS.ACTIVE);
  await getNotionClient().pages.update({ page_id: pageId, properties: statusPart });
}

export interface DueMailboxRow {
  pageId: string;
  pageUrl: string;
  nextScanAt: string;
}

/** Status = Active AND Next Scan At <= now */
export async function fetchDueMailboxes(limit = 10): Promise<DueMailboxRow[]> {
  return withNotionRetry("fetchDueMailboxes", async () => {
  const client = getNotionClient();
  const ids = await propIds();
  const dataSourceId = await dsId();
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const props = ("properties" in ds && ds.properties) || {};
  const statusProp = props[ids.status] as { type?: string } | undefined;
  const nowIso = new Date().toISOString();

  const statusFilter =
    statusProp?.type === "status"
      ? { property: ids.status, status: { equals: MAILBOX_STATUS.ACTIVE } }
      : { property: ids.status, select: { equals: MAILBOX_STATUS.ACTIVE } };

  const response = await client.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      and: [statusFilter, { property: ids.nextScanAt, date: { on_or_before: nowIso } }],
    },
    sorts: [{ property: ids.nextScanAt, direction: "ascending" }],
    page_size: limit,
    result_type: "page",
  });

  const rows: DueMailboxRow[] = [];
  for (const page of response.results ?? []) {
    if (!page || !("id" in page)) continue;
    const pageProps = "properties" in page ? (page.properties as Record<string, unknown>) : {};
    const next = getDateStart(pageProps, ids.nextScanAt);
    if (!next) continue;
    rows.push({ pageId: page.id, pageUrl: pageIdToUrl(page.id), nextScanAt: next });
  }
  return rows;
  });
}

export function validateSuccessfulMailboxUpdate(
  mailbox: MailboxRecord,
  startedAt: Date,
): void {
  if (mailbox.status === MAILBOX_STATUS.SCANNING) {
    throw new InvalidCompletionError("Mailbox still Scanning after AI completion");
  }
  if (mailbox.status === MAILBOX_STATUS.ACTIVE) {
    if (!mailbox.lastSuccessfulAt) {
      throw new InvalidCompletionError("Active mailbox missing Last Successful At");
    }
    if (!mailbox.nextScanAt) {
      throw new InvalidCompletionError("Active mailbox missing Next Scan At");
    }
    if (new Date(mailbox.nextScanAt).getTime() <= startedAt.getTime()) {
      throw new InvalidCompletionError("Next Scan At was not advanced after successful scan");
    }
    return;
  }
  if (mailbox.status === MAILBOX_STATUS.ERROR) {
    if (!mailbox.lastError?.trim()) {
      throw new InvalidCompletionError("Error mailbox missing Last Error");
    }
    if (!mailbox.nextScanAt) {
      throw new InvalidCompletionError("Error mailbox missing Next Scan At");
    }
    return;
  }
  throw new InvalidCompletionError(`Unexpected mailbox status after scan: ${mailbox.status}`);
}

export function mailboxSnapshot(m: MailboxRecord): Record<string, unknown> {
  return {
    mailbox: m.mailbox,
    status: m.status,
    conversation_url: m.conversationUrl,
    next_scan_at: m.nextScanAt,
    last_checked_at: m.lastCheckedAt,
    last_successful_at: m.lastSuccessfulAt,
    last_error: m.lastError,
  };
}

export function resetMailboxCache(): void {
  cachedDsId = null;
  cachedIds = null;
}
