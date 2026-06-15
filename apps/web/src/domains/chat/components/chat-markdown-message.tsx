/**
 * Chat-domain MarkdownMessage that composes the design-library primitive with
 * OAuth-aware link handling for authorization URLs and clickable workspace
 * paths: inline-code spans whose text is an absolute workspace path link to the
 * workspace browser, deep-linked to that entry.
 */

import { useMemo, type AnchorHTMLAttributes } from "react";

import { Link } from "react-router";

import {
    openMarkdownOAuthLinkInPopup,
    shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import { useWorkspaceRoot } from "@/hooks/use-workspace-root";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";
import { toWorkspaceRelativePath } from "@/utils/workspace-path";
import {
    MarkdownMessage,
    type MarkdownInlineCodeComponent,
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

/**
 * Build an inline-code renderer that turns workspace paths into in-app links to
 * the workspace browser. `root` is the absolute workspace root; until it loads
 * (or when it never resolves), every span renders as plain code.
 */
function makeWorkspacePathCode(
  root: string | undefined,
): MarkdownInlineCodeComponent {
  return function WorkspacePathCode({ text, className, children }) {
    const relativePath =
      root === undefined ? null : toWorkspaceRelativePath(text, root);
    if (relativePath === null) {
      return <code className={className}>{children}</code>;
    }
    return (
      <Link
        to={routes.workspaceAt(relativePath)}
        className={cn(
          className,
          "cursor-pointer underline decoration-dotted underline-offset-2 hover:opacity-80",
        )}
      >
        {children}
      </Link>
    );
  };
}

export type ChatMarkdownMessageProps = Omit<
  MarkdownMessageProps,
  "linkComponent" | "inlineCodeComponent"
>;

export function ChatMarkdownMessage(props: ChatMarkdownMessageProps) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const workspaceRoot = useWorkspaceRoot(assistantId);
  const inlineCodeComponent = useMemo(
    () => makeWorkspacePathCode(workspaceRoot),
    [workspaceRoot],
  );

  return (
    <MarkdownMessage
      {...props}
      linkComponent={OAuthAwareLink}
      inlineCodeComponent={inlineCodeComponent}
    />
  );
}
