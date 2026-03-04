/**
 * Lightweight event emitter for contact mutations.
 * The daemon server subscribes to this to broadcast `contacts_changed`
 * to all connected clients.
 */
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();

/** Register a listener for contact change events. Returns an unsubscribe function. */
export function onContactChange(listener: () => void): () => void {
  emitter.on("changed", listener);
  return () => {
    emitter.off("changed", listener);
  };
}

/** Emit a contact change event. Called after successful contact writes. */
export function emitContactChange(): void {
  emitter.emit("changed");
}
