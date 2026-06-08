import { useEffect, useLayoutEffect, useRef } from "react";

import { isElectron, type VellumCommand } from "@/runtime/is-electron";

/**
 * Renderer-side dispatcher for commands sent by the Electron host's
 * application menu (and, eventually, global hotkeys). The contract is
 * defined in `apps/macos/src/main/commands.ts`; this file mirrors the
 * union type via the ambient declaration in `is-electron.ts`.
 *
 * Consumers register a partial map of handlers. Missing entries no-op,
 * which is intentional: the same command stream is consumed at multiple
 * mount points (chat layout, settings, future thread pop-outs) and not
 * every consumer cares about every command.
 *
 * Handlers are held in a ref so re-renders don't re-subscribe to the IPC
 * channel, and the latest handler closure is always invoked when a
 * command arrives (avoids stale-closure bugs without forcing callers to
 * memoize).
 *
 * Handlers receive the full command object. Payload-free commands can
 * still use `() => void` — TypeScript's function compatibility rules
 * allow functions with fewer parameters to satisfy a wider signature.
 */
export type CommandHandlers = Partial<
  Record<VellumCommand["kind"], (command: VellumCommand) => void>
>;

export function useVellumCommands(handlers: CommandHandlers): void {
  const handlersRef = useRef<CommandHandlers>(handlers);
  useLayoutEffect(() => { handlersRef.current = handlers; });

  useEffect(() => {
    if (!isElectron()) return;
    const bridge = window.vellum;
    if (!bridge) return;
    return bridge.commands.on((command) => {
      handlersRef.current[command.kind]?.(command);
    });
  }, []);
}
