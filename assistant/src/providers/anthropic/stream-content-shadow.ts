import {
  UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE,
  wrapUnparseableToolArgs,
} from "../unparseable-tool-args.js";

/**
 * The accumulator error embeds the exact buffer it choked on as a trailing
 * `. JSON: <buf>` suffix — including the final delta chunk, which the shadow
 * never observes (the SDK suppresses event emission the moment it errors).
 */
const ERROR_JSON_BUF_SUFFIX = /\. JSON: ([\s\S]+)$/;

/** Raw content block in the Anthropic wire shape. */
type ShadowBlock = Record<string, unknown>;

/** Structural subset of the SDK's stream events consumed by the shadow. */
export interface ShadowStreamEvent {
  type: string;
  index?: number;
  content_block?: unknown;
  delta?: unknown;
}

export interface SalvagedStream {
  /**
   * Response in the Anthropic `Message` shape, minus `model` (the caller
   * stamps the request model). Usage is zeroed: the SDK discards the
   * `message_delta` usage totals when it errors, so the salvaged turn
   * under-reports rather than guesses.
   */
  message: {
    content: ShadowBlock[];
    stop_reason: "tool_use";
    usage: { input_tokens: number; output_tokens: number };
  };
  toolName: string;
  rawArgsLength: number;
}

/**
 * Shadow accumulator for a streamed Anthropic message, maintained from raw
 * `streamEvent`s independently of the SDK's internal snapshot.
 *
 * The SDK's `MessageStream` re-parses a `tool_use` block's accumulated
 * argument JSON on every `input_json_delta` and fails the entire stream the
 * moment the buffer stops parsing: `finalMessage()` rejects with
 * `Unable to parse tool parameter JSON…` and every later event is suppressed
 * while the wire stream silently drains. That discards the whole response —
 * even though the protocol has a well-defined degrade for exactly this case:
 * return the malformed call with its raw argument text wrapped under the
 * `_raw` marker so the tool layer rejects it back to the model as an error
 * tool_result and the model self-corrects (see
 * `providers/unparseable-tool-args.ts`; the OpenAI-format providers apply the
 * same contract at parse time).
 *
 * `salvage()` rebuilds that degraded message from what streamed before the
 * poison delta: completed blocks verbatim, plus the in-flight tool call with
 * its arguments wrapped. Whatever the model emitted after the failure is
 * unobservable and is dropped — strictly better than dropping the turn.
 */
export class StreamContentShadow {
  private readonly blocks = new Map<number, ShadowBlock>();
  private readonly jsonBufs = new Map<number, string>();
  private readonly completed = new Set<number>();
  private inFlightIndex: number | undefined;

  handleEvent(event: ShadowStreamEvent): void {
    switch (event.type) {
      case "content_block_start": {
        if (typeof event.index !== "number") {
          return;
        }
        const block = structuredClone(event.content_block);
        if (block === null || typeof block !== "object") {
          return;
        }
        this.blocks.set(event.index, block as ShadowBlock);
        this.inFlightIndex = event.index;
        if (this.tracksToolInput(block as ShadowBlock)) {
          this.jsonBufs.set(event.index, "");
        }
        return;
      }
      case "content_block_delta": {
        if (typeof event.index !== "number") {
          return;
        }
        const block = this.blocks.get(event.index);
        const delta = event.delta as Record<string, unknown> | undefined;
        if (block === undefined || delta === undefined) {
          return;
        }
        switch (delta.type) {
          case "text_delta":
            block.text = `${typeof block.text === "string" ? block.text : ""}${String(delta.text ?? "")}`;
            return;
          case "thinking_delta":
            block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${String(delta.thinking ?? "")}`;
            return;
          case "signature_delta":
            block.signature = delta.signature;
            return;
          case "input_json_delta": {
            const buf = this.jsonBufs.get(event.index);
            if (buf !== undefined) {
              this.jsonBufs.set(
                event.index,
                buf + String(delta.partial_json ?? ""),
              );
            }
            return;
          }
          case "citations_delta": {
            const citations = Array.isArray(block.citations)
              ? block.citations
              : [];
            citations.push(delta.citation);
            block.citations = citations;
            return;
          }
          default:
            return;
        }
      }
      case "content_block_stop": {
        if (typeof event.index !== "number") {
          return;
        }
        const block = this.blocks.get(event.index);
        if (block !== undefined) {
          const buf = this.jsonBufs.get(event.index);
          if (buf !== undefined && buf.length > 0) {
            block.input = this.parseFinalToolInput(buf);
          }
          this.completed.add(event.index);
        }
        if (this.inFlightIndex === event.index) {
          this.inFlightIndex = undefined;
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Rebuild the response for an `Unable to parse tool parameter JSON`
   * rejection. Returns `undefined` — caller rethrows — when the error is a
   * different failure or the shadow lacks an in-flight `tool_use` block to
   * pin the failure on (without it the salvaged message would carry no trace
   * of what went wrong).
   */
  salvage(error: unknown): SalvagedStream | undefined {
    const messageText =
      error instanceof Error ? error.message : String(error ?? "");
    if (!messageText.includes(UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE)) {
      return undefined;
    }
    if (this.inFlightIndex === undefined) {
      return undefined;
    }
    const inFlight = this.blocks.get(this.inFlightIndex);
    if (
      inFlight === undefined ||
      inFlight.type !== "tool_use" ||
      typeof inFlight.name !== "string"
    ) {
      return undefined;
    }

    const raw =
      ERROR_JSON_BUF_SUFFIX.exec(messageText)?.[1] ??
      this.jsonBufs.get(this.inFlightIndex) ??
      "";

    const content: ShadowBlock[] = [];
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      if (index === this.inFlightIndex) {
        break;
      }
      if (this.completed.has(index)) {
        content.push(this.blocks.get(index)!);
      }
    }
    content.push({ ...inFlight, input: wrapUnparseableToolArgs(raw) });

    return {
      message: {
        content,
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      toolName: inFlight.name,
      rawArgsLength: raw.length,
    };
  }

  private tracksToolInput(block: ShadowBlock): boolean {
    return block.type === "tool_use" || block.type === "server_tool_use";
  }

  /**
   * Strict-parse a completed block's accumulated argument JSON. Tool inputs
   * must be plain objects; anything else (including JSON that only satisfied
   * the SDK's lenient partial parser mid-stream) is wrapped under `_raw` so
   * the tool layer rejects it instead of executing with garbage.
   */
  private parseFinalToolInput(buf: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(buf);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to wrap
    }
    return wrapUnparseableToolArgs(buf);
  }
}
