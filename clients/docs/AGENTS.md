# clients/docs: Agent Guidance

Applies to all code under `clients/docs/`. Subordinate to [`clients/AGENTS.md`](../AGENTS.md) and the root [`AGENTS.md`](../../AGENTS.md).

`@vellumai/docs` is the public docs site: an SSR Next.js app (standalone output) serving www.vellum.ai/docs. It is a member of the root bun workspace.

## URL rules: everything public lives under `/docs`

Ingress only routes `/docs/*` to this app. Every URL the app emits publicly MUST be `/docs`-prefixed:

- Pages are authored under `src/app/docs/` with no `basePath`.
- The search API is `/docs/api/search`, markdown mirrors are `/docs/<path>.md` (index: `/docs/index.md`), the agent index is `/docs/llms.txt`, the sitemap is `/docs/sitemap.xml`, and assets are served from `public/docs/`.
- Next's build assets are served under the prefix too: `assetPrefix: "/docs"` in `next.config.ts` plus the first `beforeFiles` rewrite (`/docs/_next/*` → `/_next/*`). Without both halves, stylesheets and scripts resolve to `/_next/*`, which ingress routes to a different backend. `verify-parity.ts` asserts asset subresources load.
- The only exception is `/api/health`: GKE BackendConfig health checks hit the pod directly and bypass ingress path rules.
- Canonical URLs are absolute `https://www.vellum.ai<path>` via `createMetadata` (`src/lib/metadata.ts`). Never change a page's `path:` value; URLs did not change in the migration, and native clients link the legal paths (`/docs/privacy-policy`, `/docs/vellum-terms-of-use`, `/docs/prohibited-use`) directly.
- Links to non-docs Vellum surfaces (signup, login, the assistant app) are cross-app now: absolute URLs from `src/lib/routes.ts`.

## The `%5Fmd` folder encoding trick

The markdown mirror route lives at `src/app/docs/%5Fmd/[[...slug]]/route.ts` and serves `/docs/_md`. A folder literally named `_md` is private to the app router (underscore prefix) and would be excluded from routing; `%5F` is the URL-encoded `_`, which registers the public route. The filesystem walkers (sitemap route discovery, the markdown/search generators) treat `%5F`-encoded names as private the same as a literal underscore prefix, and the attribution proxy excludes the `/docs/_md` URL path. Do not "fix" the folder name.

## Authoring content

- One `page.tsx` per route. Each exports `metadata = createMetadata({...})` and renders a content component from `src/app/docs/_components/`.
- Assets go in `public/docs/` as WebP under 200 KB, with intrinsic `width`/`height` declared on `next/image` (all images are `unoptimized`, so declared dimensions are what prevents layout shift). OG images are PNG for scraper compatibility; `public/docs/og.png` is the default OG image via `createMetadata`.
- The sitemap, search index, markdown mirrors, and `llms.txt` all derive from the filesystem tree at build time; adding or moving a page needs no list updates. Redirect-only stub pages must be added to `REDIRECT_STUB_ROUTES` in `src/lib/discover-docs-routes.ts` so the sitemap skips them.
- `scripts/platform-route-snapshot.json` is the Phase 1 route-parity baseline; `bun scripts/verify-parity.ts <base-url>` checks the tree and a running instance against it.

## Generated artifacts

| Command | Output |
| --- | --- |
| `bun run docs:search:index` | `public/docs/search-index.json` |
| `bun run generate:agent-markdown` | `generated/md/**`, `generated/md/docs-index.json`, `public/docs/llms.txt` |

Both run automatically via `predev`/`prebuild`. All outputs are gitignored. Next standalone output omits `public/` and `generated/`, so the Dockerfile copies both into the runtime image explicitly.

## Theme contract

- Dark mode is stamped on `<html>` as BOTH the `.dark` class (docs-theme.css selectors) and `data-theme="dark"` (design-library `tokens.css` custom variant). Any code that changes the theme must set both.
- Storage key precedence when reading: `device:theme` (the assistant SPA's key) first, then `vellum_theme` (the shared platform key), then system preference. The platform-only `velvet` value counts as dark.
- The theme picker writes BOTH keys (`vellum_theme` and `device:theme`); the pre-hydration bootstrap in `src/app/layout.tsx` and `docs-theme-picker.tsx` implement the contract. The apps share the www.vellum.ai origin, so do not rename either key.

## Attribution contract (`src/proxy.ts`)

- The proxy emits one `page_view` JSON line to stdout per real page load. The BigQuery log sink and dbt (`stg_marketing_events__page_views`) parse the exact field names (`source`, `event`, `vid`, `path`, `referrer`, `timestamp`, `utm_*`, click IDs, `utm_resolution`). Do NOT change field names or the single-line JSON shape.
- The `vellum_vid` cookie is 90-day HttpOnly, `Domain=.vellum.ai` when the Host header ends with `vellum.ai`. Read the Host header directly; `nextUrl.hostname` returns the bind address behind the GKE load balancer.
- Prefetch suppression (`Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`, `Purpose`/`Sec-Purpose`) is load-bearing: dbt carries a scrubber for a historical phantom-prefetch bug. `skipMiddlewareUrlNormalize: true` in `next.config.ts` keeps those headers visible to the proxy; do not remove it.
- This app's Kubernetes container name is `docs`. Page_view lines only reach BigQuery after the Phase 2 platform Terraform change extends the pageview sink filter (currently `container_name="nextjs"`) to container `docs`.

## Content sync contract

Docs content is synced **verbatim** from the platform repo's docs tree (`vellum-assistant-platform/web/src/app/(marketing)/docs`) — the platform source is canonical. Do not editorialize, re-style, or paraphrase during a sync; copy edits (terminology, style, factual corrections) must land in the platform source first and flow down through a sync. The only permitted deltas from the platform source are:

- Mechanical transforms: `@/app/(marketing)/docs/` → `@/app/docs/` imports, `/docs`-prefixed WebP asset paths, cross-app links absolutized to `https://www.vellum.ai/...`, and `eslint --fix` output for this package's lint rules.
- Placeholder-persona substitution required by the root `AGENTS.md` "Generic Examples" rule (this repo is public): real names in platform copy are replaced deterministically (`Marina` → `Alice`, `Sarah` → `Alice`, `Becky` → `Bob`). Extend the substitution map if new real names appear upstream.
- The structural severances and shared-shell components listed under "Deviations from the platform source" below.

Verify every sync with a fidelity audit: each file must be byte-identical to its platform source after the transforms above, and every exception must be individually explainable.

## Deviations from the platform source

Behavior ported from the platform app that intentionally differs:

- Attribution referrer/click-id classification is stricter than the platform emitter: empty click-id params (e.g. a bare `?gclid=`) emit no paid attribution, referrer domains match at hostname boundaries (exact host or dot-suffix, never substring), and `copilot.bing.com` classifies as GEO. The emitted JSON key set is unchanged.
- Search extraction/ranking adds element-boundary spacing during text extraction, indexes standalone headings unconditionally as their own chunks with level-aware scoping, and returns matched-term snippets.
- Tailwind has no class-keyed dark variant. The pre-hydration bootstrap stamps both `.dark` and `data-theme="dark"` on `<html>`; `dark:` utilities key off `data-theme` (the design-library `tokens.css` custom variant) while `docs-theme.css` selectors key off `.dark`.
- The mobile nav drawer is refactored around a shared `NavPanelShell` (`_components/nav-panel-shell.tsx`) with a ref-counted body-scroll lock (`_components/body-scroll-lock.ts`) and single-owner Cmd/Ctrl+K registration (`DocsSearch registerShortcut`). `docs-nav.tsx`, `releases-nav.tsx`, and `docs-nav-context.tsx` are therefore **hand-merged** during syncs: keep this app's shell structure and mirror only the platform's nav item data.
- Release anchor/month formatting is centralized in `src/lib/releases-server.ts` (`releaseAnchor`, `monthLabel`) and shared by `releases-content.tsx` and `releases-nav.tsx` so sidebar links always match article IDs; the platform version keeps local copies of these helpers. `releases-content.tsx` is hand-merged during syncs.

## Deferred items and known divergences from the platform app

- The React compiler is off (`reactCompiler` unset; the platform app enables it). Turning it on requires `babel-plugin-react-compiler`.
- `/docs/releases` is the only `force-dynamic` route. It fetches the public releases API at request time (`revalidate: 60`, 10 s timeout, fail-soft to an empty list). `RELEASES_API_URL` overrides the base URL; `DJANGO_INTERNAL_URL` supports in-cluster fetch without a code change.
- Search is lexical only; the platform's unreachable embeddings mode was dropped during the port.
