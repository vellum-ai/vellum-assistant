import { Sparkles } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { Button, type ButtonVariant, type ButtonSize } from "@vellumai/design-library";

import { navigateToNewConversation } from "@/domains/chat/utils/conversation-navigation";

/**
 * A button that starts a new conversation pre-seeded with a prompt message.
 * Always displays the Sparkles icon to indicate LLM token usage.
 *
 * Uses the `?prompt=` URL parameter mechanism consumed by `useAutoSendEffects`
 * to auto-send the message once the new conversation mounts.
 */
export interface PromptLaunchButtonProps {
  /** The message to auto-send in the new conversation. */
  prompt: string;
  /** Button label. */
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export function PromptLaunchButton({
  prompt,
  children,
  variant = "outlined",
  size = "regular",
  className,
}: PromptLaunchButtonProps) {
  const navigate = useNavigate();

  const handleClick = useCallback(() => {
    navigateToNewConversation(navigate, { prompt });
  }, [navigate, prompt]);

  return (
    <Button
      variant={variant}
      size={size}
      leftIcon={<Sparkles />}
      onClick={handleClick}
      className={className}
    >
      {children}
    </Button>
  );
}
