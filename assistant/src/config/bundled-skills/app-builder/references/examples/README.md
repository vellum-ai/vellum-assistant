# Example Apps

Complete, copyable reference apps that demonstrate the recommended patterns from this skill:
multi-file TSX (`formatVersion: 2`), web-compatible persistence via **custom route handlers**
(`window.vellum.fetch("/v1/x/…")`), and disciplined error handling. Use them as starting
points — match the structure, not the styling (give every new app its own visual identity per
the `frontend-design` skill).

| Example                                 | Persistence pattern                              | Route methods                    |
| --------------------------------------- | ------------------------------------------------ | -------------------------------- |
| [Focus Timer](./focus-timer.md)         | Append-only log + aggregate stats read on mount  | `GET`, `POST`                    |
| [Habit Tracker](./habit-tracker.md)     | Full CRUD addressed by `id` query param          | `GET`, `POST`, `PATCH`, `DELETE` |
| [Expense Tracker](./expense-tracker.md) | Create / read / delete + client-side aggregation | `GET`, `POST`, `DELETE`          |

All three persist through a `routes/*.ts` handler. See
[CUSTOM_ROUTES.md](../CUSTOM_ROUTES.md) for the full route handler reference.
