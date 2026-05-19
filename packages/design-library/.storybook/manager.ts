import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const theme = create({
  base: "light",
  brandTitle: "Vellum Design Library",
  brandUrl: "https://github.com/vellum-ai/vellum-assistant",

  appBg: "#F6F5F4",
  appContentBg: "#FFFFFF",
  appBorderColor: "#F2F0EE",
  appBorderRadius: 8,

  textColor: "#24292E",
  textMutedColor: "#5A6672",

  colorPrimary: "#17191C",
  colorSecondary: "#17191C",

  barBg: "#FFFFFF",
  barTextColor: "#5A6672",
  barSelectedColor: "#24292E",

  inputBg: "#FFFFFF",
  inputBorder: "#CFCCC9",
  inputTextColor: "#24292E",
});

addons.setConfig({
  theme,
  sidebar: {
    showRoots: true,
  },
});
