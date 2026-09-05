/**
 * The `interrupt-on-send` flag key, alone in a module with no imports.
 *
 * Daemon code that only needs to name the flag (route wiring, the interrupt
 * helper) reads it from here. The predicate that resolves the flag's value
 * lives in `interrupt-on-send-gate.ts` and pulls the flag resolver, which
 * reaches the gateway IPC client: keeping the two apart lets a module import
 * the key without dragging that graph in behind it.
 */
export const INTERRUPT_ON_SEND_FLAG_KEY = "interrupt-on-send" as const;
