# Vellum Assistant - Linux (Electron)

The Linux desktop client. Like `clients/macos` and `clients/windows`, this is
an Electron shell around the `clients/web` renderer: in dev it loads the Vite
dev server (or vel's edge proxy when `vel up` is running), and in packaged
builds it serves a bundled `resources/web-dist` over a privileged `app://`
protocol. Packaged builds are AppImages.

This is the first iteration toward a Linux distribution. It re-homes the
community Linux packaging work from
[#39066](https://github.com/vellum-ai/vellum-assistant/pull/39066) onto the
current `@vellumai/electron-desktop` adapter used by Windows.

## What works now

- Electron main + preload adapter composed through the capability registry
- AppImage packaging (`bun run pack`) with per-environment icons
- Auto-update feed URL `linux-electron/<arch>/` (GCS publish is a follow-up)
- POSIX CLI install into `~/.local/bin` (same locator/wrapper model as macOS)
- Login and chat through the shared web renderer

## Not in this iteration

- Native Linux helper (dictation, verified input, computer-use, permission
  probes). Those modules are present and fail closed until a sidecar exists.
- Release-channel GCS publish and signed AppImage distribution
- Dedicated `linux` host-proxy interface id (local host-proxy currently
  advertises the `web` transport)

## Development

```bash
cd clients/linux
bun run dev
```

## Packaging

```bash
cd clients/linux
bun run pack
```

Requires `rsvg-convert` and ImageMagick (`magick` or `convert`) for icon
generation. The AppImage lands in `dist/`.

## Checks

```bash
bun run typecheck
bun run test:ci
```
