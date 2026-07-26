import "dotenv/config";
import { SESSION_POLL_INTERVAL_MS, validateEnv, WORKER_ID } from "./config.js";
import { preflightBrowserEnvironment } from "./browser.js";
import { pollOnce } from "./flows/poll.js";
import { clearLocksOwnedByThisWorker } from "./locks.js";
import { logger } from "./logging.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseQueues(args: string[]): Array<"outreach" | "mailbox"> {
  const flag = args.find((a) => a.startsWith("--queue="));
  if (!flag) return ["outreach", "mailbox"];
  const v = flag.slice("--queue=".length);
  if (v === "outreach" || v === "mailbox") return [v];
  if (v === "all") return ["outreach", "mailbox"];
  logger.error(`Unknown --queue=${v}; use outreach|mailbox|all`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`FC2.0 Outreach Playwright Worker

Usage:
  npm run worker                 Poll both queues in a loop
  npm run worker:once            Single poll cycle for both queues
  npm run worker:outreach        Single poll for Outreach Session queue
  npm run worker:mailbox         Single poll for Mailbox Scan queue
  npm run worker:login           Interactive web login → auth/<account>.json
  npm run worker:export-auth     Export cookies from old NOTION_PROFILE_DIR
  npm run worker:diagnose        Inspect due sessions / mailboxes

Env: see .env.example
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const queues = parseQueues(args);
  const missing = validateEnv(queues);
  if (missing.length) {
    logger.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const cleared = await clearLocksOwnedByThisWorker();
  if (cleared) logger.info(`Cleared ${cleared} stale lock(s) from prior ${WORKER_ID} run`);

  try {
    await preflightBrowserEnvironment();
  } catch (e) {
    logger.error("Browser preflight failed — fix disk/temp/profile before running", e);
    process.exit(1);
  }

  if (args.includes("--once")) {
    logger.info(`Worker ${WORKER_ID} once`, { queues });
    await pollOnce(queues);
    return;
  }

  logger.info(`Worker ${WORKER_ID} poll loop`, { queues });
  for (;;) {
    try {
      await pollOnce(queues);
    } catch (e) {
      logger.error("Poll cycle failed", e);
    }
    await sleep(SESSION_POLL_INTERVAL_MS);
  }
}

main().catch((e) => {
  logger.error("Fatal", e);
  process.exit(1);
});
