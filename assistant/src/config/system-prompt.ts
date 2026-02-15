import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspaceDir, getWorkspacePromptPath } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { loadSkillCatalog, type SkillSummary } from './skills.js';

const log = getLogger('system-prompt');

const PROMPT_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;

/**
 * Copy template prompt files into the data directory if they don't already exist.
 * Called once during daemon startup so users always have discoverable files to edit.
 */
export function ensurePromptFiles(): void {
  const templatesDir = join(import.meta.dirname ?? __dirname, 'templates');

  for (const file of PROMPT_FILES) {
    const dest = getWorkspacePromptPath(file);
    if (existsSync(dest)) continue;

    const src = join(templatesDir, file);
    try {
      if (!existsSync(src)) {
        log.warn({ src }, 'Prompt template not found, skipping');
        continue;
      }
      copyFileSync(src, dest);
      log.info({ file, dest }, 'Created prompt file from template');
    } catch (err) {
      log.warn({ err, file }, 'Failed to create prompt file from template');
    }
  }
}

/**
 * Build the system prompt from ~/.vellum prompt files,
 * then append a generated skills catalog (if any skills are available).
 *
 * Composition:
 *   1. Base prompt: IDENTITY.md + SOUL.md (guaranteed to exist after ensurePromptFiles)
 *   2. Append USER.md (user profile)
 *   3. Append skills catalog from ~/.vellum/skills
 */
export function buildSystemPrompt(): string {
  const soulPath = getWorkspacePromptPath('SOUL.md');
  const identityPath = getWorkspacePromptPath('IDENTITY.md');
  const userPath = getWorkspacePromptPath('USER.md');

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);
  const user = readPromptFile(userPath);

  const parts: string[] = [];
  if (identity) parts.push(identity);
  if (soul) parts.push(soul);
  if (user) parts.push(user);
  parts.push(buildConfigSection(getWorkspaceDir()));
  parts.push(buildAttachmentSection());
  parts.push(buildDynamicUiSection());
  parts.push(buildSwarmGuidanceSection());

  return appendSkillsCatalog(parts.join('\n\n'));
}

function buildAttachmentSection(): string {
  return [
    '## Sending Files and Images',
    '',
    'To attach a file or image to your reply, include a self-closing XML tag in your response text:',
    '',
    '```',
    '<vellum-attachment source="sandbox" path="output/chart.png" />',
    '```',
    '',
    '- `source`: `sandbox` (default, files inside the sandbox working directory) or `host` (absolute paths on the host filesystem — requires user approval).',
    '- `path`: Required. Relative path for sandbox, absolute path for host.',
    '- `filename`: Optional override for the delivered filename (defaults to the basename of the path).',
    '- `mime_type`: Optional MIME type override (inferred from the file extension if omitted).',
    '',
    'Limits: up to 5 attachments per turn, 20 MB each. Tool outputs that produce image or file content blocks are also automatically converted into attachments.',
  ].join('\n');
}

function buildDynamicUiSection(): string {
  return [
    '## Dynamic UI',
    '',
    '### When to use',
    'Use dynamic UI when the response involves structured data, visual metrics, comparisons, multi-item results, charts, weather, flights, financial data, dashboards, or anything better presented visually than as plain text. Do NOT use for simple text answers, short factual replies, or casual conversation.',
    '',
    '**Important:** Dynamic UI only works in interactive UI sessions (e.g. the macOS desktop app). Non-UI channels such as HTTP API, Telegram, and gateway integrations cannot render dynamic pages or cards. When responding through a non-UI channel, present data as well-formatted text instead.',
    '',
    '### Routing rules',
    '- **Tool auto-emissions** (e.g. `get_weather`): handled automatically — do nothing extra',
    '- **Predefined domain data** (flights, stocks): `ui_show` with `surface_type: "dynamic_page"` and domain component classes',
    '- **Simple structured data** (key-value, table, list): `ui_show` with `card`/`table`/`list`/`form` surface_type',
    '- **Fully custom UIs from scratch**: `app_create` (App Builder) — this is the DEFAULT for any dynamic HTML/CSS/JS output',
    '',
    '### Using app_create (default for custom UIs)',
    'When the user asks you to build, create, or visualize something that requires custom HTML, use `app_create`:',
    '- Provide `name`, `schema_json` (use `"{}"` for display-only apps), `html`, and `preview`',
    '- `auto_open` defaults to true — the app opens immediately after creation',
    '- Always include `preview`: `{ title, icon (emoji), metrics: [{ label, value }] }` for an inline chat card',
    '- For iteration on an existing app: use `app_update` to change the HTML, then `app_open` to reopen it',
    '- For complex apps: call `skill_load` with `id: "app-builder"` for the full design reference',
    '',
    '### Quality standards',
    '- Build immediately — make creative decisions, deliver polished output',
    '- Anti-AI-slop rules: no flat cards with zero depth, no zero animations, 3+ text hierarchy levels, no plain backgrounds, hover+active states required on interactive elements',
    '- Always: tight letter-spacing on headings, `clamp()` for display text, at least one accent gradient, distinct visual personality',
    '- Toast notifications for all CRUD operations, `window.vellum.confirm()` for destructive actions',
    '',
    '### Using ui_show with domain components',
    'For predefined domain data (flights, weather, stocks), write a self-contained HTML string using the domain component classes. The CSS design system (`vellum-design-system.css`) and JS widget library (`vellum-widgets.js`) are auto-injected. Call `ui_show` with `surface_type: "dynamic_page"` and `data: { html: "<your html>", preview: { title, subtitle?, description?, icon?, metrics? } }`.',
    '',
    '### Design system tokens',
    'Semantic colors: `--v-bg`, `--v-surface`, `--v-surface-border`, `--v-text`, `--v-text-secondary`, `--v-text-muted`, `--v-accent`, `--v-success`, `--v-danger`, `--v-warning`.',
    'Palettes: `--v-slate-{950..50}`, `--v-violet-*`, `--v-emerald-*`, `--v-rose-*`, `--v-amber-*`, `--v-indigo-*`.',
    'Spacing: `--v-spacing-xs` through `--v-spacing-xxxl`. Radius: `--v-radius-sm`/`md`/`lg`/`pill`.',
    '',
    '### Component classes',
    'Layout: `.v-card`, `.v-card-grid`, `.v-metric-card`, `.v-metric-grid`, `.v-data-table`, `.v-stat-row`, `.v-tabs`, `.v-accordion`, `.v-timeline`, `.v-divider`, `.v-page`, `.v-hero`, `.v-section-header`, `.v-pullquote`, `.v-comparison`, `.v-feature-grid`, `.v-feature-card`, `.v-gradient-text`, `.v-animate-in`.',
    'Domain: `.v-flight-card`, `.v-weather-card`, `.v-stock-ticker`, `.v-billing-chart`, `.v-itinerary`, `.v-boarding-pass`, `.v-receipt`, `.v-invoice`.',
    'UI: `.v-button` (`.secondary`/`.danger`/`.ghost`), `.v-badge`, `.v-status-badge` (`.success`/`.error`/`.warning`), `.v-progress-bar`, `.v-search-bar`, `.v-empty-state`, `.v-action-list`.',
    '',
    '### Widget JS APIs',
    '```',
    'vellum.widgets.sparkline(container, number[], {width, height, color})',
    'vellum.widgets.barChart(container, [{label, value, color?}], {width, height, horizontal?})',
    'vellum.widgets.lineChart(container, [{label, value}], {width, height, showDots?, showGrid?})',
    'vellum.widgets.progressRing(container, value0to100, {size, color, label?})',
    'vellum.widgets.sortTable(tableId)  — make .v-data-table sortable',
    'vellum.widgets.tabs(tabsId)        — wire .v-tabs click behavior',
    'vellum.openExternal(url)           — open URL in default browser',
    'vellum.sendAction(actionId, data)  — send interaction back to assistant',
    '```',
    '',
    '### Example — Flight results page (ui_show with domain components)',
    '```html',
    '<div style="max-width:500px;margin:0 auto;display:flex;flex-direction:column;gap:12px">',
    '  <h2 style="color:var(--v-text);margin:0">Flights: IAH → LGA</h2>',
    '  <div class="v-flight-card">',
    '    <div class="v-flight-header">',
    '      <span class="v-flight-airline">Spirit</span>',
    '      <span class="v-flight-price">$120</span>',
    '    </div>',
    '    <div class="v-flight-route">',
    '      <div class="v-flight-endpoint"><div class="v-flight-time">6:38 PM</div><div class="v-flight-code">IAH</div></div>',
    '      <div class="v-flight-duration"><span>3h 28m</span><div class="v-flight-line"></div><span>Nonstop</span></div>',
    '      <div class="v-flight-endpoint"><div class="v-flight-time">11:06 PM</div><div class="v-flight-code">LGA</div></div>',
    '    </div>',
    '  </div>',
    '</div>',
    '```',
    '',
    '### Tool chaining',
    'After gathering data via tools (web search, browser, `get_weather`, APIs), synthesize results into a visual output rather than displaying raw tool outputs.',
    '- **Weather**: `get_weather` automatically renders a dynamic page with a compact preview card. Do NOT call `ui_show` or `app_create` after `get_weather` — the weather surface is emitted directly. Just respond with a brief natural-language summary.',
    '- **Research → Render**: When using browser/web search to research something visual (flights, hotels, products, comparisons), gather the data first, then compose it into a polished output — use `app_create` for custom UIs, or `ui_show` with domain component classes for predefined data types.',
  ].join('\n');
}

export function buildSwarmGuidanceSection(): string {
  return [
    '## Parallel Task Orchestration',
    '',
    'Use `swarm_delegate` only when a task has **multiple independent parts** that benefit from parallel execution (e.g. "research X, implement Y, and review Z"). For single-focus tasks, work directly — do not decompose them into a swarm.',
  ].join('\n');
}

function buildConfigSection(configDir: string): string {
  return [
    '## Configuration',
    `Your configuration directory is \`${configDir}/\`. Key files you may read or edit:`,
    '',
    '- `IDENTITY.md` — Your name and role. Slim metadata — rarely changes.',
    '- `SOUL.md` — Core principles, personality, and evolution guidance. Your behavioral foundation.',
    '- `USER.md` — Profile of the user. Update as you learn about them over time.',
    '- `skills/` — Directory of installed skills (loaded automatically at startup).',
  ].join('\n');
}

/**
 * Strip lines starting with `_` (comment convention for prompt .md files)
 * and collapse any resulting consecutive blank lines.
 *
 * Lines inside fenced code blocks (``` or ~~~ delimiters per CommonMark)
 * are never stripped, so code examples with `_`-prefixed identifiers are preserved.
 */
export function stripCommentLines(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  let openFenceChar: string | null = null;
  const filtered = normalized.split('\n').filter((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!openFenceChar) {
        openFenceChar = char;
      } else if (char === openFenceChar) {
        openFenceChar = null;
      }
    }
    if (openFenceChar) return true;
    return !line.trimStart().startsWith('_');
  });
  return filtered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readPromptFile(path: string): string | null {
  if (!existsSync(path)) return null;

  try {
    const content = stripCommentLines(readFileSync(path, 'utf-8'));
    if (content.length === 0) return null;
    log.debug({ path }, 'Loaded prompt file');
    return content;
  } catch (err) {
    log.warn({ err, path }, 'Failed to read prompt file');
    return null;
  }
}

function appendSkillsCatalog(basePrompt: string): string {
  const skills = loadSkillCatalog();

  const sections: string[] = [basePrompt];

  const catalog = formatSkillsCatalog(skills);
  if (catalog) sections.push(catalog);

  sections.push(buildDynamicSkillWorkflowSection());

  return sections.join('\n\n');
}

function buildDynamicSkillWorkflowSection(): string {
  return [
    '## Dynamic Skill Authoring Workflow',
    '',
    'When the user requests a capability that no existing tool or skill can satisfy, follow this exact procedure:',
    '',
    '1. **Validate the gap.** Confirm no existing tool or installed skill covers the need.',
    '2. **Draft a TypeScript snippet.** Write a self-contained snippet that exports a `default` or `run` function with signature `(input: unknown) => unknown | Promise<unknown>`.',
    '3. **Test with `evaluate_typescript_code`.** Call the tool to run the snippet in a sandbox. Iterate until it passes.',
    '4. **Persist with `scaffold_managed_skill`.** Only after successful evaluation and explicit user consent, call `scaffold_managed_skill` to write the skill to `~/.vellum/skills/<id>/`.',
    '5. **Load and use.** Call `skill_load` with the new skill ID before invoking the skill-driven flow.',
    '',
    'Important constraints:',
    '- **Never persist or delete skills without explicit user confirmation.** Both operations require user approval.',
    '- If evaluation fails after 3 attempts, summarize the failure and ask the user for guidance instead of continuing to retry.',
    '- After a skill is written or deleted, the next turn may run in a recreated session due to file-watcher eviction. Continue normally.',
    '- To remove a managed skill, use `delete_managed_skill`.',
  ].join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  // Filter out skills with disableModelInvocation
  const visible = skills.filter(s => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = ['<available_skills>'];
  for (const skill of visible) {
    const idAttr = escapeXml(skill.id);
    const nameAttr = escapeXml(skill.name);
    const descAttr = escapeXml(skill.description);
    const locAttr = escapeXml(skill.directoryPath);
    lines.push(`<skill id="${idAttr}" name="${nameAttr}" description="${descAttr}" location="${locAttr}" />`);
  }
  lines.push('</available_skills>');

  return [
    '## Available Skills',
    'The following skills are available. Before executing one, call the `skill_load` tool with its `id` to load the full instructions.',
    '',
    lines.join('\n'),
  ].join('\n');
}
