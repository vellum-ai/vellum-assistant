---
name: "Configure Platform URL"
description: "Set or check the Vellum platform base URL used for authentication and API calls"
user-invocable: true
metadata: {"vellum": {"emoji": "🔗"}}
---

You are helping the user configure the Vellum platform base URL. This URL determines which Vellum platform instance the assistant authenticates against.

## Step 1: Check Current Value

Run this command to see the current platform base URL:

```bash
vellum config get platform.baseUrl
```

If the result is empty, the default is being used:
- **Production**: `https://platform.vellum.ai`
- **Debug builds**: `http://localhost:8000`

## Step 2: Set a New Value

To point to a different Vellum platform instance:

```bash
vellum config set platform.baseUrl "https://your-platform-url.example.com"
```

The URL must start with `http://` or `https://`.

## Step 3: Reset to Default

To clear the custom URL and revert to the compiled default:

```bash
vellum config set platform.baseUrl ""
```

## Notes

- Changes take effect after the macOS app reconnects to the daemon (reopen Settings > Connect)
- The platform URL is used for user authentication (login/logout) and health checks
- You can also edit this value in Settings > Connect (requires dev mode)
