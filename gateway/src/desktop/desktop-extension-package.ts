import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function field(tag: number, value: Buffer): Buffer {
  return Buffer.concat([varint(tag * 8 + 2), varint(value.length), value]);
}

export function packageDesktopExtension(
  zip: Buffer,
  key: KeyObject,
): { id: string; crx: Buffer } {
  const publicKey = createPublicKey(key).export({
    type: "spki",
    format: "der",
  });
  const idBytes = createHash("sha256")
    .update(publicKey)
    .digest()
    .subarray(0, 16);
  const id = [...idBytes.toString("hex")]
    .map((n) => String.fromCharCode(97 + parseInt(n, 16)))
    .join("");
  const signedHeader = field(1, idBytes);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signedData = Buffer.concat([
    Buffer.from("CRX3 SignedData\0"),
    length,
    signedHeader,
    zip,
  ]);
  const signature = sign("sha256", signedData, key);
  if (!verify("sha256", signedData, createPublicKey(key), signature)) {
    throw new Error("Desktop extension signature verification failed");
  }
  const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { id, crx: Buffer.concat([prefix, header, zip]) };
}
