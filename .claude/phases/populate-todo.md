## Populate TODO.md

1. Read `.private/TODO.md` (preserve existing items).
2. Prepend milestone issues as TODO items at the top, prefixed with the namespace:

```
- [<namespace>] M1: <title> (#<issue-number>)
- [<namespace>] M2: <title> (#<issue-number>)
...
```

3. Write the updated file back. Verify the write preserved existing items.
