/**
 * Where a bring-your-own provider's voice is set. BYO assistants get no managed
 * catalog to pick from: their voice is a field on the provider form, which
 * lives with every other provider on Models & Services. Rendered by each
 * surface that would otherwise offer the picker, so none of them leaves an
 * empty box.
 *
 * Lives under `components/speech/` alongside the picker it stands in for, since
 * both the `chat` and `settings` domains render it.
 */

import { Link } from "react-router";

import { routes } from "@/utils/routes";

export function ByoVoiceNote() {
  return (
    <p className="text-body-small-default text-[var(--content-tertiary)]">
      Your assistant speaks through a provider you configured yourself. Set its
      voice on{" "}
      <Link
        to={`${routes.settings.ai}#text-to-speech`}
        className="text-[var(--primary-base)] hover:underline"
      >
        Models &amp; Services
      </Link>
      .
    </p>
  );
}
