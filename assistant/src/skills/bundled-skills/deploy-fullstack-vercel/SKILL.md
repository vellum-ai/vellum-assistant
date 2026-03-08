---
name: deploy-fullstack-vercel
description: Build and deploy a full-stack app (React frontend + Python/FastAPI backend) to Vercel as a serverless demo with seeded data
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🚀","vellum":{"display-name":"Deploy Fullstack to Vercel"}}
---

# Deploy Fullstack to Vercel

Deploy a full-stack app with a React/Vite frontend and Python/FastAPI backend to Vercel as a serverless demo. No auth required — meant for demos, portfolio pieces, and quick showcases.

## When to Use

- User says "deploy this to Vercel", "host this", "publish this"
- User has a project with a frontend + backend they want live
- User wants a quick demo deployment (no persistent database needed)

## Prerequisites

- A project with a frontend (React/Vite) and backend (FastAPI/Python)
- Vercel CLI installed (`npm install -g vercel`) and authenticated (`vercel login`)

## Workflow

### 1. Build the Frontend

```bash
cd <project>/frontend
npm install
npx vite build
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

## Vercel CLI Quick Reference

```bash
npm install -g vercel    # Install
vercel login             # Authenticate (opens browser)
vercel --yes --prod      # Deploy to production (skip prompts)
vercel logs --project <name>  # Check function logs
```
