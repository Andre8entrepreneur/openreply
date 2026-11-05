import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
// Each heartbeat is one Redis write. Keep it well under the health TTL
// (WORKER_HEARTBEAT_TTL_SECONDS) so one missed beat doesn't flag the worker down.
// Hourly keeps this to 24 Redis writes/day (was 1,440 at 60s).
const HEARTBEAT_INTERVAL_MS = Number(
  process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 60 * 60_000
);
// Optional polling safety net for comments that webhooks miss. Off by default:
// the worker is then purely event-driven and only acts when Instagram's webhook
// reports a new comment or DM. Set COMMENT_POLL_INTERVAL_MS (e.g. 300000) to
// turn the sweep back on.
const POLL_INTERVAL_MS = Number(process.env.COMMENT_POLL_INTERVAL_MS ?? 0);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval — only when
// polling is enabled.
let pollTimer: ReturnType<typeof setInterval> | undefined;
if (POLL_INTERVAL_MS > 0) {
  setTimeout(() => void poll(), 10_000);
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  console.log(`[DM Worker] Comment polling every ${POLL_INTERVAL_MS / 1000}s`);
} else {
  console.log("[DM Worker] Comment polling off — webhook-triggered only");
}

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
