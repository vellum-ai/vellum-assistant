/**
 * A conversation double for races between two senders reaching the same idle
 * conversation.
 *
 * It models the three pieces of state such a race can corrupt: the processing
 * claim (taken, fenced, released by owner, as the real one is), the trust slot,
 * and the resident history, which a reload replaces wholesale with the rows
 * the slot's actor may see. A test can hold the next reload open, which is the
 * await a second sender lands in.
 *
 * The persist and the agent loop record what they ran under, so a test can
 * ask which sender's turn ran, under whose trust, on whose history, and
 * whether two turns ever overlapped.
 *
 * It carries the fields an abort reads as plain stubs, so a test can run the
 * real abort against it. `busyMessage` is the error text the persist throws
 * for a conversation it cannot have, which callers match on; the claim a
 * sender takes before scoping is left to the test to wire, so this helper
 * imports nothing at runtime.
 */

import type { TrustContext } from "../../daemon/trust-context-types.js";

export interface HeldReload {
  /** Resolves once a reload is waiting on this hold. */
  entered: Promise<void>;
  release(): void;
}

export interface RecordedTurn {
  trust: TrustContext | undefined;
  historyAtStart: string[];
  historyAtEnd?: string[];
}

/**
 * A point a test can hold some awaited work at: `wait()` is what the held
 * work awaits, `entered` resolves once it is waiting, and `release()` lets it
 * go on.
 */
export function createHold(): HeldReload & { wait(): Promise<void> } {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      enter();
      return gate;
    },
  };
}

/** The history a reload scoped for `trust` leaves resident. */
export function historyScopedFor(trust: TrustContext | undefined): string[] {
  return [`history visible to ${trust?.trustClass ?? "nobody"}`];
}

export function createScopeRaceConversation(
  conversationId: string,
  busyMessage: string,
) {
  let processing = false;
  let owner = 0;
  let nextOwner = 0;
  let loadedFor: string | null = null;
  const holds: Array<{ gate: Promise<void>; enter: () => void }> = [];
  let running = 0;
  // A claim's preparing window ends when its turn becomes abortable or the
  // claim is released, as the real conversation's does.
  const endPreparing = (claim: number) => {
    if (conversation.preparingClaim?.owner === claim) {
      conversation.preparingClaim = null;
    }
  };
  const queued: unknown[] = [];
  const queue = {
    get length() {
      return queued.length;
    },
    get isEmpty() {
      return queued.length === 0;
    },
    [Symbol.iterator]: () => queued[Symbol.iterator](),
    clear: () => {
      queued.length = 0;
    },
    removeByRequestId: () => undefined,
  };

  const conversation = {
    conversationId,
    trustContext: undefined as TrustContext | undefined,
    messages: [] as string[],
    abortController: null as AbortController | null,
    preparingClaim: null as {
      readonly owner: number;
      cancelled: boolean;
    } | null,
    drainKicks: [] as Array<string | undefined>,
    /** Messages a drain picked up, in the order it ran them. */
    drained: [] as unknown[],
    queue,
    pendingInterruptRepair: false,
    prompter: { dispose: () => {} },
    secretPrompter: { dispose: () => {} },
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    surfaceState: new Map(),
    accumulatedSurfaceState: new Map(),
    trustWrites: [] as Array<TrustContext | undefined>,
    persistedTrust: [] as Array<TrustContext | undefined>,
    turns: [] as RecordedTurn[],
    maxConcurrentTurns: 0,

    /** Hold the next reload open until the returned hold is released. */
    holdNextReload(): HeldReload {
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ gate, enter });
      return { entered, release };
    },

    isProcessing: () => processing,
    setProcessing(value: boolean) {
      processing = value;
      owner = value ? ++nextOwner : 0;
    },
    async acquireProcessingFenced(): Promise<number | null> {
      if (processing) {
        return null;
      }
      processing = true;
      const claim = ++nextOwner;
      owner = claim;
      // The real fence awaits the marker write before answering.
      await Promise.resolve();
      return owner === claim ? claim : null;
    },
    holdsProcessingClaim: (claim: number) => owner === claim,
    releaseProcessing(claim: number): boolean {
      if (owner !== claim) {
        return false;
      }
      endPreparing(claim);
      processing = false;
      owner = 0;
      return true;
    },
    /** Queue a message the way a send to a busy conversation does. */
    enqueue(message: unknown) {
      queued.push(message);
    },
    kickDrainQueue: async (_reason?: string, origin?: string) => {
      conversation.drainKicks.push(origin);
      // A drain is a no-op on a busy conversation, as the real one is.
      if (!processing) {
        conversation.drained.push(...queued.splice(0));
      }
    },

    setTrustContext(ctx: TrustContext | null) {
      conversation.trustContext = ctx ?? undefined;
      conversation.trustWrites.push(ctx ?? undefined);
    },
    getTrustContext: () => conversation.trustContext,
    async ensureActorScopedHistory(): Promise<void> {
      const scope = conversation.trustContext;
      const key = scope?.trustClass ?? "nobody";
      if (loadedFor === key) {
        return;
      }
      const hold = holds.shift();
      if (hold) {
        hold.enter();
        await hold.gate;
      }
      conversation.messages = historyScopedFor(scope);
      loadedFor = key;
    },
    getMessages: () => conversation.messages,

    async persistUserMessage(options: {
      trustContext?: TrustContext;
      processingClaim?: number;
      requestId?: string;
    }): Promise<{ id: string; deduplicated: boolean }> {
      if (options.processingClaim === undefined) {
        if (!processing) {
          await conversation.ensureActorScopedHistory();
        }
        const claim = await conversation.acquireProcessingFenced();
        if (claim === null) {
          throw new Error(busyMessage);
        }
      } else if (
        owner !== options.processingClaim ||
        (conversation.preparingClaim?.owner === options.processingClaim &&
          conversation.preparingClaim.cancelled)
      ) {
        throw new Error(busyMessage);
      }
      conversation.persistedTrust.push(
        options.trustContext ?? conversation.trustContext,
      );
      conversation.abortController = new AbortController();
      if (options.processingClaim !== undefined) {
        endPreparing(options.processingClaim);
      }
      return {
        id: options.requestId ?? `row-${conversation.persistedTrust.length}`,
        deduplicated: false,
      };
    },

    async runAgentLoop(
      _content: string,
      _messageId: string,
      options?: { turnTrustContext?: TrustContext },
    ): Promise<void> {
      running += 1;
      conversation.maxConcurrentTurns = Math.max(
        conversation.maxConcurrentTurns,
        running,
      );
      const turn: RecordedTurn = {
        trust: options?.turnTrustContext ?? conversation.trustContext,
        historyAtStart: [...conversation.messages],
      };
      conversation.turns.push(turn);
      await new Promise((resolve) => setTimeout(resolve, 5));
      turn.historyAtEnd = [...conversation.messages];
      running -= 1;
      conversation.abortController = null;
      processing = false;
      owner = 0;
    },
  };
  return conversation;
}
