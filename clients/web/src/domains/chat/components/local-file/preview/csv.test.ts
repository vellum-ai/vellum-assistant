import { describe, expect, test } from "bun:test";

import {
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  parseCsv,
} from "@/domains/chat/components/local-file/preview/csv";

describe("parseCsv", () => {
  test("reads a header row and its data", () => {
    const parsed = parseCsv("name,count\nalpha,1\nbeta,2\n");

    expect(parsed.headers).toEqual(["name", "count"]);
    expect(parsed.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
    expect(parsed.truncated).toBe(false);
  });

  test("keeps a numeric first row as data", () => {
    const parsed = parseCsv("1,2\n3,4\n");

    expect(parsed.headers).toBeNull();
    expect(parsed.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("keeps a first row with a blank cell as data", () => {
    const parsed = parseCsv("name,\nalpha,1\n");

    expect(parsed.headers).toBeNull();
    expect(parsed.rows.length).toBe(2);
  });

  test("a single record is data, not a header with nothing under it", () => {
    const parsed = parseCsv("name,count");

    expect(parsed.headers).toBeNull();
    expect(parsed.rows).toEqual([["name", "count"]]);
  });

  test("quoted fields keep their delimiters, newlines, and quotes", () => {
    const parsed = parseCsv(
      'name,note,count\n"Smith, Ann","line one\nline two",1\n"Q","he said ""hi""",2\n',
    );

    expect(parsed.headers).toEqual(["name", "note", "count"]);
    expect(parsed.rows).toEqual([
      ["Smith, Ann", "line one\nline two", "1"],
      ["Q", 'he said "hi"', "2"],
    ]);
  });

  test("an all-text file shows every row rather than guessing a header", () => {
    const parsed = parseCsv("name,note\nalpha,ok\nbeta,fine\n");

    expect(parsed.headers).toBeNull();
    expect(parsed.rows.length).toBe(3);
  });

  test("CRLF endings parse the same as LF", () => {
    const parsed = parseCsv("name,count\r\nalpha,1\r\n");

    expect(parsed.headers).toEqual(["name", "count"]);
    expect(parsed.rows).toEqual([["alpha", "1"]]);
  });

  test("ragged rows are padded to the widest record", () => {
    const parsed = parseCsv("a,b,c\n1\n2,3\n");

    expect(parsed.rows).toEqual([
      ["1", "", ""],
      ["2", "3", ""],
    ]);
  });

  test("blank lines between records are dropped", () => {
    const parsed = parseCsv("name,count\n\nalpha,1\n\n");

    expect(parsed.rows).toEqual([["alpha", "1"]]);
  });

  test("a semicolon file is sniffed from its first line", () => {
    const parsed = parseCsv("name;count;note\nalpha;1;ok\n");

    expect(parsed.headers).toEqual(["name", "count", "note"]);
    expect(parsed.rows).toEqual([["alpha", "1", "ok"]]);
  });

  test("a tab file is sniffed from its first line", () => {
    const parsed = parseCsv("name\tcount\nalpha\t1\n");

    expect(parsed.headers).toEqual(["name", "count"]);
    expect(parsed.rows).toEqual([["alpha", "1"]]);
  });

  test("a comma wins a tie against a semicolon", () => {
    const parsed = parseCsv("name,note;extra\nalpha,1;2\n");

    expect(parsed.rows).toEqual([
      ["name", "note;extra"],
      ["alpha", "1;2"],
    ]);
  });

  test("delimiters inside quotes do not decide the sniff", () => {
    const parsed = parseCsv('"a;b;c;d",count\nvalue,1\n');

    expect(parsed.headers).toEqual(["a;b;c;d", "count"]);
    expect(parsed.rows).toEqual([["value", "1"]]);
  });

  test("leading blank lines do not decide the sniff", () => {
    const parsed = parseCsv("\n\nname;count\nalpha;1\n");

    expect(parsed.headers).toEqual(["name", "count"]);
  });

  test("a UTF-8 BOM is not part of the first cell", () => {
    const parsed = parseCsv("﻿name,count\nalpha,1\n");

    expect(parsed.headers).toEqual(["name", "count"]);
  });

  test("a file with no trailing newline keeps its last record", () => {
    const parsed = parseCsv("name,count\nalpha,1");

    expect(parsed.rows).toEqual([["alpha", "1"]]);
  });

  test("empty input parses to nothing", () => {
    expect(parseCsv("")).toEqual({
      headers: null,
      rows: [],
      truncated: false,
    });
    expect(parseCsv("\n\n  \n")).toEqual({
      headers: null,
      rows: [],
      truncated: false,
    });
  });

  test("rows past the cap are dropped and reported", () => {
    const lines = ["name,count"];
    for (let i = 0; i < MAX_CSV_ROWS + 10; i += 1) {
      lines.push(`row-${i},${i}`);
    }

    const parsed = parseCsv(`${lines.join("\n")}\n`);

    expect(parsed.truncated).toBe(true);
    // The header is one of the capped records.
    expect(parsed.rows.length).toBe(MAX_CSV_ROWS - 1);
  });

  test("a file that ends exactly at the cap is not truncated", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_CSV_ROWS; i += 1) {
      lines.push(`row-${i},${i}`);
    }

    const parsed = parseCsv(`${lines.join("\n")}\n`);

    expect(parsed.truncated).toBe(false);
    expect(parsed.rows.length).toBe(MAX_CSV_ROWS);
  });

  test("columns past the cap are dropped and reported", () => {
    const cells: string[] = [];
    for (let i = 0; i < MAX_CSV_COLUMNS + 5; i += 1) {
      cells.push(`c${i}`);
    }

    const parsed = parseCsv(`${cells.join(",")}\n${cells.join(",")}\n`);

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows[0]!.length).toBe(MAX_CSV_COLUMNS);
  });
});
