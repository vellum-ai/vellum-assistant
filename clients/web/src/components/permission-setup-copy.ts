import {
  Accessibility,
  AppWindow,
  AudioLines,
  Bell,
  Keyboard,
  Mic,
  ScanLine,
} from "lucide-react";
import type {
  SystemPermissionKind,
} from "@vellumai/ipc-contract";
import type { TFunction } from "@/i18n";

export const PERMISSION_ORDER: SystemPermissionKind[] = [
  "accessibility",
  "screen",
  "microphone",
  "inputMonitoring",
  "speechRecognition",
  "automation",
  "notifications",
];

export function permissionSetupCopy(kind: SystemPermissionKind, t: TFunction) {
  switch (kind) {
    case "accessibility":
      return {
        icon: Accessibility,
        label: t("systemPermissionsCard.accessibilityLabel"),
        description: t("permissionSetup.accessibilityDescription"),
      };
    case "screen":
      return {
        icon: ScanLine,
        label: t("systemPermissionsCard.screenLabel"),
        description: t("permissionSetup.screenDescription"),
      };
    case "microphone":
      return {
        icon: Mic,
        label: t("systemPermissionsCard.microphoneLabel"),
        description: t("permissionSetup.microphoneDescription"),
      };
    case "speechRecognition":
      return {
        icon: AudioLines,
        label: t("systemPermissionsCard.speechRecognitionLabel"),
        description: t("permissionSetup.speechDescription"),
      };
    case "inputMonitoring":
      return {
        icon: Keyboard,
        label: t("permissionSetup.inputLabel"),
        description: t("permissionSetup.inputDescription"),
      };
    case "automation":
      return {
        icon: AppWindow,
        label: t("permissionSetup.automationLabel"),
        description: t("permissionSetup.automationDescription"),
      };
    case "notifications":
      return {
        icon: Bell,
        label: t("systemPermissionsCard.notificationsLabel"),
        description: t("permissionSetup.notificationsDescription"),
      };
  }
}
