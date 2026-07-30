# Linux Client for Vellum Assistant

This directory contains the Linux client implementation for the Vellum Assistant. It's built as an Electron application that packages the web interface into a standalone Linux application using AppImage format.

## Features

- Linux desktop application packaged as AppImage
- Cross-distribution compatibility
- Uses the same web interface as other platforms
- Follows existing build conventions from macOS client

## Building

To build the Linux client:

```bash
cd clients/linux
bun install
bun run pack
```

The resulting AppImage will be located in `dist/`.

## Development

For development, you can run the Linux client using:

```bash
cd clients/linux
bun run dev
```