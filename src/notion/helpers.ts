import { Client, extractDatabaseId, extractPageId, isFullPage } from "@notionhq/client";
import { NOTION_API_KEY } from "../config.js";
import { logger } from "../logging.js";

let cachedClient: Client | null = null;

export function getNotionClient(): Client {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY not configured");
  if (!cachedClient) cachedClient = new Client({ auth: NOTION_API_KEY });
  return cachedClient;
}

function isTransientNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
  const code = cause && "code" in cause ? String((cause as { code?: string }).code) : "";
  return (
    /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket|TLS|network/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|UND_ERR/i.test(code)
  );
}

/** Retry Notion API calls on transient TLS/network blips (common on flaky proxies). */
export async function withNotionRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientNetworkError(e) || i === attempts) throw e;
      const waitMs = Math.min(8_000, 400 * 2 ** (i - 1));
      const cause =
        e instanceof Error && e.cause instanceof Error
          ? `${e.message} (${(e.cause as Error).message})`
          : e instanceof Error
            ? e.message
            : String(e);
      logger.warn(`Notion API transient failure on ${label}; retry ${i}/${attempts} in ${waitMs}ms`, {
        cause,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

function toDashedPageId(raw: string): string | null {
  const compact = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function pageIdToUrl(pageId: string): string {
  const dashed = toDashedPageId(pageId);
  if (!dashed) throw new Error(`Invalid page id: ${pageId}`);
  return `https://www.notion.so/${dashed}`;
}

/**
 * Parse a Notion page URL into a dashed UUID.
 * @notionhq/client extractPageId only accepts compact ids in www.notion.so paths,
 * so we also handle dashed UUIDs produced by pageIdToUrl / normalizeNotionPageUrl.
 */
export function parsePageUrl(url: string): string | null {
  const fromSdk = extractPageId(url);
  if (fromSdk) return toDashedPageId(fromSdk) ?? fromSdk;
  try {
    const path = new URL(url).pathname;
    const dashed = path.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    )?.[1];
    if (dashed) return toDashedPageId(dashed);
    const compact = path.match(/([0-9a-f]{32})/i)?.[1];
    if (compact) return toDashedPageId(compact);
  } catch {
    // fall through
  }
  return null;
}

export async function resolveDataSourceId(databaseUrl: string): Promise<string> {
  const client = getNotionClient();
  const databaseId = extractDatabaseId(databaseUrl);
  if (!databaseId) throw new Error(`Cannot parse database id from ${databaseUrl}`);
  const db = await client.databases.retrieve({ database_id: databaseId });
  if (!("data_sources" in db) || !Array.isArray(db.data_sources) || !db.data_sources[0]?.id) {
    throw new Error("Database has no data source");
  }
  return db.data_sources[0].id;
}

export function findPropertyId(
  properties: Record<string, { id?: string; name?: string; type?: string }>,
  name: string,
): string | null {
  for (const [id, prop] of Object.entries(properties)) {
    if (prop?.name === name || id === name) return id;
  }
  return null;
}

export function getRichText(props: Record<string, unknown>, id: string): string {
  const p = props[id] as { type?: string; rich_text?: Array<{ plain_text?: string }>; title?: Array<{ plain_text?: string }> };
  if (p?.type === "rich_text" && Array.isArray(p.rich_text)) {
    return p.rich_text.map((t) => t.plain_text ?? "").join("");
  }
  if (p?.type === "title" && Array.isArray(p.title)) {
    return p.title.map((t) => t.plain_text ?? "").join("");
  }
  return "";
}

export function getUrl(props: Record<string, unknown>, id: string): string {
  const p = props[id] as { type?: string; url?: string | null };
  return p?.type === "url" && typeof p.url === "string" ? p.url : "";
}

export function getSelectName(props: Record<string, unknown>, id: string): string | null {
  const p = props[id] as {
    type?: string;
    status?: { name?: string };
    select?: { name?: string };
  };
  return p?.status?.name ?? p?.select?.name ?? null;
}

export function getDateStart(props: Record<string, unknown>, id: string): string | null {
  const p = props[id] as { type?: string; date?: { start?: string | null } | null };
  return p?.type === "date" && p.date?.start ? p.date.start : null;
}

export function getNumber(props: Record<string, unknown>, id: string): number {
  const p = props[id] as { type?: string; number?: number | null };
  return p?.type === "number" && typeof p.number === "number" ? p.number : 0;
}

export function getRelationPageIds(props: Record<string, unknown>, id: string): string[] {
  const p = props[id] as { type?: string; relation?: Array<{ id?: string }> };
  if (p?.type !== "relation" || !Array.isArray(p.relation)) return [];
  return p.relation.map((r) => r.id).filter((x): x is string => Boolean(x));
}

export async function statusUpdatePayload(
  dataSourceId: string,
  statusPropId: string,
  status: string,
): Promise<Record<string, unknown>> {
  const client = getNotionClient();
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const props = ("properties" in ds && ds.properties) || {};
  const statusProp = props[statusPropId] as { type?: string } | undefined;
  return statusProp?.type === "status"
    ? { [statusPropId]: { status: { name: status } } }
    : { [statusPropId]: { select: { name: status } } };
}

/** Next Action (and similar) may be status or select depending on DB schema. */
export async function namedOptionUpdatePayload(
  dataSourceId: string,
  propId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const client = getNotionClient();
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const props = ("properties" in ds && ds.properties) || {};
  const prop = props[propId] as { type?: string } | undefined;
  return prop?.type === "status"
    ? { [propId]: { status: { name } } }
    : { [propId]: { select: { name } } };
}

export { isFullPage, extractDatabaseId };
