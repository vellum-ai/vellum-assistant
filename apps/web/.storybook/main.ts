import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
    "@storybook/addon-mcp",
  ],
  docs: {
    defaultName: "Docs",
  },
  features: {
    sidebarOnboardingChecklist: false,
    componentsManifest: true,
  },
  viteFinal(config) {
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    const existingAlias = config.resolve?.alias;
    const aliasArray = Array.isArray(existingAlias)
      ? existingAlias
      : Object.entries(existingAlias ?? {}).map(([find, replacement]) => ({
          find,
          replacement: replacement as string,
        }));
    config.resolve = {
      ...(config.resolve ?? {}),
      alias: [
        ...aliasArray,
        {
          find: /^@\//,
          replacement: path.resolve(import.meta.dirname, "../src") + "/",
        },
      ],
      preserveSymlinks: true,
    };
    config.base = process.env.STORYBOOK_BASE_PATH ?? config.base;
    return config;
  },
});
