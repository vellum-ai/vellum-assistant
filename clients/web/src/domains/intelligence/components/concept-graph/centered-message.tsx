/**
 * The Memory surface's one non-graph state: a centered title, an optional line
 * of detail, and an optional action. Every state the canvas can't draw —
 * loading, error, an empty corpus, a backend with no concept graph — wears this
 * so they read as one surface rather than four. Shared by `ConceptGraphView`
 * and `MemoryUpgradePrompt`, which is also why it lives here instead of inside
 * the view (the prompt is rendered BY the view, so a local export would be a
 * cycle).
 */

export function CenteredMessage({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  /** Rendered under the detail — the state's way out (e.g. "Upgrade memory"). */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </p>
      {detail ? (
        <p
          className="max-w-sm text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {detail}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
