import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * A link inside running text: the one look for "this goes somewhere".
 *
 * Before this existed the web client had nineteen colour and underline
 * treatments for a text link. They reduce to two, and those are the tones:
 *
 * - `default`: the link ink (`--content-link`), underlined. For a link that
 *   should read as a link at a glance: a docs link, a markdown link, "Learn
 *   more".
 * - `quiet`: the surrounding text's own ink, underlined, settling to
 *   `--content-default` on hover. For a link in a footnote or a legal line,
 *   where the link ink would shout over the sentence it sits in.
 *
 * Both are underlined at rest. Colour alone does not mark a link for someone
 * who cannot tell the link ink from the body ink (WCAG 1.4.1), and an
 * underline that appears only on hover never appears on touch.
 *
 * The size, weight and line height are the surrounding text's. A link does
 * not set its own type scale.
 *
 * Navigation is a `TextLink`; an action that happens to look like a link
 * (Skip, Retry, Show more) is `Button variant="link"`, which is a real button
 * and says so to assistive technology.
 *
 * Use `asChild` to keep the look on an element that owns the navigation, a
 * router `Link` or an app-level external-anchor wrapper:
 *
 *   <TextLink asChild>
 *     <Link to={routes.settings.privacy}>Privacy settings</Link>
 *   </TextLink>
 *
 * The library stays unaware of routers and native shells. Behaviour such as
 * opening in the system browser belongs to the element passed through
 * `asChild`, not here.
 */
const textLinkVariants = cva(
  [
    "cursor-pointer rounded-sm underline outline-none transition-colors",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
  ].join(" "),
  {
    variants: {
      tone: {
        default:
          "text-[color:var(--content-link)] hover:text-[color:var(--content-link-hover)]",
        quiet: "text-[color:inherit] hover:text-[color:var(--content-default)]",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

type TextLinkVariantProps = VariantProps<typeof textLinkVariants>;

export type TextLinkTone = NonNullable<TextLinkVariantProps["tone"]>;

export interface TextLinkProps extends ComponentProps<"a"> {
  tone?: TextLinkTone;
  /**
   * Render as the child element (a router `Link`, an external-anchor
   * wrapper) while keeping the link look. Uses Radix's `Slot`, so the child
   * must accept `className` and `ref`.
   */
  asChild?: boolean;
}

export function TextLink({
  tone,
  asChild = false,
  className,
  ref,
  ...props
}: TextLinkProps) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      {...props}
      ref={ref}
      data-slot="text-link"
      className={cn(textLinkVariants({ tone }), className)}
    />
  );
}

export { textLinkVariants };
