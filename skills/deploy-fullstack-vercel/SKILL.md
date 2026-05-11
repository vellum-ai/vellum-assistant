---
name: deploy-fullstack-vercel
description: Build and deploy a full-stack app (React frontend + Python/FastAPI backend) or a Vellum app to Vercel as a serverless demo with seeded data
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🚀"
  vellum:
    display-name: "Deploy Fullstack to Vercel"
---

# Deploy Fullstack to Vercel

Deploy a full-stack app with a React/Vite frontend and Python/FastAPI backend to Vercel as a serverless demo, OR deploy a Vellum-built app from the library. No auth required - meant for demos, portfolio pieces, and quick showcases.

## When to Use

- User says "deploy this to Vercel", "host this", "publish this"
- User has a project with a frontend + backend they want live
- User wants to deploy a Vellum app that uses backend features (data store, custom routes)
- User wants a quick demo deployment (no persistent database needed)

## Authentication

Before deploying, check for a Vercel API credential:

1. Run `credential_store list` and look for a `vercel/api_token` entry.
2. If found with `injection_templates`, the credential can be used automatically via `network_mode: "proxied"` with `credential_ids`.
3. If no credential exists, use `credential_store prompt` to ask the user for their Vercel API token. Direct them to https://vercel.com/account/tokens to create one.
4. Fall back to the Vercel CLI only if no usable credential exists. Install with `bun install -g vercel` (not npm — npm is not available in the sandbox).

## Deploying a Vellum App

When the user asks to deploy a Vellum app from their library (from `/workspace/data/apps/<app-name>/`):

### 1. Detect Vellum Bridge Usage

Check the compiled app for Vellum bridge API usage:

```bash
grep -l "window\.vellum\.\|vellum\.fetch\|vellum\.data\|vellum\.sendAction" /workspace/data/apps/<app-name>/dist/*.js /workspace/data/apps/<app-name>/dist/*.html 2>/dev/null
```

If found, the app depends on the Vellum bridge and needs a shim to work standalone.

### 2. Create Vellum Bridge Shim

The app uses `window.vellum.*` APIs that are normally injected by the Vellum viewer. For standalone deployment, create a `vellum-shim.js` file in the app's `dist/` directory that provides browser-native replacements.

**Before writing the shim, read the app's compiled JavaScript** (`dist/main.js` or equivalent) to understand exactly which `window.vellum.*` APIs the app calls and what data shapes it expects. The shim must match the app's actual usage — don't guess at signatures.

**Common APIs to shim (implement only what the app actually uses):**

| Bridge API                    | Standalone replacement                                | Notes                                                                                                                    |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `vellum.data.query()`         | localStorage-backed store                             | Read the app code to determine the record shape — some apps expect `{id, data: {...}}` wrappers, others use flat records |
| `vellum.data.create(...)`     | localStorage insert with `crypto.randomUUID()`        | Match the argument signature the app passes (some pass a payload, others pass `{id, ...fields}`)                         |
| `vellum.data.update(...)`     | localStorage update                                   | Match the argument signature (typically `(id, payload)`)                                                                 |
| `vellum.data.delete(...)`     | localStorage delete                                   | Typically `(id)`                                                                                                         |
| `vellum.fetch(path, opts)`    | `console.warn` + return empty success Response        | Custom routes aren't available standalone                                                                                |
| `vellum.sendAction(id, data)` | No-op with `console.warn`                             | Surface actions aren't available standalone                                                                              |
| `vellum.openLink(url)`        | `window.open(url, '_blank')`                          |                                                                                                                          |
| `vellum.widgets.toast(msg)`   | Create a temporary styled `<div>` that auto-dismisses |                                                                                                                          |
| `vellum.route`                | `null`                                                | Deep-link routes aren't available standalone                                                                             |

**Structure:** Wrap everything in an IIFE that guards against the real bridge: `(function() { if (window.vellum) return; ... })();`

### 3. Inject the Shim into index.html

Add a `<script src="vellum-shim.js"></script>` tag in `dist/index.html` BEFORE any `<script type="module">` tags:

```bash
sed -i 's|<script type="module"|<script src="vellum-shim.js"></script>\n<script type="module"|' dist/index.html
```

### 4. Deploy the App

```bash
cd /workspace/data/apps/<app-name>/dist
```

Create a `vercel.json` in the dist directory:

```json
{
  "rewrites": [
    {
      "source": "/((?!main\\.js|main\\.css|vellum-shim\\.js|assets/).*)",
      "destination": "/index.html"
    }
  ]
}
```

Then deploy using the Vercel API credential (preferred) or CLI.

## Deploying a Custom Full-Stack Project

### 1. Build the Frontend

```bash
cd <project>/frontend
bun install
bunx vite build
```

This produces static files in `frontend/dist/`.

### 2. Create the Vercel Deploy Directory

```
<project>/vercel-deploy/
├── api/
│   ├── index.py          ← FastAPI app wrapper (entry point)
│   ├── database.py        ← DB config (use /tmp for SQLite)
│   ├── models.py
│   ├── schemas.py
│   ├── seed_data.py       ← Must seed ALL required data (users, etc.)
│   ├── routers/
│   │   ├── __init__.py
│   │   └── *.py
│   └── requirements.txt   ← Python deps (fastapi, sqlalchemy, pydantic)
├── index.html             ← From frontend/dist/
├── assets/                ← From frontend/dist/assets/
└── vercel.json
```

**Key steps:**

```bash
mkdir -p <project>/vercel-deploy/api

# Copy frontend build output to deploy root
cp -r <project>/frontend/dist/* <project>/vercel-deploy/

# Copy backend files into api/
cp <project>/backend/models.py <project>/vercel-deploy/api/
cp <project>/backend/database.py <project>/vercel-deploy/api/
cp <project>/backend/schemas.py <project>/vercel-deploy/api/
cp <project>/backend/seed_data.py <project>/vercel-deploy/api/
cp -r <project>/backend/routers <project>/vercel-deploy/api/
cp <project>/backend/requirements.txt <project>/vercel-deploy/api/
```

### 3. Create api/index.py (Serverless Entry Point)

```python
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import engine, Base, SessionLocal
from seed_data import seed_exercises, seed_default_user  # all seed functions
from routers import users, exercises, workouts, schedule, progress

# Create tables and seed on EVERY cold start
Base.metadata.create_all(bind=engine)
db = SessionLocal()
try:
    seed_exercises(db)
    seed_default_user(db)  # IMPORTANT: seed all required data
finally:
    db.close()

app = FastAPI(title="MyApp")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
# ... other routers

@app.get("/api/health")
def health_check():
    return {"status": "ok"}
```

### 4. Update database.py for Vercel

**Critical:** Vercel serverless functions can only write to `/tmp`. Update the SQLite path:

```python
SQLALCHEMY_DATABASE_URL = "sqlite:////tmp/app.db"
```

### 5. Seed ALL Required Data

**This is the #1 gotcha.** Since `/tmp` is ephemeral, every cold start gets a fresh database. If your frontend assumes certain data exists (like user ID 1), you MUST seed it:

```python
def seed_default_user(db: Session):
    count = db.query(UserProfile).count()
    if count > 0:
        return
    user = UserProfile(name="Demo User", ...)
    db.add(user)
    db.commit()
```

### 6. Create vercel.json

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index.py" },
    { "source": "/((?!assets/).*)", "destination": "/index.html" }
  ]
}
```

This routes:

- `/api/*` → Python serverless function
- Everything else → React SPA (index.html)

### 7. Deploy

```bash
cd <project>/vercel-deploy
vercel --yes --prod
```

### 8. Verify

```bash
curl -s <deployed-url>/api/health
# Should return: {"status":"ok"}
```

## Gotchas & Limitations

| Issue                       | Solution                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| SQLite resets on cold start | Seed ALL required data in index.py startup                               |
| No persistent storage       | Acceptable for demos. For production, use Vercel Postgres or Supabase    |
| No auth                     | Fine for demos/portfolios. Add auth layer for real apps                  |
| `requirements.txt` location | Must be inside `api/` folder (next to index.py)                          |
| Module imports in routers   | Use `sys.path.insert(0, os.path.dirname(__file__))` in index.py          |
| CORS                        | Set `allow_origins=["*"]` for demo deployments                           |
| `--name` flag deprecated    | Don't use `--name` with Vercel CLI, just deploy from the directory       |
| Vellum bridge APIs          | Use the vellum-shim.js to provide localStorage-backed data + no-op stubs |
| npm not available           | Use `bun install -g vercel` to install Vercel CLI in sandbox             |

## Vercel CLI Quick Reference

```bash
bun install -g vercel        # Install
vercel login                 # Authenticate (opens browser — last resort)
vercel --yes --prod          # Deploy to production (skip prompts)
vercel logs --project <name> # Check function logs
```
