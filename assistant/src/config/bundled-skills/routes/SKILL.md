---
name: routes
description: Create and manage custom HTTP route handlers under /x/*
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F6E4\uFE0F"
  vellum:
    display-name: "Routes"
---

Create custom HTTP endpoints by dropping handler files into `/workspace/routes/`. Each file maps to a URL under `/x/*` via file-based routing.

## File-Based Routing

Route path maps directly to the filesystem:

```
/workspace/routes/foo.ts           → /x/foo
/workspace/routes/my-app/status.ts → /x/my-app/status
/workspace/routes/my-app/index.ts  → /x/my-app       (index convention)
```

Supported file extensions: `.js`, `.ts`. Subdirectories are supported for grouping related endpoints.

## Handler Format

Export named functions matching HTTP methods. Signature: `(request: Request) => Response | Promise<Response>` using standard [Web API Request](https://developer.mozilla.org/en-US/docs/Web/API/Request) and [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response).

```typescript
// /workspace/routes/my-api/submit.ts

export const description = "Form submission handler";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  return Response.json({ success: true, data: body });
}
```

### Supported method exports

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`

Only exported functions matching these names are routed. Other exports are ignored.

### Optional metadata

```typescript
export const description = "Human-readable description shown by `assistant routes list`";
```

## Multi-Method Handler

A single file can export multiple methods:

```typescript
// /workspace/routes/items.ts

export const description = "Item CRUD endpoints";

export async function GET(request: Request): Promise<Response> {
  const items = await listItems();
  return Response.json({ items });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const item = await createItem(body);
  return Response.json(item, { status: 201 });
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  await deleteItem(id);
  return new Response(null, { status: 204 });
}
```

## CLI Commands

```sh
assistant routes list                  # List all handlers with methods and public URLs
assistant routes list --json           # Machine-readable output
assistant routes inspect <path>        # Detailed info for a specific handler
assistant routes inspect <path> --json
```

## Behavior

- **Hot-reload:** New, changed, or deleted files are picked up without daemon restart (mtime-based cache busting).
- **Auth:** All `/x/*` routes go through standard daemon JWT auth. No unauthenticated traffic.
- **Timeout:** 30-second per-request default.
- **Errors:** Missing file returns 404. Unsupported method returns 405 with `Allow` header. Handler crash returns 500.
- **Path traversal:** Paths containing `..` are rejected.
- **Body limit:** Inherits daemon global limit (512 MB). Handlers can enforce tighter limits.

## When building apps with API backends

When an app at `/x/my-dashboard` needs dynamic API endpoints, create handler files under `/workspace/routes/my-dashboard-api/` so the app can call its own backend at `/x/my-dashboard-api/*`.
