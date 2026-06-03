# Example — Expense Tracker

Log expenses (amount, category, description, date), see a running total and a per-category
breakdown. This example shows **create / read / delete** plus light client-side aggregation
of records fetched from a custom route.

**What it demonstrates**

- A `routes/expenses.ts` handler exporting `GET` / `POST` / `DELETE`, with server-side
  validation of the numeric `amount`.
- Deriving totals and category groupings in the component from the fetched records, so the
  server stays a thin persistence layer.
- The same `window.vellum.fetch` + `res.ok` + re-read-after-write discipline as the
  [Habit Tracker](./habit-tracker.md) example.

## File tree

```
src/index.html
src/main.tsx
src/components/ExpenseTracker.tsx
src/styles.css
routes/expenses.ts
```

## Route handler

```typescript
// routes/expenses.ts — Expense CRUD, persisted as a JSON file in the app workspace.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Expense CRUD — stores expenses as a JSON file";

interface Expense {
  id: string;
  amount: number;
  category: string;
  description: string;
  date: string;
  createdAt: string;
}

const DATA_DIR = join(process.env.VELLUM_WORKSPACE_DIR!, "data");
const DATA_FILE = join(DATA_DIR, "expenses.json");

function loadExpenses(): Expense[] {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Expense[];
}

function saveExpenses(expenses: Expense[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(expenses, null, 2));
}

export function GET(): Response {
  return Response.json(loadExpenses());
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json(
      { error: "amount must be a positive number" },
      { status: 400 },
    );
  }

  const expense: Expense = {
    id: crypto.randomUUID(),
    amount,
    category: typeof body.category === "string" ? body.category : "other",
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : "Untitled",
    date:
      typeof body.date === "string"
        ? body.date
        : new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
  const expenses = loadExpenses();
  expenses.push(expense);
  saveExpenses(expenses);
  return Response.json(expense, { status: 201 });
}

export function DELETE(request: Request): Response {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const expenses = loadExpenses();
  const next = expenses.filter((e) => e.id !== id);
  if (next.length === expenses.length) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  saveExpenses(next);
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
    <title>Expense Tracker</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

```tsx
// src/main.tsx
import { render } from "preact";
import { ExpenseTracker } from "./components/ExpenseTracker.js";
import "./styles.css";

render(<ExpenseTracker />, document.getElementById("app")!);
```

```tsx
// src/components/ExpenseTracker.tsx
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

interface Expense {
  id: string;
  amount: number;
  category: string;
  description: string;
  date: string;
  createdAt: string;
}

const CATEGORIES = [
  "food",
  "transport",
  "shopping",
  "bills",
  "entertainment",
  "other",
];

export function ExpenseTracker() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const loadExpenses = useCallback(async () => {
    try {
      const res = await window.vellum.fetch("/v1/x/expenses");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const records = (await res.json()) as Expense[];
      records.sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.createdAt.localeCompare(a.createdAt),
      );
      setExpenses(records);
      setError(null);
    } catch (e) {
      setError("Couldn't load expenses. Try again.");
      console.error(e);
    }
  }, []);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  const addExpense = async () => {
    const value = parseFloat(amount);
    if (!value || value <= 0) return;
    try {
      const res = await window.vellum.fetch("/v1/x/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: value, category, description, date }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAmount("");
      setDescription("");
      await loadExpenses();
    } catch (e) {
      setError("Couldn't add expense. Try again.");
      console.error(e);
    }
  };

  const deleteExpense = async (id: string) => {
    try {
      const res = await window.vellum.fetch(`/v1/x/expenses?id=${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadExpenses();
    } catch (e) {
      setError("Couldn't delete expense. Try again.");
      console.error(e);
    }
  };

  const { total, byCategory } = useMemo(() => {
    let total = 0;
    const byCategory: Record<string, number> = {};
    for (const e of expenses) {
      total += e.amount;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    }
    return { total, byCategory };
  }, [expenses]);

  return (
    <div>
      <h1>Expense Tracker</h1>
      {error && <div class="error-banner">{error}</div>}
      <div class="total-card">
        <div class="total-label">Total Spent</div>
        <div class="total-amount">${total.toFixed(2)}</div>
      </div>
      <div class="form-row">
        <input
          type="number"
          class="input-amount"
          value={amount}
          onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          placeholder="0.00"
          step="0.01"
          min="0"
        />
        <select
          value={category}
          onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        <input
          type="text"
          class="input-desc"
          value={description}
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && addExpense()}
          placeholder="Description..."
        />
        <input
          type="date"
          class="input-date"
          value={date}
          onInput={(e) => setDate((e.target as HTMLInputElement).value)}
        />
        <button class="btn-primary" onClick={addExpense}>
          Add
        </button>
      </div>
      <div class="section-title">By Category</div>
      <div class="categories-grid">
        {Object.keys(byCategory).length === 0 ? (
          <div class="empty-state">No categories yet</div>
        ) : (
          Object.keys(byCategory)
            .sort()
            .map((cat) => (
              <div key={cat} class="category-card">
                <div class="cat-amount">${byCategory[cat].toFixed(2)}</div>
                <div class="cat-label">
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </div>
              </div>
            ))
        )}
      </div>
      <div class="section-title">Recent Expenses</div>
      <div class="expense-list">
        {expenses.length === 0 ? (
          <div class="empty-state">
            No expenses recorded yet. Add one above!
          </div>
        ) : (
          expenses.map((e) => (
            <div key={e.id} class="expense-item">
              <div class="expense-info">
                <div class="expense-desc">{e.description}</div>
                <div class="expense-meta">
                  {e.category} {"\u00B7"} {e.date}
                </div>
              </div>
              <div class="expense-amount">${e.amount.toFixed(2)}</div>
              <button class="delete-btn" onClick={() => deleteExpense(e.id)}>
                x
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

```css
/* src/styles.css */
:root {
  --bg: #0c0c1d;
  --surface: #161630;
  --primary: #8b5cf6;
  --primary-hover: #7c4fe0;
  --text: #f0f0f5;
  --text-secondary: #8888a8;
  --border: #2a2a4a;
  --red: #ef4444;
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
h1 {
  font-size: 1.4rem;
  font-weight: 600;
  margin-bottom: 20px;
}
.error-banner {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 16px;
  font-size: 0.85rem;
}
.total-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
  text-align: center;
}
.total-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
.total-amount {
  font-size: 2.2rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.form-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
input,
select {
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-family: inherit;
  font-size: 0.9rem;
  outline: none;
}
input:focus,
select:focus {
  border-color: var(--primary);
}
input::placeholder {
  color: var(--text-secondary);
}
select {
  cursor: pointer;
}
option {
  background: var(--surface);
}
.input-amount {
  width: 100px;
}
.input-desc {
  flex: 1;
  min-width: 120px;
}
.input-date {
  width: 140px;
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
.categories-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 20px;
}
.category-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 12px;
  text-align: center;
}
.cat-amount {
  font-size: 1.1rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cat-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 2px;
}
.expense-list {
  margin-top: 16px;
}
.expense-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  margin-bottom: 6px;
}
.expense-info {
  flex: 1;
  overflow: hidden;
}
.expense-desc {
  font-size: 0.9rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.expense-meta {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 2px;
}
.expense-amount {
  font-size: 1rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-left: 12px;
  white-space: nowrap;
}
.delete-btn {
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 4px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  margin-left: 8px;
  border-radius: 4px;
}
.delete-btn:hover {
  color: var(--red);
  background: rgba(239, 68, 68, 0.1);
}
.empty-state {
  text-align: center;
  padding: 40px 0;
  color: var(--text-secondary);
}
.section-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
```
