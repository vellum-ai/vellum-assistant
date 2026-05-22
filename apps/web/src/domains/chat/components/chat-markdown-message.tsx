/* eslint-disable no-restricted-syntax -- LUM-1768: file contains dark: pairs pending semantic-token migration */
/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling for authorization URLs in chat responses.
 */

import type { AnchorHTMLAttributes } from "react";

import {
  MarkdownMessage,
  type MarkdownMessageProps,
} from "@vellum/design-library";
import {
  openMarkdownOAuthLinkInPopup,
  shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links.js";

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
      className="text-forest-600 underline hover:text-forest-700 dark:text-forest-400 dark:hover:text-forest-300"
    >
      {children}
    </a>
  );
}

export type ChatMarkdownMessageProps = Omit<MarkdownMessageProps, "linkComponent">;

export function ChatMarkdownMessage(props: ChatMarkdownMessageProps) {
  return <MarkdownMessage {...props} linkComponent={OAuthAwareLink} />;
}
