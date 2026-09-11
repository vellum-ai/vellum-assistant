import { randomBytes, timingSafeEqual } from "node:crypto";

type Envelope = Record<string, unknown>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class DesktopBrowserBridge {
  private token = "";
  private connection = "";
  private guardian = "";
  private queue: Envelope[] = [];
  private pending = new Map<string, Pending>();
  private wake?: () => void;
  private lastPoll = 0;
  generation = 0;

  start(): string {
    this.stop();
    this.token = randomBytes(32).toString("hex");
    return this.token;
  }

  stop(): void {
    this.token = "";
    this.invalidate();
  }

  disconnect(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.generation++;
    this.connection = "";
    this.guardian = "";
    this.lastPoll = 0;
    this.queue = [];
    for (const pending of this.pending.values()) {
      pending.reject(
        new Error(
          "Desktop browser disconnected. A dispatched action may have completed; observe before continuing.",
        ),
      );
    }
    this.pending.clear();
    this.wake?.();
  }

  async exchange(
    body: {
      token: string;
      connection: string;
      kind: "connect" | "poll" | "message";
      message?: Envelope;
    },
    guardian: string,
  ): Promise<unknown> {
    const actual = Buffer.from(body.token);
    const expected = Buffer.from(this.token);
    if (
      !expected.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Invalid desktop browser capability");
    }
    if (!guardian || guardian === "local") {
      throw new Error("Desktop browser requires a bound guardian");
    }
    if (body.kind === "connect") {
      this.invalidate();
      this.connection = body.connection;
      this.guardian = guardian;
      this.lastPoll = Date.now();
      return { connected: true };
    }
    if (body.connection !== this.connection || guardian !== this.guardian) {
      throw new Error("Desktop browser connection expired");
    }
    if (body.kind === "message") {
      const message = body.message ?? {};
      if (message.type === "host_browser_session_invalidated") {
        this.generation++;
      } else if (typeof message.requestId === "string") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          if (message.isError === true) {
            pending.reject(new Error(String(message.content).slice(0, 500)));
          } else {
            try {
              pending.resolve(JSON.parse(String(message.content)));
            } catch {
              pending.reject(new Error("Invalid desktop browser response"));
            }
          }
        }
      }
      return {};
    }
    if (this.wake) {
      throw new Error("Desktop browser already has a pending poll");
    }
    this.lastPoll = Date.now();
    if (!this.queue.length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    if (body.connection !== this.connection) {
      throw new Error("Desktop browser connection expired");
    }
    return { messages: this.queue.splice(0) };
  }

  async send<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    tab: string | undefined,
    actor: string,
    conversation: string,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (
      !this.connection ||
      this.guardian !== actor ||
      Date.now() - this.lastPoll > 15_000
    ) {
      throw new Error(
        "The managed desktop browser is not connected for this guardian. Observe again when it is ready.",
      );
    }
    if (this.pending.size >= 8 || this.queue.length >= 32) {
      throw new Error("Desktop browser is busy");
    }
    const requestId = crypto.randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    const abort = () => {
      this.queue = this.queue.filter(
        (message) => message.requestId !== requestId,
      );
      this.queue.push({ type: "host_browser_cancel", requestId });
      this.wake?.();
      this.pending
        .get(requestId)
        ?.reject(
          new Error(
            "Desktop browser action interrupted. It may have completed; observe before continuing. Do not retry it automatically.",
          ),
        );
      this.pending.delete(requestId);
      this.generation++;
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    this.queue.push({
      type: "host_browser_request",
      requestId,
      conversationId: conversation,
      cdpMethod: method,
      cdpParams: params,
      cdpSessionId: tab,
    });
    this.wake?.();
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.pending.delete(requestId);
    }
  }
}

export const desktopBrowserBridge = new DesktopBrowserBridge();
