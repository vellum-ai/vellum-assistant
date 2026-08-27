import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import { useProviderActions } from "@/domains/settings/ai/use-provider-actions";
import { configLlmDefaultproviderGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";
import { useTranslation } from "@/i18n";

/**
 * What a fresh ChatGPT connection should do about the default provider.
 *
 * - `adopt`: the standing default cannot serve a turn (no credential, no
 *   connection, nothing configured at all), so chat is broken until something
 *   changes. Switching is the only outcome the user could want.
 * - `offer`: the standing default works, so the choice is the user's.
 * - `hidden`: ChatGPT already is the default, or this assistant has no
 *   default-provider routes to write through.
 */
export type ChatgptDefaultProviderVerdict = "adopt" | "offer" | "hidden";

/**
 * `unknown` means the daemon could not check (credential store unreachable),
 * not that the default is broken. Switching on it would move a working setup
 * because of a transient read, so it is treated as usable.
 */
export function chatgptDefaultProviderVerdict({
  supportsDefaultProvider,
  status,
  connectionName,
}: {
  supportsDefaultProvider: boolean;
  status: DefaultProviderStatus | undefined;
  connectionName: string;
}): ChatgptDefaultProviderVerdict {
  if (!supportsDefaultProvider) {
    return "hidden";
  }
  if (status == null) {
    return "offer";
  }
  if (status.resolvedConnectionName === connectionName) {
    return "hidden";
  }
  const { status: availability } = status.availability;
  if (availability === "ok" || availability === "unknown") {
    return "offer";
  }
  return "adopt";
}

type StepPhase = "deciding" | "hidden" | "offer" | "applying" | "applied";

interface ChatgptDefaultProviderStepProps {
  assistantId: string;
  /** The subscription row both sign-in paths just stored. */
  connection: ProviderConnection;
  /**
   * Hands the connection to the host, which persists it and closes the
   * editor. Called on Done, and straight away when there is nothing to
   * decide.
   */
  onDone: (connection: ProviderConnection) => void;
}

/**
 * The step a ChatGPT sign-in ends on: whether chat should route through the
 * new subscription.
 *
 * Signing in stores a credential and a connection and nothing else, so on an
 * assistant whose default provider has no key the next message still fails.
 * That case switches without asking; a working default is left alone behind a
 * button, because a user who signed in to add a second option did not ask for
 * their chat model to change.
 */
export function ChatgptDefaultProviderStep({
  assistantId,
  connection,
  onDone,
}: ChatgptDefaultProviderStepProps) {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<StepPhase>("deciding");
  const { setDefaultAsync } = useProviderActions(assistantId);

  const supportsDefaultProvider = useSupportsDefaultProviderSettings();
  // Read only until the verdict is in: the switch invalidates this key, and a
  // step that kept observing it would refetch a status it has already used.
  const { data: status, isPending } = useQuery({
    ...configLlmDefaultproviderGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: supportsDefaultProvider && phase === "deciding",
  });

  const apply = useCallback(async () => {
    setPhase("applying");
    try {
      await setDefaultAsync(connection);
      setPhase("applied");
    } catch {
      // The hook has already surfaced the failure as a toast; fall back to
      // the button so the user can try again.
      setPhase("offer");
    }
  }, [connection, setDefaultAsync]);

  // The host's callback is an unstable prop on both editors, so it is read
  // through a ref rather than pulled into the decision effect's deps.
  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Decided once, from the default as it stood before this sign-in: applying
  // it refreshes the status, which would otherwise re-read as "already the
  // default" and retract the step the user is looking at.
  const decidedRef = useRef(false);
  useEffect(() => {
    if (decidedRef.current) {
      return;
    }
    if (supportsDefaultProvider && isPending) {
      return;
    }
    decidedRef.current = true;
    const verdict = chatgptDefaultProviderVerdict({
      supportsDefaultProvider,
      status,
      connectionName: connection.name,
    });
    if (verdict === "hidden") {
      setPhase("hidden");
      onDoneRef.current(connection);
      return;
    }
    if (verdict === "adopt") {
      void apply();
      return;
    }
    setPhase("offer");
  }, [apply, connection, isPending, status, supportsDefaultProvider]);

  if (phase === "deciding" || phase === "hidden") {
    return null;
  }

  return (
    <div className="space-y-3">
      {phase === "applying" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {t("chatgptDefaultProviderStep.applying")}
          </Typography>
        </div>
      ) : null}

      {phase === "applied" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          {t("chatgptDefaultProviderStep.applied")}
        </Typography>
      ) : null}

      {phase === "offer" ? (
        <div className="space-y-2">
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-secondary)]"
          >
            {t("chatgptDefaultProviderStep.offerHint")}
          </Typography>
          <Button variant="primary" size="compact" onClick={() => void apply()}>
            {t("chatgptDefaultProviderStep.useForChat")}
          </Button>
        </div>
      ) : null}

      {/* Withheld mid-write: closing the editor on a switch still in flight
          would leave the user with no word on how it landed. */}
      {phase === "applying" ? null : (
        <div>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => onDone(connection)}
          >
            {t("chatgptDefaultProviderStep.done")}
          </Button>
        </div>
      )}
    </div>
  );
}
