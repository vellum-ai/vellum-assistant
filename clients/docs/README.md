# @vellumai/docs

Public docs site for the Vellum assistant: an SSR Next.js app serving
https://www.vellum.ai/docs. Production ingress routes only `/docs/*` to this
app, so every public URL and asset lives under the `/docs` prefix.

## Development

The app is self-contained: no platform environment (`vel up`, Django) is
required. The only network dependency is the releases page, which fetches
published release notes from the public `www.vellum.ai` API at request time
(override with `RELEASES_API_URL`) and renders an empty list if unreachable.

```bash
export PATH="$HOME/.bun/bin:$PATH"   # if bun isn't already on your PATH
bun install                          # resolves to the workspace root
bun run dev
```

Then open <http://localhost:3005/docs>. Everything lives under the `/docs`
prefix, so the bare root (`http://localhost:3005/`) is a 404. Before the dev
server starts, `predev` regenerates the search index and markdown mirrors
automatically; no manual generation step is needed.

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server on port 3005 |
| `bun run build` | Production build (standalone output; prebuild runs both generators) |
| `bun run start` | Serve the production build |
| `bun run lint` / `bun run typecheck` / `bun run test` | The usual checks |
| `bun run docs:search:index` | Regenerate `public/docs/search-index.json` |
| `bun run generate:agent-markdown` | Regenerate `generated/md/**` and `public/docs/llms.txt` |
| `bun scripts/verify-parity.ts <base-url>` | End-to-end parity check against a running instance |

## Build pipeline

`prebuild` renders every docs page to build the search index and the
agent-facing markdown mirrors, then `next build` produces a standalone server.
`Dockerfile` packages it on a Node runtime (port 3000, non-root), copying in
`public/` and `generated/md/` since standalone output omits them.
`.github/workflows/publish-docs-image.yaml` publishes the image as
`sandbox-images/docs-site`; CI is `pr-docs.yaml` / `ci-main-docs.yaml`.

## Where things live

- `src/app/docs/(documentation)/**/page.tsx`: one page per route; `(releases)` holds the request-time releases page
- `src/app/docs/_components/`: all content and shell components; `docs-theme.css` is the docs theme
- `src/app/docs/%5Fmd/`: the `/docs/_md` markdown mirror route (URL-encoded folder name; see `AGENTS.md`)
- `src/app/docs/api/search/`: the lexical search API; `src/lib/docs/search/` is the ranking library
- `src/lib/`: metadata/canonical helpers, URL registry, releases fetcher, route discovery
- `src/proxy.ts`: page_view attribution middleware (visitor cookie, UTM capture)
- `scripts/`: build-time generators, the parity script, and the platform route snapshot
- `public/docs/`: static assets, served under `/docs/`

See [`AGENTS.md`](./AGENTS.md) for authoring conventions and the URL, theme,
and attribution contracts.
