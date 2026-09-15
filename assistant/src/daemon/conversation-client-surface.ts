import { type ClientOs, parseClientOs } from "../channels/types.js";
import type { Conversation } from "./conversation.js";

/**
 * Host OS of the client driving this turn. The Electron renderer reports
 * `interface: "web"` and carries the real OS in `clientOs`, so this prefers
 * the frozen per-turn value and only falls back to a desktop transport.
 */
export function resolveTurnClientOs(ctx: Conversation): {
  clientOs: ClientOs | undefined;
  transportInterface: Conversation["transportInterface"];
} {
  const pin = ctx.toolContextPin;
  const transportInterface = pin
    ? pin.transportInterface
    : ctx.transportInterface;
  const clientOs = pin
    ? pin.clientOs
    : (parseClientOs(ctx.currentTurnClientOs ?? ctx.clientOs) ??
      (transportInterface === "macos" ||
      transportInterface === "windows" ||
      transportInterface === "linux"
        ? transportInterface
        : undefined));
  return { clientOs, transportInterface };
}
