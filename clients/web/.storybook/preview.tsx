import { definePreview } from "@storybook/react-vite";
import docsAddon from "@storybook/addon-docs";
import a11yAddon from "@storybook/addon-a11y";
import themesAddonImport, {
  withThemeByDataAttribute,
} from "@storybook/addon-themes";
import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { create, themes } from "storybook/theming";
import { addons } from "storybook/preview-api";
import { GLOBALS_UPDATED } from "storybook/internal/core-events";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import type { ReactRenderer } from "@storybook/react-vite";

// @storybook/addon-themes@10.4.0 ships ESM code but its package.json omits
// `"type": "module"`, so TypeScript NodeNext resolution misreads the default
// export. The cast preserves the runtime call signature.
const themesAddon = themesAddonImport as unknown as () => ReturnType<
  typeof docsAddon
>;

import "./preview.css";

// Single module-level client so stories sharing React Query hooks (e.g.
// OAuthConnectSurface's useQueryClient) have a provider in context. Retries are
// disabled so stories don't refetch on the backend-less Storybook environment.
const storyQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

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

function readInitialTheme(): string {
  const channel = addons.getChannel();
  const last = channel.last(GLOBALS_UPDATED) as
    | [{ globals?: Record<string, unknown> }]
    | undefined;
  return (last?.[0]?.globals?.["theme"] as string) || "light";
}

function ThemedDocsContainer({
  children,
  ...props
}: PropsWithChildren<DocsContainerProps>) {
  const [theme, setTheme] = useState<string>(readInitialTheme);

  useEffect(() => {
    const channel = addons.getChannel();
    const onGlobalsUpdated = ({
      globals,
    }: {
      globals?: Record<string, unknown>;
    }) => {
      setTheme((globals?.["theme"] as string) || "light");
    };
    channel.on(GLOBALS_UPDATED, onGlobalsUpdated);
    return () => channel.off(GLOBALS_UPDATED, onGlobalsUpdated);
  }, []);

  return (
    <DocsContainer
      {...props}
      theme={storybookThemeMap[theme] ?? themes.light}
    >
      {children}
    </DocsContainer>
  );
}

export default definePreview({
  addons: [docsAddon(), a11yAddon(), themesAddon()],
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <QueryClientProvider client={storyQueryClient}>
        <Story />
      </QueryClientProvider>
    ),
    withThemeByDataAttribute<ReactRenderer>({
      themes: {
        light: "light",
        dark: "dark",
        velvet: "velvet",
      },
      defaultTheme: "light",
      attributeName: "data-theme",
    }),
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
  parameters: {
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    backgrounds: { disable: true },
    docs: {
      container: ThemedDocsContainer,
    },
    options: {
      storySort: {
        order: ["Components", "*"],
      },
    },
    a11y: {
      config: {
        rules: [{ id: "color-contrast", enabled: true }],
      },
    },
  },
});
