import { ReleaseMarkdown } from "@/app/docs/_components/release-markdown";
import { WWW_DOMAIN } from "@/lib/domains";
import type { ApiRelease } from "@/lib/releases-server";
import {
  groupApiReleasesByMonth,
  monthLabel,
  releaseAnchor,
} from "@/lib/releases-server";
import { routes } from "@/lib/routes";

function monthAnchor(releasedAt: string) {
  const d = new Date(releasedAt);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `release-${year}-${month}`;
}

function formatFullDate(releasedAt: string) {
  const d = new Date(releasedAt);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface ReleasesContentProps {
  releases: ApiRelease[];
}

export function ReleasesContent({ releases }: ReleasesContentProps) {
  const groups = groupApiReleasesByMonth(releases);
  const firstRelease = groups[0]?.releases[0];
  const pageTitle = firstRelease
    ? monthLabel(new Date(firstRelease.released_at))
    : "Releases";

  return (
    <div className="docs-main min-w-0 flex-1">
      <div className="docs-breadcrumb mb-2 text-sm">Docs / Releases</div>
      <div className="docs-title-row mt-2 mb-8 flex items-start justify-between gap-6">
        <h1 className="docs-title font-['DM_Sans',sans-serif] text-4xl font-bold tracking-tight md:text-5xl">
          {pageTitle}
        </h1>
        <a
          href={routes.signup}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 no-underline transition-colors hover:border-zinc-300 hover:bg-zinc-50"
          aria-label="Sign up for Vellum Cloud"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
          Get started
        </a>
      </div>

      <a
        href={`https://${WWW_DOMAIN}/roadmap`}
        className="group mb-10 flex items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white p-5 no-underline transition-colors hover:border-zinc-300 hover:bg-zinc-50"
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-900">
            Looking for what&apos;s coming next?
          </span>
          <span className="text-sm text-zinc-600">
            See the roadmap. Shipping soon, up next, and what we&apos;re exploring.
          </span>
        </div>
        <span
          className="shrink-0 text-lg text-zinc-400 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        >
          &rarr;
        </span>
      </a>

      <div className="docs-prose space-y-12">
        {groups.map((group) => {
          const firstReleasedAt = group.releases[0]?.released_at;
          if (!firstReleasedAt) {return null;}
          return (
            <div
              key={group.month}
              id={monthAnchor(firstReleasedAt)}
              className="scroll-mt-24"
            >
              <div className="space-y-8">
                {group.releases.map((release) => (
                  <article
                    key={release.version}
                    id={releaseAnchor(release)}
                    className="rounded-xl border border-zinc-200 p-5 md:p-6 scroll-mt-24"
                  >
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <h3 className="text-base font-bold">
                        <a
                          href={`#${releaseAnchor(release)}`}
                          className="no-underline text-inherit hover:underline"
                        >
                          v{release.version}
                        </a>
                      </h3>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <time
                          dateTime={release.released_at}
                          className="text-xs text-zinc-400"
                        >
                          {formatFullDate(release.released_at)}
                        </time>
                        <a
                          href={`https://github.com/vellum-ai/vellum-assistant/releases/tag/v${release.version}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View v${release.version} on GitHub`}
                          className="inline-flex items-center justify-center rounded-md p-1 text-zinc-400 no-underline transition-colors hover:text-zinc-600 hover:bg-zinc-100"
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                          </svg>
                        </a>
                      </div>
                    </div>
                    {release.description ? (
                      <ReleaseMarkdown content={release.description} />
                    ) : (
                      <p className="text-sm text-zinc-500">
                        No release notes available.
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
