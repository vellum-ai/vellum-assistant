import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const lightManagerTheme = create({
  base: "light",

  brandTitle: "Vellum Web",
  brandUrl: "https://github.com/vellum-ai/vellum-assistant",
  appBorderRadius: 8,

  appBg: "#F6F5F4",
  appContentBg: "#FFFFFF",
  appBorderColor: "#E9E6E2",

  textColor: "#17191C",
  textMutedColor: "#5A6672",

  colorPrimary: "#17191C",
  colorSecondary: "#17191C",

  barBg: "#FFFFFF",
  barTextColor: "#5A6672",
  barSelectedColor: "#17191C",

  inputBg: "#FFFFFF",
  inputBorder: "#CFCCC9",
  inputTextColor: "#17191C",
});

addons.setConfig({
  theme: lightManagerTheme,
  sidebar: {
    showRoots: true,
  },
});
