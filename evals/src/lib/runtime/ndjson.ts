export async function* parseNdjson<T = unknown>(
  chunks: AsyncIterable<string>,
): AsyncGenerator<T> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      yield JSON.parse(line) as T;
    }
  }

  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as T;
}
