import { $ } from "bun";
import { appendFileSync } from "fs";

const packageJson = await Bun.file("assistant/package.json").json();
const version = packageJson.version;
const tag = `v${version}`;

const tagsOutput = await $`git tag -l`.text();
const tags = tagsOutput.trim().split("\n").filter(Boolean);

if (tags.includes(tag)) {
  console.warn(`Tag ${tag} already exists. Skipping release.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "released=false\n");
  }
  process.exit(0);
}

let prevTag = "";
try {
  prevTag = (await $`git describe --tags --abbrev=0`.text()).trim();
} catch {
  // No previous tags exist
}

let releaseNotes: string;
if (prevTag) {
  const range = `${prevTag}..HEAD`;
  releaseNotes = (await $`git log ${range} --oneline`.text()).trim();
} else {
  releaseNotes = (await $`git log --oneline -20`.text()).trim();
}

await $`gh release create ${tag} --title ${tag} --notes ${releaseNotes}`;
console.log(`Release ${tag} created successfully.`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, "released=true\n");
}
