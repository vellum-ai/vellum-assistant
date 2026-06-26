import { describe, expect, mock, test } from "bun:test";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@vellumai/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon: _leftIcon,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    variant?: string;
    size?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{iconOnly ?? children}</button>
  ),
  Notice: ({
    children,
    actions,
    tone,
  }: {
    children?: ReactNode;
    actions?: ReactNode;
    tone?: string;
  }) => (
    <div data-testid="notice" data-tone={tone}>
      {children}
      {actions ? <div data-testid="notice-actions">{actions}</div> : null}
    </div>
  ),
  Card: {
    Root: ({
      children,
      padding: _padding,
      bordered: _bordered,
      elevated: _elevated,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
      bordered?: unknown;
      elevated?: unknown;
    }) => <div {...props}>{children}</div>,
    Body: ({
      children,
      padding: _padding,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  ResizablePanel: () => <div data-testid="resizable-panel" />,
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

const { NudgeChatBanner } = await import("@/components/nudges/nudge-chat-banner");

describe("NudgeChatBanner", () => {
  test("uses an opaque surface so transcript content does not show through", () => {
    const html = renderToStaticMarkup(
      <NudgeChatBanner
        icon={<span>icon</span>}
        title="Vellum is open source"
        subtitle="Star us on GitHub or contribute"
        ctaLabel="Star us"
        ctaAriaLabel="Star Vellum on GitHub"
        ariaLabel="Vellum is open source on GitHub"
        onAction={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("background:var(--surface-base)");
    expect(html).not.toContain("background:var(--surface-overlay)");
  });

  test("keeps the leading icon square visually distinct", () => {
    const html = renderToStaticMarkup(
      <NudgeChatBanner
        icon={<span>icon</span>}
        title="Vellum is open source"
        subtitle="Star us on GitHub or contribute"
        ctaLabel="Star us"
        ctaAriaLabel="Star Vellum on GitHub"
        ariaLabel="Vellum is open source on GitHub"
        onAction={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("background:var(--surface-lift)");
  });
});
