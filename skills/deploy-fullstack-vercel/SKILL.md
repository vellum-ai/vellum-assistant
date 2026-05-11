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

Create `vellum-shim.js` in the app's `dist/` directory. This shim provides standalone implementations of the Vellum bridge APIs using browser-native alternatives:

```javascript
// Vellum bridge shim for standalone deployment
(function() {
  if (window.vellum) return; // Bridge already present

  const APP_KEY = 'vellum_app_data';

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(APP_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveStore(store) {
    localStorage.setItem(APP_KEY, JSON.stringify(store));
  }

  window.vellum = {
    // Data store backed by localStorage — returns {id, data} wrappers
    data: {
      query: function() {
        return Object.values(loadStore());
      },
      create: function(payload) {
        var store = loadStore();
        var id = crypto.randomUUID();
        var record = { id: id, data: payload };
        store[id] = record;
        saveStore(store);
        return record;
      },
      update: function(id, payload) {
        var store = loadStore();
        if (!store[id]) return null;
        store[id].data = payload;
        saveStore(store);
        return store[id];
      },
      delete: function(id) {
        var store = loadStore();
        delete store[id];
        saveStore(store);
        return true;
      }
    },

    // fetch → no-op that returns empty success (custom routes not available standalone)
    fetch: function(path, options) {
      console.warn('[vellum-shim] fetch not available in standalone mode:', path);
      return Promise.resolve(new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    },

    // Surface actions → no-op
    sendAction: function(actionId, data) {
      console.warn('[vellum-shim] sendAction not available in standalone mode:', actionId);
    },

    // Link opening
    openLink: function(url) { window.open(url, '_blank'); },

    // Toast notifications via basic CSS
    widgets: {
      toast: function(message, options) {
        var el = document.createElement('div');
        el.textContent = message;
        Object.assign(el.style, {
          position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
          background: '#333', color: '#fff', padding: '12px 24px', borderRadius: '8px',
          zIndex: '99999', fontSize: '14px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          transition: 'opacity 0.3s', opacity: '1'
        });
        document.body.appendChild(el);
        setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, 3000);
      }
    },

    // Route (not available standalone)
    route: null
  };
})();
```

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
    { "source": "/((?!main\\.js|main\\.css|vellum-shim\\.js|assets/).*)", "destination": "/index.html" }
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

| Issue | Solution |
|-------|----------|
| SQLite resets on cold start | Seed ALL required data in index.py startup |
| No persistent storage | Acceptable for demos. For production, use Vercel Postgres or Supabase |
| No auth | Fine for demos/portfolios. Add auth layer for real apps |
| `requirements.txt` location | Must be inside `api/` folder (next to index.py) |
| Module imports in routers | Use `sys.path.insert(0, os.path.dirname(__file__))` in index.py |
| CORS | Set `allow_origins=["*"]` for demo deployments |
| `--name` flag deprecated | Don't use `--name` with Vercel CLI, just deploy from the directory |
| Vellum bridge APIs | Use the vellum-shim.js to provide localStorage-backed data + no-op stubs |
| npm not available | Use `bun install -g vercel` to install Vercel CLI in sandbox |

## Vercel CLI Quick Reference

```bash
bun install -g vercel        # Install
vercel login                 # Authenticate (opens browser — last resort)
vercel --yes --prod          # Deploy to production (skip prompts)
vercel logs --project <name> # Check function logs
```
