import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

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

const MACOS_SETTINGS_URLS: Record<PermissionType, string> = {
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

// Only the pages the Windows desktop client can route through its
// permissions bridge; other kinds have no in-app remediation there yet.
const WINDOWS_SETTINGS_URLS: Partial<Record<PermissionType, string>> = {
  screen_recording: "ms-settings:privacy-graphicscaptureprogrammatic",
  microphone: "ms-settings:privacy-microphone",
};

export const resolveSystemPermissionSettingsUrl = (
  permType: PermissionType,
  clientOs: string | undefined,
): string | undefined =>
  clientOs === "windows"
    ? WINDOWS_SETTINGS_URLS[permType]
    : MACOS_SETTINGS_URLS[permType];

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

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `activity`
 * is advertised-required purely to guide the model (it is shown in the
 * prompt UI, never read here), so it stays runtime-optional via
 * `advertiseRequired`.
 */
export const requestSystemPermissionInputSchema = z.looseObject({
  permission_type: z
    .enum(PERMISSION_TYPES)
    .describe("The system permission (macOS or Windows) to request"),
  activity: z
    .string()
    .describe(
      "Short explanation of why this permission is needed (shown in the prompt)",
    )
    .optional()
    .catch(undefined),
});

export const requestSystemPermissionTool = {
  name: "request_system_permission",
  description:
    "Request a system permission via macOS System Settings or Windows Settings. " +
    "Use when a tool fails with a permission/access error (e.g. 'Operation not permitted', 'EACCES', sandbox denial). " +
    "Do not explain how to open System Settings manually - this tool handles it with a clickable button.",
  category: "system",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.High,

  input_schema: toToolInputSchema(requestSystemPermissionInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = requestSystemPermissionInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("request_system_permission", parsed.error);
    }
    const permType = parsed.data.permission_type;

    const friendly = FRIENDLY_NAMES[permType];
    const settingsUrl = resolveSystemPermissionSettingsUrl(
      permType,
      context.clientOs,
    );
    if (!settingsUrl) {
      return {
        content: `${friendly} cannot be requested in-app on ${context.clientOs}. Ask the user to check the matching Privacy page in Windows Settings.`,
        isError: true,
      };
    }

    return {
      content: [
        `The user has been asked to grant ${friendly}.`,
        `Settings URL: ${settingsUrl}`,
        `If they approved, retry the original operation.`,
        `If they denied, acknowledge and suggest alternatives.`,
      ].join("\n"),
      isError: false,
    };
  },
} satisfies ToolDefinition;
