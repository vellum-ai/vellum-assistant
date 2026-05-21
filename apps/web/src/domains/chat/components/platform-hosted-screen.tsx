
export function PlatformHostedScreen() {
  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        <span className="text-3xl" role="img" aria-label="computer">
          &#x1F4BB;
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        Platform hosted is coming soon!
      </h2>
      <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        To get started with your assistant, download the desktop app.
      </p>
      <a
        href={`${window.location.origin}/download`}
        className="mt-6 flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
      >
        Download the macOS app
      </a>
    </div>
  );
}
