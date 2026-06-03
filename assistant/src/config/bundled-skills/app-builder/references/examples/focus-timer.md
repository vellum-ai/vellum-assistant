# Example — Focus Timer

A Pomodoro-style timer: 25-minute work sessions alternating with 5-minute breaks, plus
cumulative stats (sessions completed, total focus minutes). This is the **simplest
persistence example** — an append-only log read once on mount and appended to whenever a
work session completes.

**What it demonstrates**

- A `routes/focus-sessions.ts` handler with just `GET` (return aggregate stats) and `POST`
  (append a completed session) — not every app needs full CRUD.
- Loading persisted stats once on mount so the counts survive reloads (the original gallery
  version kept them in memory and lost them on refresh).
- Timer/interval lifecycle handled entirely with Preact hooks (`useRef` + `useEffect`),
  with the network write isolated to the session-completion transition.

## File tree

```
src/index.html
src/main.tsx
src/components/Timer.tsx
src/styles.css
routes/focus-sessions.ts
```

## Route handler

```typescript
// routes/focus-sessions.ts — Append-only focus session log; GET returns aggregate stats.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description =
  "Focus sessions — append-only log with aggregate stats";

interface Session {
  minutes: number;
  completedAt: string;
}

const DATA_DIR = join(process.env.VELLUM_WORKSPACE_DIR!, "data");
const DATA_FILE = join(DATA_DIR, "focus-sessions.json");

function loadSessions(): Session[] {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Session[];
}

function saveSessions(sessions: Session[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2));
}

export function GET(): Response {
  const sessions = loadSessions();
  const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
  return Response.json({ sessions: sessions.length, totalMinutes });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { minutes?: unknown };
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return Response.json(
      { error: "minutes must be a positive number" },
      { status: 400 },
    );
  }

  const sessions = loadSessions();
  sessions.push({ minutes, completedAt: new Date().toISOString() });
  saveSessions(sessions);

  const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
  return Response.json(
    { sessions: sessions.length, totalMinutes },
    { status: 201 },
  );
}
```

## Frontend

```html
<!-- src/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Focus Timer</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

```tsx
// src/main.tsx
import { render } from "preact";
import { Timer } from "./components/Timer.js";
import "./styles.css";

render(
  <Timer workMinutes={25} breakMinutes={5} />,
  document.getElementById("app")!,
);
```

```tsx
// src/components/Timer.tsx
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

interface TimerProps {
  workMinutes: number;
  breakMinutes: number;
}

interface Stats {
  sessions: number;
  totalMinutes: number;
}

export function Timer({ workMinutes, breakMinutes }: TimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(workMinutes * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [isBreak, setIsBreak] = useState(false);
  const [stats, setStats] = useState<Stats>({ sessions: 0, totalMinutes: 0 });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Load persisted cumulative stats once on mount.
  useEffect(() => {
    window.vellum
      .fetch("/v1/x/focus-sessions")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(setStats)
      .catch((e) => console.error("Couldn't load focus stats", e));
  }, []);

  // Record a completed work session and refresh stats from the server response.
  const recordSession = useCallback(async () => {
    try {
      const res = await window.vellum.fetch("/v1/x/focus-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: workMinutes }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats(await res.json());
    } catch (e) {
      console.error("Couldn't save focus session", e);
    }
  }, [workMinutes]);

  // Tick effect: runs while the timer is active.
  useEffect(() => {
    if (!isRunning) return;

    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev > 1) return prev - 1;
        clearTimer();
        setIsRunning(false);
        if (!isBreak) {
          void recordSession();
          setIsBreak(true);
          return breakMinutes * 60;
        }
        setIsBreak(false);
        return workMinutes * 60;
      });
    }, 1000);

    return clearTimer;
  }, [
    isRunning,
    isBreak,
    workMinutes,
    breakMinutes,
    clearTimer,
    recordSession,
  ]);

  const toggle = () => setIsRunning((r) => !r);

  const reset = () => {
    clearTimer();
    setIsRunning(false);
    setIsBreak(false);
    setSecondsLeft(workMinutes * 60);
  };

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const display =
    String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");

  return (
    <div class="container">
      <h1>Focus Timer</h1>
      <div class={`mode-label${isBreak ? " break" : ""}`}>
        {isBreak ? "Break Time" : "Work Session"}
      </div>
      <div class="timer-display">{display}</div>
      <div class="controls">
        <button class="btn-primary" onClick={toggle}>
          {isRunning ? "Pause" : "Start"}
        </button>
        <button class="btn-secondary" onClick={reset}>
          Reset
        </button>
      </div>
      <div class="stats">
        <div class="stat-item">
          <div class="stat-value">{stats.sessions}</div>
          <div class="stat-label">Sessions</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">{stats.totalMinutes}</div>
          <div class="stat-label">Minutes</div>
        </div>
      </div>
    </div>
  );
}
```

```css
/* src/styles.css */
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --primary: #e94560;
  --primary-hover: #c73e54;
  --text: #eee;
  --text-secondary: #aaa;
  --break-color: #0f9b58;
  --radius: 12px;
}
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  background: var(--bg);
  color: var(--text);
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding: 20px;
}
.container {
  text-align: center;
  max-width: 400px;
  width: 100%;
}
h1 {
  font-size: 1.4rem;
  font-weight: 600;
  margin-bottom: 8px;
}
.mode-label {
  font-size: 0.9rem;
  color: var(--text-secondary);
  margin-bottom: 32px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.mode-label.break {
  color: var(--break-color);
}
.timer-display {
  font-size: 5rem;
  font-weight: 200;
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
  margin-bottom: 40px;
}
.controls {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 32px;
}
button {
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 500;
  padding: 10px 28px;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.2s;
}
.btn-primary {
  background: var(--primary);
  color: white;
}
.btn-primary:hover {
  background: var(--primary-hover);
}
.btn-secondary {
  background: var(--surface);
  color: var(--text);
  border: 1px solid #333;
}
.btn-secondary:hover {
  background: #1e2d4f;
}
.stats {
  display: flex;
  justify-content: center;
  gap: 32px;
}
.stat-item {
  text-align: center;
}
.stat-value {
  font-size: 1.6rem;
  font-weight: 600;
}
.stat-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 2px;
}
```
