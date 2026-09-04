/**
 * Pointing at something on the surface a call is being shown.
 *
 * A core tool rather than one of the computer-use skill's, because it is not
 * computer use: nothing is driven, nothing is clicked, and the user does the
 * thing themselves. It is how the assistant answers "where do I click?" in a
 * call, which has to be as available as talking is rather than waiting behind
 * a skill load.
 *
 * Named `computer_use_*` all the same, and that is load-bearing:
 * `surfaceProxyResolver` routes every tool with that prefix through
 * `HostCuProxy` to the connected desktop client, which is exactly the path
 * this needs. The macOS client answers this one itself instead of handing it
 * to the native helper, since the marks are drawn on a window the client owns
 * (`clients/macos/src/main/executors/host-cu-executor.ts`).
 */

import { RiskLevel } from "../../permissions/types.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

async function pointAt(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.proxyToolResolver) {
    return {
      content:
        'No proxy resolver configured for "computer_use_point_at". This tool requires a connected desktop client.',
      isError: true,
    };
  }
  return context.proxyToolResolver("computer_use_point_at", input);
}

export const computerUsePointAtTool = {
  name: "computer_use_point_at",
  description:
    'Point at something on the screen the user is sharing with the call: draws a ring around it, with a short caption beside it.\n\nUse this when the answer to the user\'s question is a place on their screen. It shows, it does not act: nothing is clicked, and the ring is drawn outside the bounds you give and never takes the mouse, so the user can go and use the thing you are pointing at.\n\nCoordinates are fractions of the shared surface, 0 to 1, measured against the picture of that surface you were last shown. `x` and `y` are the top-left corner, `width` and `height` the size. Give the bounds of the thing itself; the ring goes around them.\n\n`marks` is the whole set each time: sending it again replaces what is on screen, and sending an empty array clears it. Point at one thing at a time unless a step genuinely needs more. A caption is a short imperative like "Click Share", not an explanation; say the rest out loud.\n\nRequires the user to be sharing their screen with the call. If nothing is shared this fails, and the right move is to ask them to share before pointing again.',
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      marks: {
        type: "array",
        description:
          "What to point at now, replacing whatever is on screen. Empty clears.",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description:
                "Left edge, as a fraction of the shared surface's width (0 to 1).",
            },
            y: {
              type: "number",
              description:
                "Top edge, as a fraction of the shared surface's height (0 to 1).",
            },
            width: {
              type: "number",
              description: "Width, as a fraction of the surface's width.",
            },
            height: {
              type: "number",
              description: "Height, as a fraction of the surface's height.",
            },
            caption: {
              type: "string",
              maxLength: 80,
              description:
                'A short imperative for what to do with it, e.g. "Click Share".',
            },
          },
          required: ["x", "y", "width", "height"],
        },
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["marks"],
  },

  execute: pointAt,
} satisfies ToolDefinition;
