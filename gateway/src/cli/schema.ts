import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSchema } from "../schema.js";

const filePath = join(tmpdir(), `vellum-gateway-schema-${Date.now()}.json`);
writeFileSync(filePath, JSON.stringify(buildSchema(), null, 2) + "\n");
console.log(filePath);
