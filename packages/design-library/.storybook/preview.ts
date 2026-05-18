import type { Preview } from "@storybook/react-vite";

import "./preview.css";

const preview: Preview = {
  tags: ["autodocs"],
  parameters: {
    controls: { expanded: true },
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
