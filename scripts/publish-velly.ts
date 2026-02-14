import { $ } from "bun";
import { appendFileSync } from "fs";

async function generateReleaseNotesWithLLM(
  gitLog: string,
  version: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Generate release notes for version v${version} based on these git commits:\n\n${gitLog}\n\nGroup changes into categories:\n- **Features**: new functionality\n- **Fixes**: bug fixes\n- **Infrastructure**: CI, build, tooling changes\n- **Other**: anything else\n\nWrite concise, user-facing descriptions (not raw commit messages). Only include categories that have changes. Return just the release notes markdown, nothing else.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
  };
  return data.content[0].text;
}

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

let gitLog: string;
if (prevTag) {
  const range = `${prevTag}..HEAD`;
  gitLog = (await $`git log ${range} --oneline`.text()).trim();
} else {
  gitLog = (await $`git log --oneline -20`.text()).trim();
}

let releaseNotes: string;
try {
  releaseNotes = await generateReleaseNotesWithLLM(gitLog, version);
  console.log("Generated release notes using LLM.");
} catch (e) {
  console.warn(`LLM release notes generation failed: ${e}. Falling back to git log.`);
  releaseNotes = gitLog;
}

await $`gh release create ${tag} --title ${tag} --notes ${releaseNotes}`;
console.log(`Release ${tag} created successfully.`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, "released=true\n");
}
