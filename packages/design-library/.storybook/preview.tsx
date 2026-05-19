import type { Preview } from "@storybook/react-vite";
import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { create, themes } from "storybook/theming";
import type { PropsWithChildren } from "react";

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

const preview: Preview = {
  tags: ["autodocs"],
  parameters: {
    controls: { expanded: true },
    docs: {
      container: ThemedDocsContainer,
    },
  },
  globalTypes: {
    theme: {
      description: "Color theme for components",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
          { value: "velvet", title: "Velvet", icon: "heart" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals["theme"] as string) ?? "light";

      // Apply theme to the document root so CSS variables resolve globally.
      // Both the <html> element and <body> are updated so docs-mode inline
      // previews and standalone canvas stories both pick up the tokens.
      document.documentElement.setAttribute("data-theme", theme);
      document.body.setAttribute("data-theme", theme);

      return Story();
    },
  ],
};

export default preview;
