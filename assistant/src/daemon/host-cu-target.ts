/**
 * Choosing the client that answers a computer-use request, and saying why not
 * when none can.
 *
 * Shared because there are two doors into the same proxy: normal tool
 * resolution (`surfaceProxyResolver`) and the standalone `HostCuProxy.request`
 * that callers reach directly. They resolved the same thing twice, and the
 * copies had to be changed in lockstep every time the routing moved. One of
 * them drifting is not a visible failure: it is a request quietly sent to a
 * client that cannot serve it.
 *
 * **Pointing is not routed like an action.** It rides the `computer_use_` wire
 * so it arrives at this proxy, but only a client drawing the overlay can serve
 * it, and Windows and Linux forward what they get to a native helper with no
 * such action. So the capability is chosen from the tool rather than assumed
 * from the transport, and it governs execution here as well as exposure at
 * preactivation.
 */

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import { POINT_AT_PROXY_TOOL } from "../tools/computer-use/skill-proxy-bridge.js";

/**
 * The two capabilities this path can route on. Narrower than
 * `HostProxyCapability` on purpose: it is also a `SameActorOp`, so the audit
 * line names the capability that gated the request without a cast.
 */
export type HostCuRoutingCapability = "host_cu" | "host_cu_annotate";

/** What the caller should do next: dispatch to a client, or answer this. */
export type HostCuTargetResolution =
  | { kind: "resolved"; targetClientId: string | undefined }
  | { kind: "error"; result: { content: string; isError: true } };

/**
 * The capability that answers `toolName`.
 *
 * Exported so both doors name the same rule rather than each testing the tool
 * for themselves.
 */
export function hostCuCapabilityFor(toolName: string): HostCuRoutingCapability {
  return toolName === POINT_AT_PROXY_TOOL ? "host_cu_annotate" : "host_cu";
}

const unavailable = (capability: HostCuRoutingCapability) => ({
  kind: "error" as const,
  result: {
    content: `Computer use is not available for the current actor. Connect a ${capability}-capable client as the same user.`,
    isError: true as const,
  },
});

/**
 * Resolve and validate the client for one request.
 *
 * An explicit target is checked for existence, for the capability, and for
 * belonging to the same actor. An absent one is auto-resolved to the single
 * same-actor client that holds the capability.
 *
 * The zero-match case parts the two capabilities on purpose. An action falls
 * through with no target, which is the untargeted broadcast this path has
 * always allowed. Pointing refuses instead: there is nothing on the other end
 * that could draw, and broadcasting would hand it to whatever host_cu client
 * was listening, which is the mis-routing the separate capability exists to
 * prevent.
 */
export function resolveHostCuTarget(args: {
  toolName: string;
  targetClientId: string | undefined;
  sourceActorPrincipalId: string | undefined;
}): HostCuTargetResolution {
  const { toolName, sourceActorPrincipalId } = args;
  const capability = hostCuCapabilityFor(toolName);

  if (args.targetClientId != null) {
    const client = assistantEventHub.getClientById(args.targetClientId);
    if (!client) {
      return {
        kind: "error",
        result: {
          content: `No connected client with id '${args.targetClientId}'. Run \`assistant clients list --capability ${capability}\` to see available clients.`,
          isError: true,
        },
      };
    }
    if (!client.capabilities.includes(capability)) {
      return {
        kind: "error",
        result: {
          content: `Client '${args.targetClientId}' does not support ${capability}. Run \`assistant clients list --capability ${capability}\` to see available clients.`,
          isError: true,
        },
      };
    }
    const rejection = enforceSameActorOrErrorResult({
      hub: assistantEventHub,
      sourceActorPrincipalId,
      targetClientId: args.targetClientId,
      op: capability,
    });
    if (rejection) {
      return {
        kind: "error",
        result: rejection as { content: string; isError: true },
      };
    }
    return { kind: "resolved", targetClientId: args.targetClientId };
  }

  const resolved = pickSameUserAutoResolve({
    hub: assistantEventHub,
    capability,
    sourceActorPrincipalId,
  });
  if (resolved.kind === "ambiguous") {
    return {
      kind: "error",
      result: ambiguousSameUserError(capability) as {
        content: string;
        isError: true;
      },
    };
  }
  if (resolved.kind === "match") {
    return { kind: "resolved", targetClientId: resolved.clientId };
  }
  if (
    capability === "host_cu_annotate" ||
    assistantEventHub.listClientsByCapability(capability).length > 0
  ) {
    return unavailable(capability);
  }
  return { kind: "resolved", targetClientId: undefined };
}
