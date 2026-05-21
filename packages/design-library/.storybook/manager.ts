import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const brand = {
  brandTitle: "Vellum Design Library",
  brandUrl: "https://github.com/vellum-ai/vellum-assistant",
  appBorderRadius: 8,
};

const lightManagerTheme = create({
  base: "light",
  ...brand,

  appBg: "#F6F5F4",
  appContentBg: "#FFFFFF",
  appBorderColor: "#F2F0EE",

  textColor: "#24292E",
  textMutedColor: "#5A6672",

  // colorPrimary: brand accent (selected toolbar tab underline).
  // colorSecondary: selected sidebar item background — must contrast with
  // textColor so item labels stay legible when selected. Using
  // --surface-active (stone-100 light / moss-500 dark) gives a subtle
  // highlight that doesn't fight the text.
  colorPrimary: "#17191C",
  colorSecondary: "#F2F0EE",

  barBg: "#FFFFFF",
  barTextColor: "#5A6672",
  barSelectedColor: "#24292E",

  inputBg: "#FFFFFF",
  inputBorder: "#CFCCC9",
  inputTextColor: "#24292E",
});

const darkManagerTheme = create({
  base: "dark",
  ...brand,

  appBg: "#17191C",
  appContentBg: "#1C2024",
  appBorderColor: "#24292E",

  textColor: "#F6F5F4",
  textMutedColor: "#A9B2BB",

  colorPrimary: "#F6F5F4",
  colorSecondary: "#444D56",

  barBg: "#17191C",
  barTextColor: "#A9B2BB",
  barSelectedColor: "#F6F5F4",

  inputBg: "#2D3339",
  inputBorder: "#5A6672",
  inputTextColor: "#F6F5F4",
});

const prefersDark =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches;

addons.setConfig({
  theme: prefersDark ? darkManagerTheme : lightManagerTheme,
  sidebar: {
    showRoots: true,
  },
});
