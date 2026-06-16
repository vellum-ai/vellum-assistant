# Clients Directory

This directory holds the Chrome browser extension that connects a browser to a running Vellum assistant.

## Structure

```
clients/
└── chrome-extension/   # MV3 Chrome browser extension
```

The iOS app is a Capacitor shell that lives in [`apps/ios/`](../apps/ios/); it loads the web app over HTTPS and does not consume any code from `clients/`.

## Chrome Extension

See [`chrome-extension/README.md`](chrome-extension/README.md) for build, load, environment, and publishing instructions.
