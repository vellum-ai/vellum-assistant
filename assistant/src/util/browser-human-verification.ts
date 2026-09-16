export const HUMAN_VERIFICATION_GUIDANCE =
  "CAPTCHAs and bot-detection challenges must be completed by the user. " +
  "This includes drag-to-verify sliders, press-and-hold checks, verification checkboxes and image puzzles. " +
  "Stop before attempting the challenge, even when its controls look easy to automate. " +
  "Do not click, drag, hold, script or retry the verification yourself.";

export const DESKTOP_HELP_GUIDANCE =
  HUMAN_VERIFICATION_GUIDANCE +
  " In the virtual desktop, immediately call ask_question with " +
  "desktopHelp: { message, doneLabel, skipLabel } in the user's language. " +
  "Keep message to one short sentence explaining the needed human action. " +
  "This shows an inline preview with Step In, Done and Skip. Wait for the response. " +
  "After Done, inspect a fresh snapshot. If verification remains, request help again. " +
  "Skip leaves the challenge unresolved. Use the same desktopHelp request for other steps that require direct user interaction.";
