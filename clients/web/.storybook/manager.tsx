// Storybook builds the manager with the classic JSX runtime, so React must be
// in scope here even though the app tsconfig uses the automatic one.
import React from "react";
import { Button } from "storybook/internal/components";
import { addons, types } from "storybook/manager-api";
import { create } from "storybook/theming";

import {
  STORYBOOKS,
  resolveStorybookUrl,
  siblingOf,
} from "@vellumai/design-library/storybook-links";

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

const SIBLING = siblingOf("web");

addons.add("vellum/sibling-storybook", {
  type: types.TOOL,
  title: STORYBOOKS[SIBLING].label,
  render: () => (
    <Button asChild ariaLabel={false}>
      <a
        href={resolveStorybookUrl(SIBLING, window.location)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {STORYBOOKS[SIBLING].label} ↗
      </a>
    </Button>
  ),
});
