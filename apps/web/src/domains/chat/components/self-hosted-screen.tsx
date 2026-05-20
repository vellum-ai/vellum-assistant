
import { routes } from "@/utils/routes.js";
import { useRouting } from "@/domains/chat/hooks/use-routing.js";

export function SelfHostedScreen() {
  const { push } = useRouting();
  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        { }
        <span className="text-3xl" role="img" aria-label="house">
          &#x1F3E0;
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        Self-hosted assistant
      </h2>
      <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        Conversations for self-hosted assistants aren&apos;t available from the
        web yet. Manage your assistant from settings.
      </p>
      <button
        onClick={() => push(routes.settings.root)}
        className="mt-6 flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
      >
        Open settings
      </button>
    </div>
  );
}
