import { definePreview } from "@storybook/react-vite";
import docsAddon from "@storybook/addon-docs";
import a11yAddon from "@storybook/addon-a11y";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { create, themes } from "storybook/theming";
import type { PropsWithChildren } from "react";
import type { ReactRenderer } from "@storybook/react-vite";

import "./preview.css";

const lightTheme = create({
  base: "light",
  appBg: "#F6F5F4",
  appContentBg: "#F6F5F4",
  textColor: "#24292E",
  appBorderColor: "#F2F0EE",
});

const darkTheme = create({
  base: "dark",
  appBg: "#17191C",
  appContentBg: "#17191C",
  textColor: "#F6F5F4",
  appBorderColor: "#24292E",
});

const velvetTheme = create({
  base: "dark",
  appBg: "#121214",
  appContentBg: "#121214",
  textColor: "#F6F5F4",
  appBorderColor: "#24292E",
  colorPrimary: "#E83F5B",
  colorSecondary: "#E83F5B",
});

const storybookThemeMap: Record<string, typeof themes.light> = {
  light: lightTheme,
  dark: darkTheme,
  velvet: velvetTheme,
};

function ThemedDocsContainer({
  children,
  ...props
}: PropsWithChildren<DocsContainerProps>) {
  let currentTheme = "light";
  try {
    const stories = props.context.componentStories();
    if (stories.length > 0) {
      const storyContext = props.context.getStoryContext(stories[0]);
      currentTheme = (storyContext.globals?.["theme"] as string) ?? "light";
    }
  } catch {
    // Standalone docs pages without stories fall back to light theme
  }

  return (
    <DocsContainer
      {...props}
      theme={storybookThemeMap[currentTheme] ?? themes.light}
    >
      {children}
    </DocsContainer>
  );
}

export default definePreview({
  addons: [docsAddon(), a11yAddon()],
  tags: ["autodocs"],
  decorators: [
    withThemeByDataAttribute<ReactRenderer>({
      themes: {
        light: "light",
        dark: "dark",
        velvet: "velvet",
      },
      defaultTheme: "light",
      attributeName: "data-theme",
    }),
  ],
  parameters: {
    controls: { expanded: true },
    docs: {
      container: ThemedDocsContainer,
    },
  },
});
