import { desktopControl } from "../../desktop/desktop-control.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { ASSISTANT_DESKTOP_TOOLS } from "./target.js";

const X11_KEYS: Readonly<Record<string, string>> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  space: "space",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
};

export async function executeAssistantDesktopTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  let unsupported: string | undefined;
  if (!ASSISTANT_DESKTOP_TOOLS.has(toolName)) {
    unsupported = `${toolName} is not supported on the assistant desktop`;
  } else if (
    input.element_id !== undefined ||
    input.to_element_id !== undefined ||
    input.capture_window_id !== undefined ||
    input.full_tree === true
  ) {
    unsupported =
      "The assistant desktop supports full-screen screenshots and pixel coordinates, not accessibility elements or window capture";
  }
  if (unsupported) {
    return rejectAssistantDesktopInput(unsupported, context);
  }
  const observed = { observation_id: input.observation_id };
  const point = { x: input.x, y: input.y };
  let action: Record<string, unknown>;
  switch (toolName) {
    case "computer_use_observe":
      action = { action: "observe" };
      break;
    case "computer_use_done":
    case "computer_use_respond":
      action = { action: "done" };
      break;
    case "computer_use_click":
    case "computer_use_double_click":
    case "computer_use_right_click":
      action = {
        action: "click",
        ...observed,
        ...point,
        button:
          toolName === "computer_use_double_click"
            ? "double"
            : toolName === "computer_use_right_click"
              ? "right"
              : "left",
      };
      break;
    case "computer_use_type_text":
      action = { action: "type", ...observed, text: input.text };
      break;
    case "computer_use_key":
      action = {
        action: "key",
        ...observed,
        key:
          typeof input.key === "string"
            ? input.key
                .split("+")
                .map((key) => X11_KEYS[key.toLowerCase()] ?? key)
                .join("+")
            : input.key,
      };
      break;
    case "computer_use_scroll":
      action = {
        action: "scroll",
        ...observed,
        ...point,
        direction: input.direction,
        amount: input.amount,
      };
      break;
    case "computer_use_drag":
      action = {
        action: "drag",
        ...observed,
        ...point,
        to_x: input.to_x,
        to_y: input.to_y,
      };
      break;
    case "computer_use_wait":
      action = { action: "wait", ...observed, duration_ms: input.duration_ms };
      break;
    default:
      throw new Error(`Unsupported computer-use action: ${toolName}`);
  }
  return desktopControl.execute(action, context).then((result) => {
    if (action.action === "done" && !result.isError && !result.yieldToUser) {
      return {
        ...result,
        content: String(input.summary ?? input.answer ?? result.content),
      };
    }
    return result;
  });
}

export async function rejectAssistantDesktopInput(
  content: string,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    await desktopControl.execute({ action: "done" }, context);
  } catch (error) {
    content += ` Desktop control release failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { content, isError: true };
}
