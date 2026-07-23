import "dotenv/config";
import { fetchDueSessions, loadSession, releaseClaimToPending } from "../src/notion/sessionRepository.js";
import { fetchDueMailboxes, loadMailbox } from "../src/notion/mailboxRepository.js";
import { pageIdToUrl } from "../src/notion/helpers.js";
import { getNotionClient, resolveDataSourceId } from "../src/notion/helpers.js";
import { SESSION_DATA_SOURCE_URL, SESSION_STATUS } from "../src/config.js";
import { MAILBOX_STATE_DATA_SOURCE_URL } from "../src/config.js";

async function main(): Promise<void> {
  const release = process.argv.includes("--release-claimed");

  if (release) {
    const client = getNotionClient();
    const dsId = await resolveDataSourceId(SESSION_DATA_SOURCE_URL);
    const resp = await client.dataSources.query({
      data_source_id: dsId,
      page_size: 100,
      result_type: "page",
    });
    let n = 0;
    for (const page of resp.results ?? []) {
      if (!("id" in page)) continue;
      const s = await loadSession(pageIdToUrl(page.id));
      if (s.status === SESSION_STATUS.CLAIMED) {
        await releaseClaimToPending(page.id);
        console.log(`Released ${page.id} -> Pending`);
        n++;
      }
    }
    console.log(`Released ${n} Claimed session(s).`);
    return;
  }

  console.log("=== Due Outreach Sessions ===");
  const dueSessions = await fetchDueSessions(20);
  console.log(`count=${dueSessions.length}`);
  for (const r of dueSessions) console.log(`  ${r.pageId} wake=${r.nextWakeAt}`);

  console.log("\n=== Sample Sessions ===");
  const client = getNotionClient();
  const sessionDs = await resolveDataSourceId(SESSION_DATA_SOURCE_URL);
  const sessionPages = await client.dataSources.query({
    data_source_id: sessionDs,
    page_size: 10,
    result_type: "page",
  });
  for (const page of sessionPages.results ?? []) {
    if (!("id" in page)) continue;
    const s = await loadSession(pageIdToUrl(page.id));
    console.log({
      status: s.status,
      nextAction: s.nextAction,
      nextWakeAt: s.nextWakeAt,
      hasClient: Boolean(s.clientPageId),
      conversationUrl: s.conversationUrl,
    });
  }

  console.log("\n=== Due Mailboxes ===");
  try {
    const dueMailboxes = await fetchDueMailboxes(10);
    console.log(`count=${dueMailboxes.length}`);
    for (const r of dueMailboxes) console.log(`  ${r.pageId} nextScan=${r.nextScanAt}`);

    const mailboxDs = await resolveDataSourceId(MAILBOX_STATE_DATA_SOURCE_URL);
    const mailboxPages = await client.dataSources.query({
      data_source_id: mailboxDs,
      page_size: 10,
      result_type: "page",
    });
    console.log("\n=== Sample Mailboxes ===");
    for (const page of mailboxPages.results ?? []) {
      if (!("id" in page)) continue;
      const m = await loadMailbox(pageIdToUrl(page.id));
      console.log({
        mailbox: m.mailbox,
        status: m.status,
        nextScanAt: m.nextScanAt,
        conversationUrl: m.conversationUrl,
      });
    }
  } catch (e) {
    console.log("Mailbox diagnose skipped:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
