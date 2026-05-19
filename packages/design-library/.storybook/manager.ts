import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const theme = create({
  base: "dark",
  brandTitle: "Vellum Design Library",
  brandUrl: "https://github.com/vellum-ai/vellum-assistant",

  appBg: "#17191C",
  appContentBg: "#1C1E22",
  appBorderColor: "#2D3038",
  appBorderRadius: 8,

  textColor: "#F6F5F4",
  textMutedColor: "#9CA3AF",

  colorPrimary: "#E83F5B",
  colorSecondary: "#E83F5B",

  barBg: "#17191C",
  barTextColor: "#9CA3AF",
  barSelectedColor: "#F6F5F4",

  inputBg: "#24292E",
  inputBorder: "#2D3038",
  inputTextColor: "#F6F5F4",
});

addons.setConfig({
  theme,
  sidebar: {
    showRoots: true,
  },
});
