import { getLogger } from '../util/logger.js';
import { createConversation } from '../memory/conversation-store.js';
import {
  claimDueSchedules,
  createScheduleRun,
  completeScheduleRun,
} from './schedule-store.js';

const log = getLogger('scheduler');

export type ScheduleMessageProcessor = (
  conversationId: string,
  message: string,
) => Promise<unknown>;

export interface SchedulerHandle {
  runOnce(): Promise<number>;
  stop(): void;
}

const TICK_INTERVAL_MS = 15_000;

export function startScheduler(processMessage: ScheduleMessageProcessor): SchedulerHandle {
  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runScheduleOnce(processMessage);
    } catch (err) {
      log.error({ err }, 'Schedule tick failed');
    } finally {
      tickRunning = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  timer.unref();
  void tick();

  return {
    async runOnce(): Promise<number> {
      return runScheduleOnce(processMessage);
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function runScheduleOnce(processMessage: ScheduleMessageProcessor): Promise<number> {
  const now = Date.now();
  const jobs = claimDueSchedules(now);
  if (jobs.length === 0) return 0;

  let processed = 0;
  for (const job of jobs) {
    const conversation = createConversation(`Schedule: ${job.name}`);
    const runId = createScheduleRun(job.id, conversation.id);

    try {
      log.info({ jobId: job.id, name: job.name, conversationId: conversation.id }, 'Executing schedule');
      await processMessage(conversation.id, job.message);
      completeScheduleRun(runId, { status: 'ok' });
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: job.id, name: job.name }, 'Schedule execution failed');
      completeScheduleRun(runId, { status: 'error', error: message });
    }
  }

  log.info({ processed, total: jobs.length }, 'Schedule tick complete');
  return processed;
}
