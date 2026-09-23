import { useEffect, useRef, useState } from "react";

import { useComposerStore } from "@/domains/chat/composer-store";
import { autoprofilePreviewPost } from "@/generated/daemon/sdk.gen";

/**
 * How long the draft has to sit unchanged before it is previewed. Each
 * preview is a billed Jev call, so this is the whole cost control: a message
 * sent before the pause never previews at all.
 */
export const AUTO_PROFILE_PREVIEW_DEBOUNCE_MS = 1_500;

/**
 * The default profile the Auto profile would pick for the composer's current
 * draft, refreshed after the user pauses typing. Null while the draft is
 * empty, while `enabled` is false, or until the first answer lands. A stale
 * answer stays up while the user keeps typing so the pill does not flicker,
 * and clears the moment the draft is emptied.
 */
export function useAutoProfilePreview(args: {
  assistantId: string;
  conversationId: string | undefined;
  enabled: boolean;
}): string | null {
  const draft = useComposerStore.use.input();
  const [profile, setProfile] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const text = args.enabled ? draft.trim() : "";

  useEffect(() => {
    if (text.length === 0) {
      inFlight.current?.abort();
      inFlight.current = null;
      setProfile(null);
      return;
    }
    const timer = setTimeout(() => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      void autoprofilePreviewPost({
        path: { assistant_id: args.assistantId },
        body: {
          text,
          ...(args.conversationId
            ? { conversationId: args.conversationId }
            : {}),
        },
        signal: controller.signal,
        throwOnError: true,
      })
        .then(({ data }) => {
          if (!controller.signal.aborted) {
            setProfile(data.profile);
          }
        })
        .catch(() => {
          // A failed or aborted preview leaves the last answer in place; the
          // turn itself falls back to Balanced independently of this cue.
        });
    }, AUTO_PROFILE_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [args.assistantId, args.conversationId, text]);

  return profile;
}
