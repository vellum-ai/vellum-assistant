# Example — Habit Tracker

A 7-day habit grid: add habits, toggle a checkmark per day, delete habits. This is the
canonical **CRUD over a custom route** example — full create / read / update / delete
backed by a JSON file on disk, called from a multi-file TSX (`formatVersion: 2`) app via
`window.vellum.fetch`.

**What it demonstrates**

- A `routes/habits.ts` handler exporting `GET` / `POST` / `PATCH` / `DELETE`.
- Mutations addressed by `id` via a **query param** (`/v1/x/habits?id=…`) — route files
  cannot use `[id].ts` path segments (see [CUSTOM_ROUTES.md](../CUSTOM_ROUTES.md)).
- A frontend that always checks `res.ok`, surfaces errors, and re-reads after every write
  so the UI reflects persisted state rather than optimistic guesses.

## File tree

```
src/index.html
src/main.tsx
src/components/HabitTracker.tsx
src/components/HabitRow.tsx
src/styles.css
routes/habits.ts
```

## Route handler

```typescript
// routes/habits.ts — Habit CRUD, persisted as a JSON file in the app workspace.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Habit CRUD — stores habits as a JSON file";

interface Habit {
  id: string;
  name: string;
  completedDates: string[];
  createdAt: string;
}

const DATA_DIR = join(process.env.VELLUM_WORKSPACE_DIR!, "data");
const DATA_FILE = join(DATA_DIR, "habits.json");

function loadHabits(): Habit[] {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Habit[];
}

function saveHabits(habits: Habit[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(habits, null, 2));
}

export function GET(): Response {
  return Response.json(loadHabits());
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name)
    return Response.json({ error: "name is required" }, { status: 400 });

  const habit: Habit = {
    id: crypto.randomUUID(),
    name,
    completedDates: [],
    createdAt: new Date().toISOString(),
  };
  const habits = loadHabits();
  habits.push(habit);
  saveHabits(habits);
  return Response.json(habit, { status: 201 });
}

export async function PATCH(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const body = (await request.json()) as { completedDates?: unknown };
  if (!Array.isArray(body.completedDates)) {
    return Response.json(
      { error: "completedDates must be an array" },
      { status: 400 },
    );
  }

  const habits = loadHabits();
  const habit = habits.find((h) => h.id === id);
  if (!habit) return Response.json({ error: "not found" }, { status: 404 });

  habit.completedDates = body.completedDates.filter(
    (d): d is string => typeof d === "string",
  );
  saveHabits(habits);
  return Response.json(habit);
}

export function DELETE(request: Request): Response {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const habits = loadHabits();
  const next = habits.filter((h) => h.id !== id);
  if (next.length === habits.length) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  saveHabits(next);
  return Response.json({ ok: true });
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
    <title>Habit Tracker</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

```tsx
// src/main.tsx
import { render } from "preact";
import { HabitTracker } from "./components/HabitTracker.js";
import "./styles.css";

render(<HabitTracker />, document.getElementById("app")!);
```

```tsx
// src/components/HabitTracker.tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { HabitRow } from "./HabitRow.js";

interface Habit {
  id: string;
  name: string;
  completedDates: string[];
}

function getDates(): string[] {
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function getDayNames(dates: string[]): string[] {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return dates.map((d) => names[new Date(d + "T12:00:00").getDay()]);
}

export function HabitTracker() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dates = getDates();
  const dayNames = getDayNames(dates);

  const loadHabits = useCallback(async () => {
    try {
      const res = await window.vellum.fetch("/v1/x/habits");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHabits(await res.json());
      setError(null);
    } catch (e) {
      setError("Couldn't load habits. Try again.");
      console.error(e);
    }
  }, []);

  useEffect(() => {
    loadHabits();
  }, [loadHabits]);

  const addHabit = async () => {
    const name = input.trim();
    if (!name) return;
    setInput("");
    try {
      const res = await window.vellum.fetch("/v1/x/habits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadHabits();
    } catch (e) {
      setError("Couldn't add habit. Try again.");
      console.error(e);
    }
  };

  const toggleDate = async (id: string, date: string) => {
    const habit = habits.find((h) => h.id === id);
    if (!habit) return;
    const completed = habit.completedDates.includes(date)
      ? habit.completedDates.filter((d) => d !== date)
      : [...habit.completedDates, date];
    try {
      const res = await window.vellum.fetch(`/v1/x/habits?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedDates: completed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadHabits();
    } catch (e) {
      setError("Couldn't update habit. Try again.");
      console.error(e);
    }
  };

  const deleteHabit = async (id: string) => {
    try {
      const res = await window.vellum.fetch(`/v1/x/habits?id=${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadHabits();
    } catch (e) {
      setError("Couldn't delete habit. Try again.");
      console.error(e);
    }
  };

  return (
    <div>
      <div class="header">
        <h1>Habit Tracker</h1>
      </div>
      {error && <div class="error-banner">{error}</div>}
      <div class="add-form">
        <input
          type="text"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && addHabit()}
          placeholder="Add a new habit..."
        />
        <button class="btn-primary" onClick={addHabit}>
          Add
        </button>
      </div>
      <div class="days-header">
        <div />
        {dayNames.map((name, i) => (
          <div key={i} class="day-label">
            {name}
          </div>
        ))}
      </div>
      <div>
        {habits.length === 0 ? (
          <div class="empty-state">No habits yet. Add one above!</div>
        ) : (
          habits.map((habit) => (
            <HabitRow
              key={habit.id}
              habit={habit}
              dates={dates}
              onToggle={toggleDate}
              onDelete={deleteHabit}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

```tsx
// src/components/HabitRow.tsx
interface Habit {
  id: string;
  name: string;
  completedDates: string[];
}

interface HabitRowProps {
  habit: Habit;
  dates: string[];
  onToggle: (id: string, date: string) => void;
  onDelete: (id: string) => void;
}

export function HabitRow({ habit, dates, onToggle, onDelete }: HabitRowProps) {
  return (
    <div class="habit-row">
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span class="habit-name">{habit.name}</span>
        <button class="delete-btn" onClick={() => onDelete(habit.id)}>
          x
        </button>
      </div>
      {dates.map((date) => {
        const checked = habit.completedDates.includes(date);
        return (
          <div key={date} class="check-cell">
            <button
              class={`check-btn${checked ? " checked" : ""}`}
              onClick={() => onToggle(habit.id, date)}
            >
              {checked ? "\u2713" : ""}
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

```css
/* src/styles.css */
:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --primary: #6366f1;
  --primary-hover: #5558e6;
  --success: #22c55e;
  --text: #f1f5f9;
  --text-secondary: #94a3b8;
  --border: #334155;
  --radius: 10px;
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
  padding: 24px;
  min-height: 100vh;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
h1 {
  font-size: 1.4rem;
  font-weight: 600;
}
.error-banner {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 16px;
  font-size: 0.85rem;
}
.add-form {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}
.add-form input {
  flex: 1;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-family: inherit;
  font-size: 0.9rem;
  outline: none;
}
.add-form input:focus {
  border-color: var(--primary);
}
.add-form input::placeholder {
  color: var(--text-secondary);
}
button {
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 10px 18px;
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
.days-header {
  display: grid;
  grid-template-columns: 1fr repeat(7, 40px);
  gap: 4px;
  margin-bottom: 8px;
  padding: 0 4px;
}
.day-label {
  text-align: center;
  font-size: 0.7rem;
  color: var(--text-secondary);
  text-transform: uppercase;
}
.habit-row {
  display: grid;
  grid-template-columns: 1fr repeat(7, 40px);
  gap: 4px;
  padding: 10px 4px;
  border-radius: var(--radius);
  margin-bottom: 4px;
  align-items: center;
}
.habit-row:hover {
  background: var(--surface);
}
.habit-name {
  font-size: 0.9rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check-cell {
  display: flex;
  justify-content: center;
  align-items: center;
}
.check-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 2px solid var(--border);
  background: transparent;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  color: transparent;
  font-size: 14px;
}
.check-btn.checked {
  background: var(--success);
  border-color: var(--success);
  color: white;
}
.check-btn:hover {
  border-color: var(--success);
}
.delete-btn {
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 4px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  border-radius: 4px;
}
.delete-btn:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}
.empty-state {
  text-align: center;
  padding: 48px 0;
  color: var(--text-secondary);
}
```
