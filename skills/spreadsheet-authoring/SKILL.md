---
name: spreadsheet-authoring
description: Create and edit Excel spreadsheets (.xlsx) whose formulas carry their computed values, so sums and totals show in every viewer, plus date and time formats, recalculating and verifying an existing workbook.
compatibility: "Needs Python in the assistant's environment with the XlsxWriter package for writing and openpyxl for verifying. Works on desktop and web."
metadata:
  emoji: "📊"
  vellum:
    category: "productivity"
    display-name: "Spreadsheet Authoring"
    activation-hints:
      - "User asks for an Excel file, an xlsx export, or a spreadsheet"
      - "User wants a table with totals, sums, or formulas"
    avoid-when:
      - "User wants to read or search an existing document"
      - "User wants a plain CSV"
---

# Spreadsheet Authoring

Write workbooks whose numbers are visible everywhere they are opened.

## A formula is stored with the value it produced

An `.xlsx` cell holding a formula stores two things: the formula text, and the
value that formula last produced. Excel fills the value in when it saves.
openpyxl writes none, because it has no formula engine.

Anything that does not run a formula engine shows what the file stores. Chat
file previews, Quick Look, Google Drive previews, and mail previews all read
the stored value, so a workbook written by openpyxl shows `=SUM(C2:C7)` where
the total should be, and a summary sheet of formulas comes out blank.

So: write the computed value next to every formula. Compute it in Python,
where the data already is.

## Install the two packages first

Both come from PyPI and neither is there by default. Run this once at the
start of the task; the import check makes it a no-op when they are already
installed.

```bash
python3 -c "import xlsxwriter, openpyxl" 2>/dev/null \
  || pip install --user --quiet XlsxWriter==3.2.9 openpyxl==3.1.5 \
  || pip install --user --quiet --break-system-packages XlsxWriter==3.2.9 openpyxl==3.1.5
```

Use `pip`, not `python3 -m pip`. Some environments mark the system Python as
externally managed, and the second form is refused there outright. If both
attempts fail, build a virtualenv somewhere that persists
(`python3 -m venv .venv`), install into it, and run the scripts below with
`.venv/bin/python`.

## Writing a new workbook

Use XlsxWriter. `write_formula(row, col, formula, format, value)` takes the
value as its last argument, which is the whole point.

```python
import datetime

import xlsxwriter

rows = [
    ("Widget", datetime.date(2026, 1, 5), 120, 4.50),
    ("Gadget", datetime.date(2026, 1, 6), 80, 12.00),
    ("Doohickey", datetime.date(2026, 1, 7), 45, 7.25),
]
last = len(rows) + 1

book = xlsxwriter.Workbook("sales.xlsx")
bold = book.add_format({"bold": True})
money = book.add_format({"num_format": "#,##0.00"})
day = book.add_format({"num_format": "yyyy-mm-dd"})

sales = book.add_worksheet("Sales")
sales.write_row(0, 0, ["Item", "Date", "Units", "Unit price", "Total"], bold)
for index, (item, sold_on, units, price) in enumerate(rows, start=1):
    sales.write_string(index, 0, item)
    sales.write_datetime(index, 1, sold_on, day)
    sales.write_number(index, 2, units)
    sales.write_number(index, 3, price, money)
    line = index + 1
    sales.write_formula(index, 4, f"=C{line}*D{line}", money, units * price)

summary = book.add_worksheet("Summary")
summary.write_string(0, 0, "Revenue", bold)
summary.write_formula(
    0, 1, f"=SUM(Sales!E2:E{last})", money, sum(u * p for _, _, u, p in rows)
)
summary.write_string(1, 0, "Items sold", bold)
summary.write_formula(1, 1, f"=COUNTA(Sales!A2:A{last})", None, len(rows))

book.close()
```

Every formula above carries its result, including the ones reaching across
sheets. Pass `None` as the format when the cell needs no number format.

### Dates and times need a number format

A date in an `.xlsx` file is a number. Without a format it shows as a serial
such as `46027`. Pass a format to `write_datetime`:

- `yyyy-mm-dd` for a date
- `hh:mm:ss` for a time of day
- `yyyy-mm-dd hh:mm:ss` for both

Build each one with `book.add_format({"num_format": "yyyy-mm-dd"})` and reuse
it for the whole column.

## Editing a workbook that already exists

XlsxWriter only writes new files, and openpyxl does not preserve cached
results. A cell's formula and the value it produced are two separate things in
the file, and openpyxl holds only one of them: loaded the default way it keeps
the formula and discards the value, loaded with `data_only=True` it keeps the
value and discards the formula. A save writes back what it kept. So saving an
existing workbook with openpyxl leaves every formula in it without a result,
including the ones the edit never touched, and the totals go blank in a
preview.

Three ways through it, best first:

- Rebuild the file with XlsxWriter from the data, writing every formula with
  its value as above. This is the only path that guarantees the result, and it
  is usually cleaner than patching.
- Save with openpyxl, then hand the file to a formula engine to fill the
  values back in. LibreOffice computes the formulas it finds without results
  and writes them out when it saves:

  ```bash
  soffice --headless --convert-to xlsx --outdir out/ book.xlsx
  ```

  `--outdir` has to differ from the input's directory, and LibreOffice is not
  installed everywhere. Verify the output rather than assuming it worked.

- Write the literal computed value instead of a formula, when the user does
  not need the formula itself.

Whichever path, run the check below on the file you are about to send.

## Verify before sharing

Read the file back and check that every formula cell has a cached value. A
`None` means the cell will look empty in a preview.

```python
from openpyxl import load_workbook

formulas = load_workbook("sales.xlsx")
values = load_workbook("sales.xlsx", data_only=True)
for sheet in formulas.worksheets:
    for row in sheet.iter_rows():
        for cell in row:
            if cell.data_type == "f":
                cached = values[sheet.title][cell.coordinate].value
                if cached is None:
                    print(f"no value: {sheet.title}!{cell.coordinate}")
```

Silence means every formula carries its value. Open the preview once as well,
to see what the user will see.

## What to tell the user

Say that the totals are written into the file, so they show up in a preview,
and that Excel recalculates them from the formulas as soon as it opens the
workbook. If a formula had to become a plain number, say which cells and why.
