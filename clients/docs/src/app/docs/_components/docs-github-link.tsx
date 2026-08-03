import Image from "next/image";

const GITHUB_REPO_URL = "https://github.com/vellum-ai/vellum-assistant";

/**
 * GitHub wordmark link rendered at the end of the docs header.
 * The logo PNG is black on transparent; we invert it in dark mode via CSS.
 */
export function DocsGithubLink() {
  return (
    <a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Vellum Assistant on GitHub"
      className="docs-github-link"
    >
      <Image
        src="/docs/github-logo.png"
        alt="GitHub"
        width={294}
        height={288}
        className="docs-github-logo"
        priority
      />
    </a>
  );
}
