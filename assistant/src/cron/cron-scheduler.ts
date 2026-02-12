import { getLogger } from '../util/logger.js';
import { createConversation } from '../memory/conversation-store.js';
import {
  claimDueCronJobs,
  createCronRun,
  completeCronRun,
} from './cron-store.js';

const log = getLogger('cron-scheduler');

export type CronMessageProcessor = (
  conversationId: string,
  message: string,
) => Promise<unknown>;

export interface CronScheduler {
  runOnce(): Promise<number>;
  stop(): void;
}

const TICK_INTERVAL_MS = 15_000;

export function startCronScheduler(processMessage: CronMessageProcessor): CronScheduler {
  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runCronOnce(processMessage);
    } catch (err) {
      log.error({ err }, 'Cron scheduler tick failed');
    } finally {
      tickRunning = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  timer.unref();
  void tick();

  return {
    async runOnce(): Promise<number> {
      return runCronOnce(processMessage);
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function runCronOnce(processMessage: CronMessageProcessor): Promise<number> {
  const now = Date.now();
  const jobs = claimDueCronJobs(now);
  if (jobs.length === 0) return 0;

  let processed = 0;
  for (const job of jobs) {
    const conversation = createConversation(`Cron: ${job.name}`);
    const runId = createCronRun(job.id, conversation.id);

    try {
      log.info({ jobId: job.id, name: job.name, conversationId: conversation.id }, 'Executing cron job');
      await processMessage(conversation.id, job.message);
      completeCronRun(runId, { status: 'ok' });
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: job.id, name: job.name }, 'Cron job execution failed');
      completeCronRun(runId, { status: 'error', error: message });
    }
  }

  log.info({ processed, total: jobs.length }, 'Cron tick complete');
  return processed;
}
