import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

function markup(selected = false, interactive = false) {
  return renderToStaticMarkup(
    <Table containerProps={{ "data-owns-horizontal-scroll": "" }}>
      <TableCaption>Caption</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Head</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow selected={selected} interactive={interactive}>
          <TableCell>Cell</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
}

describe("Table", () => {
  test("every part carries its data-slot", () => {
    const html = markup();
    for (const slot of [
      "table-container",
      "table",
      "table-caption",
      "table-header",
      "table-body",
      "table-row",
      "table-head",
      "table-cell",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
  });

  test("a consumer data-slot never replaces the library's", () => {
    const html = renderToStaticMarkup(
      <Table data-slot="report">
        <TableBody>
          <TableRow>
            <TableCell data-slot="report-cell">x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(html).toContain('data-slot="table"');
    expect(html).toContain('data-slot="table-cell"');
    expect(html).not.toContain('data-slot="report');
  });

  test("container props land on the scroll container, not the table", () => {
    const html = markup();
    expect(html).toMatch(
      /<div[^>]*data-owns-horizontal-scroll=""[^>]*data-slot="table-container"/,
    );
  });

  test("a selected row exposes data-state and a plain row does not", () => {
    expect(markup(true)).toContain('data-state="selected"');
    expect(markup(false)).not.toContain("data-state=");
  });

  test("an interactive row is the only one with a pointer cursor", () => {
    expect(markup(false, true)).toContain("cursor-pointer");
    expect(markup(false, false)).not.toContain("cursor-pointer");
  });
});

describe("Table layout settings", () => {
  function cell(props: Parameters<typeof Table>[0]) {
    return renderToStaticMarkup(
      <Table {...props}>
        <TableBody>
          <TableRow>
            <TableCell align="end">x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
  }

  test("density and inset set every cell's padding from the root", () => {
    expect(cell({})).toContain("py-2.5 px-3");
    expect(cell({ density: "compact" })).toContain("py-2 px-3");
    expect(cell({ density: "relaxed", inset: false })).toContain(
      "py-3 pr-4 last:pr-0",
    );
  });

  test("dividers decide where rules are drawn", () => {
    // Static markup escapes the `&` in the row-scoped classes.
    expect(cell({})).toContain("_tr]:border-b");
    expect(cell({ dividers: "header" })).not.toContain("border-b");
    expect(cell({ dividers: "none" })).not.toContain("border-b");
  });

  test("align and fixed layout land on the right elements", () => {
    const html = cell({ layout: "fixed" });
    expect(html).toContain("table-fixed");
    expect(html).toMatch(/<td[^>]*text-right/);
  });
});
