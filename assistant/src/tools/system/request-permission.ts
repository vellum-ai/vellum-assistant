import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const PERMISSION_TYPES = [
  "full_disk_access",
  "accessibility",
  "screen_recording",
  "calendar",
  "contacts",
  "photos",
  "location",
  "microphone",
  "camera",
] as const;

type PermissionType = (typeof PERMISSION_TYPES)[number];

const SETTINGS_URLS: Record<PermissionType, string> = {
  full_disk_access:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen_recording:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendar:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  contacts:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  photos:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
  location:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  camera:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
};

const FRIENDLY_NAMES: Record<PermissionType, string> = {
  full_disk_access: "Full Disk Access",
  accessibility: "Accessibility",
  screen_recording: "Screen Recording",
  calendar: "Calendar",
  contacts: "Contacts",
  photos: "Photos",
  location: "Location Services",
  microphone: "Microphone",
  camera: "Camera",
};

class RequestSystemPermissionTool implements Tool {
  name = "request_system_permission";
  description =
    "Ask the user to grant a macOS system permission via System Settings. " +
    "Use when a tool fails with a permission/access error (e.g. 'Operation not permitted', 'EACCES', sandbox denial). " +
    "Do not explain how to open System Settings manually — this tool handles it with a clickable button.";
  category = "system";
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          permission_type: {
            type: "string",
            enum: [...PERMISSION_TYPES],
            description: "The macOS system permission to request",
          },
          reason: {
            type: "string",
            description:
              "Short explanation of why this permission is needed (shown to the user)",
          },
        },
        required: ["permission_type", "reason"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const permType = input.permission_type as string;
    if (!PERMISSION_TYPES.includes(permType as PermissionType)) {
      return {
        content: `Error: unknown permission type "${permType}". Valid types: ${PERMISSION_TYPES.join(
          ", ",
        )}`,
        isError: true,
      };
    }

    const friendly = FRIENDLY_NAMES[permType as PermissionType];
    const settingsUrl = SETTINGS_URLS[permType as PermissionType];

    return {
      content: [
        `The user has been asked to grant ${friendly}.`,
        `Settings URL: ${settingsUrl}`,
        `If they approved, retry the original operation.`,
        `If they denied, acknowledge and suggest alternatives.`,
      ].join("\n"),
      isError: false,
    };
  }
}

export const requestSystemPermissionTool = new RequestSystemPermissionTool();
registerTool(requestSystemPermissionTool);
