# Custom Route Handlers (User-Defined Routes)

When the app needs server-side persistence, custom API logic, or workspace file access, use **user-defined routes**. Route handlers are TypeScript or JavaScript files that live in the workspace `routes/` directory and are served under the `/v1/x/` URL path.

**Common use cases:** CRUD storage, file-based persistence, search/aggregation, external API proxying, webhook receivers.

## Handler file convention

Each handler file exports named functions for the HTTP methods it supports (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`). Handlers receive two arguments: the standard Web API `Request` and an optional `context` object with runtime singletons.

```
{workspaceDir}/routes/
  items.ts               # Handles /v1/x/items
  items/
    [id].ts              # Not supported — use query params instead
    index.ts             # Also handles /v1/x/items (index convention)
```

## Example handler — JSON file persistence

```typescript
// routes/items.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const description = "Item CRUD — stores records as a JSON file";

const DATA_DIR = join(process.env.VELLUM_WORKSPACE_DIR!, "data");
const DATA_FILE = join(DATA_DIR, "items.json");

function loadItems(): Array<Record<string, unknown>> {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
}

function saveItems(items: Array<Record<string, unknown>>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

export function GET(): Response {
  return Response.json(loadItems());
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const items = loadItems();
  const item = {
    id: crypto.randomUUID(),
    ...body,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  saveItems(items);
  return Response.json(item, { status: 201 });
}
```

## Calling routes from the app frontend

Apps call custom routes via `window.vellum.fetch()` using the `/v1/x/` prefix. This authenticated wrapper automatically injects the gateway URL and auth headers so requests reach the assistant runtime. **Never use raw `fetch()` for `/v1/x/` routes** — it will fail because the app runs in a sandboxed origin.

```typescript
// In a TSX component or HTML script
const res = await window.vellum.fetch("/v1/x/items");
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const items = await res.json();

// Create a new item
const createRes = await window.vellum.fetch("/v1/x/items", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "New item", status: "active" }),
});
if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`);
```

## Runtime context

Every handler receives a frozen `context` object as its second argument. This provides access to daemon singletons that are otherwise unreachable from dynamically imported route modules.

```typescript
export async function POST(request: Request, context): Promise<Response> {
  // context.assistantEventHub — publish events to connected SSE clients
  // context.assistantId       — the daemon's logical assistant ID ("self")
}
```

### Publishing events to the client

Use `context.assistantEventHub` to push real-time events to connected desktop/mobile clients. This is how route handlers can trigger client-side navigation, update UI, or deliver notifications.

```typescript
// routes/open-conversation.ts
export async function POST(request: Request, context): Promise<Response> {
  const { conversationId } = await request.json();

  await context.assistantEventHub.publish({
    id: crypto.randomUUID(),
    assistantId: context.assistantId,
    conversationId,
    emittedAt: new Date().toISOString(),
    message: { type: "open_conversation", conversationId },
  });

  return Response.json({ ok: true });
}
```

The context object is **immutable** — attempting to reassign its properties will throw in strict mode (ESM). This prevents user route handlers from accidentally corrupting shared state.

Legacy handlers that only accept `(request)` continue to work — the context is passed positionally but ignored if the handler doesn't declare the parameter.

## Key rules

- Always create the route handler files via `file_write` before calling `app_refresh`
- Export an optional `description` string for CLI discoverability (`assistant routes list`)
- Handlers have full Node.js API access — `fs`, `path`, `crypto`, etc.
- Handlers get a 30-second timeout per request
- Files are hot-reloaded on change (mtime-based cache)
- Use `.ts` (preferred) or `.js` extensions
- Route resolution: `routes/foo.ts` → `/v1/x/foo`, `routes/bar/index.ts` → `/v1/x/bar`

## Using custom routes in TSX components

```tsx
const [items, setItems] = useState<Item[]>([]);

useEffect(() => {
  window.vellum
    .fetch("/v1/x/items")
    .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
    .then(setItems)
    .catch(console.error);
}, []);
```

## Error handling

All `window.vellum.fetch()` calls to custom routes must be wrapped in `try/catch` with user-friendly feedback. Always check `res.ok` before parsing the response body. Never let a failed operation silently pass — always show a toast or inline error.
