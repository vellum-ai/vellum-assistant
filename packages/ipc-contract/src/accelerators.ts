import type { VellumCommand } from "./types";

/**
 * Default accelerator per command, as the desktop shell registers them.
 *
 * Lives beside the command type rather than in the shell because the
 * renderer needs the same answer: a shortcut hint has to name the binding
 * the shell actually installed, and a renderer running against a shell too
 * old to report its catalog over IPC still has to show something truthful.
 * An empty string is a command that ships unbound.
 *
 * The shell merges user overrides over this at menu-build time, so this is
 * the default rather than the effective binding.
 */
export const DEFAULT_ACCELERATORS: Record<VellumCommand["kind"], string> = {
  newConversation: "CmdOrCtrl+N",
  currentConversation: "CmdOrCtrl+Shift+N",
  markCurrentUnread: "CmdOrCtrl+Shift+U",
  togglePinConversation: "CmdOrCtrl+Shift+P",
  openSettings: "CmdOrCtrl+,",
  shareFeedback: "",
  find: "CmdOrCtrl+F",
  markAllRead: "",
  login: "",
  logout: "",
  rePair: "",
  sidebarToggle: "CmdOrCtrl+\\",
  home: "CmdOrCtrl+Shift+H",
  popOut: "CmdOrCtrl+P",
  previousConversation: "CmdOrCtrl+Up",
  nextConversation: "CmdOrCtrl+Down",
  commandPalette: "CmdOrCtrl+K",
  openConversation: "",
  openLibrary: "",
  openIdentity: "",
  navigateBack: "",
  navigateForward: "",
  zoomIn: "",
  zoomOut: "",
  actualSize: "",
  selectAssistant: "",
  chooseAssistant: "",
  createAssistant: "",
  retireAssistant: "",
  removePairedAssistant: "",
  quickInputSubmit: "",
  startVoice: "",
  toggleVoice: "",
  companionSubmit: "",
  toggleWatch: "",
  answerWatchRetro: "",
  cancelDictation: "",
  replayOnboarding: "",
  replayHatchFailure: "",
  openComponentGallery: "",
};
