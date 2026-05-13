import type { Response } from 'express';

/**
 * SSE event bus for the demo UI.
 * Maintains a set of connected SSE clients and broadcasts events to all of them.
 */
export class EventBus {
  private readonly clients = new Set<Response>();

  /**
   * Register an SSE client. Sets required headers, flushes an initial `:ok` comment,
   * and removes the client on disconnect.
   */
  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial comment to flush the connection
    res.write(':ok\n\n');

    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  /**
   * Broadcast an SSE event to all connected clients.
   * Silently drops disconnected clients.
   */
  broadcast(eventType: string, data: object): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        // Client disconnected — remove silently
        this.clients.delete(client);
      }
    }
  }

  /** Number of currently connected clients (useful for testing). */
  get size(): number {
    return this.clients.size;
  }
}
