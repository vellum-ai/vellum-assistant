# table

tabular data, optionally with selectable rows

```
{ columns: [{ id, label }], rows: [{ id, cells: Record<columnId, string | { text, icon?, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?, selected? }], selectionMode?: "none"|"single"|"multiple", caption? }
```
