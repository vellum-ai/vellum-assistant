/**
 * The resource-sample shape captured by the monitor (`resource-sampler.ts`),
 * consumed by the stall-capture monitor (`stall-capture.ts`) and rendered by
 * the monitoring routes: a point-in-time snapshot of cgroup memory/CPU, disk,
 * and the conversations mid-turn at capture time.
 */
import type { ContainerCpuStat } from "../util/cgroup-cpu.js";
import type {
  ContainerMemoryEvents,
  ContainerMemoryStat,
  ContainerReclaimCounters,
} from "../util/cgroup-memory.js";
import type { ActiveConversation } from "./active-conversations.js";

export interface ResourceSampleMemory {
  currentBytes: number;
  limitBytes: number | null;
  peakBytes: number | null;
  /** current / limit, or null when the limit is unknown. */
  ratio: number | null;
}

export interface ResourceSampleDisk {
  path: string;
  usedMb: number;
  totalMb: number;
  freeMb: number;
}

/**
 * Counter increases since the previous sample. The cumulative since-boot
 * counters answer "has this ever happened"; the deltas are what turn a stall
 * into a timeline — a burst of `reclaim.pgscanDirect` across a few samples *is*
 * the synchronous-reclaim stall, invisible in the cumulative totals.
 */
export interface ResourceSampleDeltas {
  events: ContainerMemoryEvents | null;
  reclaim: ContainerReclaimCounters | null;
  cpu: ContainerCpuStat | null;
}

export interface ResourceSample {
  ts: number;
  memory: ResourceSampleMemory | null;
  /**
   * memory.stat breakdown (anon / file / kernel / slab, plus the derived
   * unevictable vs reclaimable split). `memory.currentBytes` alone cannot say
   * whether the cgroup is filling with process heap or with droppable cache.
   */
  memoryStat: ContainerMemoryStat | null;
  /** Cumulative reclaim/thrash counters from memory.stat (since boot). */
  reclaim: ContainerReclaimCounters | null;
  /**
   * Cumulative cpu.stat counters (since boot). A rising `throttledUsec` delta
   * means the container hit its CPU quota and the kernel paused its threads —
   * indistinguishable from a busy event loop without this.
   */
  cpu: ContainerCpuStat | null;
  events: ContainerMemoryEvents | null;
  /** Since the previous sample; null on the monitor's first sample. */
  deltas: ResourceSampleDeltas | null;
  disk: ResourceSampleDisk | null;
  /**
   * Conversations mid-turn per the daemon's persisted
   * `conversations.processing_started_at` flag, so a spike in the timeline
   * names what was running. The live flag is nulled when a turn ends, so only
   * this sampling-time capture preserves the correlation for post-mortems.
   * Null when nothing is processing or the database is unavailable.
   */
  activeConversations: ActiveConversation[] | null;
}
