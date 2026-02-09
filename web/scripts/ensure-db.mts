import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is not set");
  process.exit(1);
}

const url = new URL(databaseUrl);
const targetDb = url.pathname.replace("/", "");

url.pathname = "/postgres";
const adminUrl = url.toString();

console.log(`Ensuring database "${targetDb}" exists...`);

const sql = postgres(adminUrl, { max: 1 });

try {
  const result = await sql`SELECT 1 FROM pg_database WHERE datname = ${targetDb}`;
  if (result.length === 0) {
    console.log(`Database "${targetDb}" does not exist. Creating...`);
    await sql.unsafe(`CREATE DATABASE "${targetDb}"`);
    console.log(`Database "${targetDb}" created successfully.`);
  } else {
    console.log(`Database "${targetDb}" already exists.`);
  }
} finally {
  await sql.end();
}
