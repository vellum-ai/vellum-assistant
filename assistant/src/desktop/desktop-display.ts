export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_WIDTH = 1440;
export const DESKTOP_HEIGHT = 900;
export const DESKTOP_INPUT_PARAMETERS = [
  "AcceptKeyEvents",
  "AcceptPointerEvents",
  "AcceptCutText",
  "AcceptSetDesktopSize",
] as const;

export const DESKTOP_OVERRIDABLE_PARAMETERS = [
  "desktop",
  "SendCutText",
  "SendPrimary",
  "SetPrimary",
  ...DESKTOP_INPUT_PARAMETERS,
] as const;
