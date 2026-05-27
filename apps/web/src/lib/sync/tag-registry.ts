import type {
  SyncChangedEvent,
  SyncInvalidationTag,
} from "@/lib/sync/types";

export type SyncInvalidationReason = "live" | "reconnect";

export interface SyncHandlerContext {
  tag: SyncInvalidationTag;
  reason: SyncInvalidationReason;
  event?: SyncChangedEvent;
}

export type SyncTagHandler = (
  context: SyncHandlerContext,
) => void | Promise<void>;

export type SyncTagMatcher =
  | RegExp
  | ((tag: SyncInvalidationTag) => boolean);

export interface SyncHandlerRegistration {
  dispose(): void;
}

export interface RegisterSyncHandlerOptions {
  runOnReconnect?: boolean;
}

export interface RegisterSyncPatternHandlerOptions {
  reconnectTags?: () => Iterable<SyncInvalidationTag>;
}

export interface SyncDispatchError {
  tag: SyncInvalidationTag;
  error: unknown;
}

export interface SyncDispatchResult {
  handledTags: SyncInvalidationTag[];
  unknownTags: SyncInvalidationTag[];
  invokedHandlers: number;
  errors: SyncDispatchError[];
}

interface HandlerInvocation {
  tag: SyncInvalidationTag;
  handler: SyncTagHandler;
}

interface ExactEntry {
  tag: SyncInvalidationTag;
  handler: SyncTagHandler;
  runOnReconnect: boolean;
}

interface PatternEntry {
  matcher: SyncTagMatcher;
  handler: SyncTagHandler;
  reconnectTags?: () => Iterable<SyncInvalidationTag>;
}

export class SyncTagRegistry {
  private readonly exactEntries = new Set<ExactEntry>();
  private readonly patternEntries = new Set<PatternEntry>();

  register(
    tag: SyncInvalidationTag,
    handler: SyncTagHandler,
    options: RegisterSyncHandlerOptions = {},
  ): SyncHandlerRegistration {
    const entry: ExactEntry = {
      tag,
      handler,
      runOnReconnect: options.runOnReconnect ?? true,
    };
    this.exactEntries.add(entry);
    return {
      dispose: () => {
        this.exactEntries.delete(entry);
      },
    };
  }

  registerPattern(
    matcher: SyncTagMatcher,
    handler: SyncTagHandler,
    options: RegisterSyncPatternHandlerOptions = {},
  ): SyncHandlerRegistration {
    const entry: PatternEntry = {
      matcher,
      handler,
      reconnectTags: options.reconnectTags,
    };
    this.patternEntries.add(entry);
    return {
      dispose: () => {
        this.patternEntries.delete(entry);
      },
    };
  }

  clear(): void {
    this.exactEntries.clear();
    this.patternEntries.clear();
  }

  async dispatch(event: SyncChangedEvent): Promise<SyncDispatchResult> {
    const invocations = uniqueTags(event.tags).map((tag) => ({
      tag,
      handlers: this.handlersForTag(tag),
    }));
    return this.dispatchInvocations(invocations, "live", event);
  }

  async dispatchReconnect(): Promise<SyncDispatchResult> {
    const invocations: HandlerInvocation[] = [];
    for (const entry of this.exactEntries) {
      if (entry.runOnReconnect) {
        invocations.push({ tag: entry.tag, handler: entry.handler });
      }
    }
    for (const entry of this.patternEntries) {
      if (!entry.reconnectTags) {
        continue;
      }
      for (const tag of uniqueTags(entry.reconnectTags())) {
        if (matchesTag(entry.matcher, tag)) {
          invocations.push({ tag, handler: entry.handler });
        }
      }
    }
    return this.dispatchInvocations(
      groupInvocationsByTag(invocations),
      "reconnect",
    );
  }

  private async dispatchInvocations(
    invocations: Array<{
      tag: SyncInvalidationTag;
      handlers: SyncTagHandler[];
    }>,
    reason: SyncInvalidationReason,
    event?: SyncChangedEvent,
  ): Promise<SyncDispatchResult> {
    const handledTags: SyncInvalidationTag[] = [];
    const unknownTags: SyncInvalidationTag[] = [];
    const errors: SyncDispatchError[] = [];
    let invokedHandlers = 0;

    for (const { tag, handlers } of invocations) {
      if (handlers.length === 0) {
        unknownTags.push(tag);
        continue;
      }

      handledTags.push(tag);
      for (const handler of handlers) {
        invokedHandlers += 1;
        try {
          await handler({ tag, reason, event });
        } catch (error) {
          errors.push({ tag, error });
        }
      }
    }

    return {
      handledTags,
      unknownTags,
      invokedHandlers,
      errors,
    };
  }

  private handlersForTag(tag: SyncInvalidationTag): SyncTagHandler[] {
    const handlers: SyncTagHandler[] = [];

    for (const entry of this.exactEntries) {
      if (entry.tag === tag) {
        handlers.push(entry.handler);
      }
    }

    for (const entry of this.patternEntries) {
      if (matchesTag(entry.matcher, tag)) {
        handlers.push(entry.handler);
      }
    }

    return handlers;
  }
}

export function createSyncTagRegistry(): SyncTagRegistry {
  return new SyncTagRegistry();
}

function uniqueTags(tags: Iterable<SyncInvalidationTag>): SyncInvalidationTag[] {
  return Array.from(new Set(tags));
}

function matchesTag(
  matcher: SyncTagMatcher,
  tag: SyncInvalidationTag,
): boolean {
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(tag);
  }
  return matcher(tag);
}

function groupInvocationsByTag(
  invocations: HandlerInvocation[],
): Array<{ tag: SyncInvalidationTag; handlers: SyncTagHandler[] }> {
  const grouped = new Map<SyncInvalidationTag, SyncTagHandler[]>();
  for (const { tag, handler } of invocations) {
    const handlers = grouped.get(tag);
    if (handlers) {
      handlers.push(handler);
    } else {
      grouped.set(tag, [handler]);
    }
  }
  return Array.from(grouped, ([tag, handlers]) => ({ tag, handlers }));
}
