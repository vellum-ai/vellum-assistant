type Listener = (event?: unknown) => void;

export class FakeWebSocket {
  static CONNECTING = WebSocket.CONNECTING;
  static OPEN = WebSocket.OPEN;
  static CLOSING = WebSocket.CLOSING;
  static CLOSED = WebSocket.CLOSED;

  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  sent: (string | Uint8Array)[] = [];
  closes: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url = "",
    readonly options: unknown = undefined,
    private readonly closeOptions: { validateReason?: boolean } = {},
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string | Uint8Array): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    if (
      code !== undefined &&
      code !== 1000 &&
      (!Number.isInteger(code) || code < 3000 || code > 4999)
    ) {
      throw new Error("invalid close code");
    }
    if (
      this.closeOptions.validateReason &&
      reason !== undefined &&
      new TextEncoder().encode(reason).byteLength > 123
    ) {
      throw new Error("invalid close reason");
    }
    this.readyState = WebSocket.CLOSED;
    this.closes.push({ code, reason });
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function makeFakeWebSocketConstructor(created: FakeWebSocket[]) {
  return function FakeWebSocketConstructor(
    this: unknown,
    url: string,
    options: unknown,
  ) {
    const ws = new FakeWebSocket(url, options);
    created.push(ws);
    return ws;
  } as unknown as {
    new (url: string | URL, options?: unknown): WebSocket;
  };
}
