import { definePreview } from "@storybook/react-vite";
import docsAddon from "@storybook/addon-docs";
import a11yAddon from "@storybook/addon-a11y";
import themesAddon, { withThemeByDataAttribute } from "@storybook/addon-themes";
import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { create, themes } from "storybook/theming";
import { addons } from "storybook/preview-api";
import { GLOBALS_UPDATED } from "storybook/internal/core-events";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import type { ReactRenderer } from "@storybook/react-vite";

import { i18nextInitOptions } from "../src/i18n/config";
import { FALLBACK_CATALOGS } from "../src/i18n/catalogs";

import "./preview.css";
import {
  themeFromGlobalsPayload,
  themeFromLastGlobalsEvent,
} from "./theme-globals";
import { SB_DESKTOP_VIEWPORT, SB_VIEWPORTS } from "./viewports";

// Some surfaces (e.g. OAuthConnectSurface) call `useQueryClient()`, which throws
// without a provider. Give every story a shared client so Storybook/Chromatic
// renders don't break; retries off keeps failed queries from looping in stories.
const storybookQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

// Components read their copy through `t()`, and an uninitialized i18next
// returns the raw key path, so a story of any translated component would
// render "conversationAssets.label" instead of "3 assets". Stories are visual
// fixtures reviewed against the source copy, so this is pinned to English
// rather than routed through `initI18n()`, whose job is to resolve whatever
// locale the host prefers.
void i18next
  .use(new ICU())
  .use(initReactI18next)
  .init(i18nextInitOptions("en", { en: FALLBACK_CATALOGS }));

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
  const last: unknown = addons.getChannel().last(GLOBALS_UPDATED);
  return themeFromLastGlobalsEvent(last);
}

function ThemedDocsContainer({
  children,
  ...props
}: PropsWithChildren<DocsContainerProps>) {
  const [theme, setTheme] = useState<string>(readInitialTheme);

  useEffect(() => {
    const channel = addons.getChannel();
    const onGlobalsUpdated = (payload: unknown) => {
      setTheme(themeFromGlobalsPayload(payload));
    };
    channel.on(GLOBALS_UPDATED, onGlobalsUpdated);
    return () => channel.off(GLOBALS_UPDATED, onGlobalsUpdated);
  }, []);

  return (
    <DocsContainer {...props} theme={storybookThemeMap[theme] ?? themes.light}>
      {children}
    </DocsContainer>
  );
}

export default definePreview({
  addons: [docsAddon(), a11yAddon(), themesAddon()],
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
    (Story, context) => {
      const { initialEntries = ["/"], paths } = context.parameters.router ?? {};
      return (
        <QueryClientProvider client={storybookQueryClient}>
          <MemoryRouter initialEntries={initialEntries}>
            {paths == null ? (
              <Story />
            ) : (
              <Routes>
                {paths.map((path) => (
                  <Route key={path} path={path} element={<Story />} />
                ))}
              </Routes>
            )}
          </MemoryRouter>
        </QueryClientProvider>
      );
    },
  ],
  /**
   * Start every story at a desktop width.
   *
   * The Canvas iframe is otherwise whatever the window leaves it, which on a
   * split screen or a docs page lands under Tailwind's `md` breakpoint. A
   * component with `max-md:` variants then silently renders its mobile
   * treatment while the story says nothing about it, so the drawer's metrics
   * get reviewed as though they were the rail's.
   *
   * `initialGlobals` rather than a `viewport` parameter: this is the starting
   * value, and the toolbar can still move off it. A parameter would pin every
   * story open and take the mobile treatments out of reach entirely.
   */
  initialGlobals: {
    viewport: { value: SB_DESKTOP_VIEWPORT, isRotated: false },
  },
  parameters: {
    viewport: { options: SB_VIEWPORTS },
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
