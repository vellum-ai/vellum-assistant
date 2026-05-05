export function makeTarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBuffer = Buffer.from(name, "utf-8");
  nameBuffer.copy(header, 0, 0, Math.min(nameBuffer.length, 100));

  Buffer.from("0000644\0", "ascii").copy(header, 100);
  Buffer.from("0000000\0", "ascii").copy(header, 108);
  Buffer.from("0000000\0", "ascii").copy(header, 116);
  Buffer.from(
    `${content.length.toString(8).padStart(11, "0")}\0`,
    "ascii",
  ).copy(header, 124);
  Buffer.from("00000000000\0", "ascii").copy(header, 136);
  Buffer.from("        ", "ascii").copy(header, 148);
  header[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);

  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148,
  );

  const data = Buffer.from(content, "utf-8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

export function makeTar(
  entries: Array<{ name: string; content: string }>,
): Buffer {
  return Buffer.concat([
    ...entries.map((entry) => makeTarEntry(entry.name, entry.content)),
    Buffer.alloc(1024, 0),
  ]);
}
