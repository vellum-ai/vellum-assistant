/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling for authorization URLs in chat responses.
 */

import type { AnchorHTMLAttributes } from "react";

import {
    openMarkdownOAuthLinkInPopup,
    shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import {
    MarkdownMessage,
    type MarkdownMessageProps,
} from "@vellumai/design-library";

function OAuthAwareLink({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  const opensOAuthPopup = shouldOpenMarkdownLinkInOAuthPopup(href);

  return (
    <a
      href={href}
      target="_blank"
      rel={opensOAuthPopup ? undefined : "noopener noreferrer"}
      onClick={(event) => {
        if (openMarkdownOAuthLinkInPopup(href)) {
          event.preventDefault();
        }
      }}
      className="text-[var(--system-positive-strong)] underline hover:opacity-80"
    >
      {children}
    </a>
  );
}

export type ChatMarkdownMessageProps = Omit<MarkdownMessageProps, "linkComponent">;

export function ChatMarkdownMessage(props: ChatMarkdownMessageProps) {
  return <MarkdownMessage {...props} linkComponent={OAuthAwareLink} />;
}
