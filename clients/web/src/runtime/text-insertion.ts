import {
  isElectron,
  type ElectronTextInsertionResult,
} from "@/runtime/is-electron";
import { openSystemPermissionSettings } from "@/runtime/system-permissions";

export type TextInsertionResult =
  | ElectronTextInsertionResult
  | { status: "unavailable" };

export async function insertTextIntoFrontApp(
  text: string,
): Promise<TextInsertionResult> {
  if (!isElectron() || !window.vellum?.text?.insertIntoFrontApp) {
    return { status: "unavailable" };
  }

  try {
    return await window.vellum.text.insertIntoFrontApp(text);
  } catch (err) {
    console.warn("insertTextIntoFrontApp failed", err);
    return { status: "blocked" };
  }
}

export async function openTextInsertionSettings(): Promise<void> {
  try {
    if (await openSystemPermissionSettings("automation")) return;
  } catch {
    // Fall through to the legacy bridge below.
  }
  if (!isElectron() || !window.vellum?.text?.openAutomationSettings) return;
  try {
    await window.vellum.text.openAutomationSettings();
  } catch (err) {
    console.warn("openTextInsertionSettings failed", err);
  }
}
