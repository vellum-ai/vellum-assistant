# Just-in-Time Onboarding Recipes

## Status: Not Yet Wired

The recipe execution engine (`RecipeExecutor`) has been removed as part of the migration
to proxy-based computer use. The recipe markdown files and DSL spec remain for future
use — a new executor will be built on top of the `host_cu_request` / `host_cu_result`
proxy flow when the integration picker (see Planned section) is built.

### Available Recipe Files

```
recipes/
├── README.md                    # this file
└── github-app-setup.md          # Register + install GitHub App
```

---

## Planned

The following features are **not yet implemented** and are listed here for roadmap context only.

### Integration Picker (Not Yet Built)

A future onboarding step that would ask:

> **"Where do you spend most of your time?"**
>
> `[ GitHub ]` `[ Gmail ]` `[ Slack ]` `[ Linear ]` `[ Notion ]`

When shipped, this picker would appear as a step in the onboarding flow and trigger the appropriate recipe automatically.

### Future Recipe Files (Not Yet Created)

These recipe files do not exist yet:

- `gmail-oauth-setup.md` — Google OAuth consent
- `slack-app-setup.md` — Slack App + Bot Token
- `linear-oauth-setup.md` — Linear API key
- `notion-integration-setup.md` — Notion integration

### Performance Targets

| Approach | User effort | Time | Error rate |
|----------|------------|------|------------|
| Send docs link, user does it | High | 10-30 min | High |
| Walk through step by step (chat) | Medium | 5-15 min | Medium |
| **Recipe (computer use)** | **Zero** | **~60 sec target** | **Low target** |

---

## Extending: Adding a New Recipe

1. Create `{service}-setup.md` in `clients/macos/vellum-assistant/Resources/Recipes/` (the app bundle resource directory)
2. Follow the structure in `github-app-setup.md`

### Recipe Step DSL

Each step should use these primitives:

```
STEP {n}: {description}
  LOCATE: {what to find in AX tree or on screen}
  ACTION: {click|type_text|key|scroll|open_app|wait|drag}({args})
  WAIT:   {condition to wait for}
  VERIFY: {assertion — what should be true after this step}
  CAPTURE: {value to extract and store}
  NOTE:   {guidance for the model — edge cases, fallbacks}
```

These map to the computer use tools executed via `HostCuExecutor`:
`click`, `double_click`, `right_click`, `type_text`, `key`, `scroll`,
`wait`, `drag`, `open_app`, `done`.

---

## Security Considerations

- Recipe execution requires explicit user consent ("I'll use your mouse and keyboard")
- `ActionVerifier` safety checks remain active during recipe execution
  (no destructive keys, no sensitive data exposure, loop detection)
- Credentials are never sent to the LLM after capture — they are
  extracted in a post-processing step (secure storage TBD)
