# Just-in-Time Onboarding Recipes

## Implemented (Not Yet Wired)

The recipe execution engine is implemented but **not yet invoked from any code path**. The `RecipeExecutor` class (at `ComputerUse/RecipeExecutor.swift`) loads structured markdown recipes, builds a task prompt from the recipe steps, and drives a `ComputerUseSession` to execute the setup end-to-end. It is fully functional but has no call sites — it will be wired into the onboarding flow once the integration picker (see Planned section) is built.

### Available Recipe Files

```
recipes/
├── README.md                    # this file
└── github-app-setup.md          # Register + install GitHub App
```

### How It Works

1. `RecipeExecutor` dynamically loads a recipe markdown file from the app bundle (source files live in `clients/macos/vellum-assistant/Resources/Recipes/`)
2. It parses the structured steps and builds a task prompt with context interpolation (assistant name, target repo, etc.)
3. The prompt is handed to a `ComputerUseSession`, which executes the steps via the standard computer-use pipeline (perceive → infer → verify → execute)
4. Captured credentials are extracted from session output and returned to the caller (secure storage integration is not yet implemented)

The recipe acts as a **pre-written plan** — the model spends almost zero tokens on planning and almost all tokens on perception + action execution.

---

## Planned

The following features are **not yet implemented** and are listed here for roadmap context only.

### Integration Picker (Not Yet Built)

A future onboarding step that would ask:

> **"Where do you spend most of your time?"**
>
> `[ GitHub ]` `[ Gmail ]` `[ Slack ]` `[ Linear ]` `[ Notion ]`

When shipped, this picker would appear as a step in the onboarding flow and trigger the appropriate recipe automatically.

### Planned Orchestration Flow

```
┌─────────────────────────────────────────────────────────┐
│                    ONBOARDING FLOW                       │
│                                                         │
│  Step 1: Wake up + naming        (existing)             │
│  Step 2: Permissions             (existing)             │
│  Step 3: Fn key config           (existing)             │
│  Step 4: ★ Integration picker ★  (NOT YET BUILT)        │
│           │                                             │
│           ├─ User picks "GitHub"                        │
│           │                                             │
│           ├─ "Can I take it from here?"                 │
│           │   └─ [Yes] → ComputerUseSession             │
│           │              with github-app-setup recipe   │
│           │              ↓                              │
│           │         ┌─────────────────────┐             │
│           │         │  RECIPE EXECUTOR    │             │
│           │         │                     │             │
│           │         │  1. Parse recipe    │             │
│           │         │  2. Build task str  │             │
│           │         │  3. Run session     │             │
│           │         │  4. Capture creds   │             │
│           │         │  5. Store securely  │             │
│           │         │  6. Report done     │             │
│           │         └─────────────────────┘             │
│           │                                             │
│  Step 5: Alive check             (existing)             │
│  Step 6: Done                                           │
└─────────────────────────────────────────────────────────┘
```

> **Note:** The `RecipeExecutor` class is implemented (see above), but Step 4 (the integration picker that triggers it) does not exist yet. See `ComputerUse/RecipeExecutor.swift` for the real implementation.

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
3. `RecipeExecutor` dynamically loads recipes by filename from the bundle — no registration step is needed

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

These map directly to the 10 tools available in `ComputerUseSession`:
`click`, `double_click`, `right_click`, `type_text`, `key`, `scroll`,
`wait`, `drag`, `open_app`, `done`.

---

## Security Considerations

- Private keys are captured from browser downloads (secure Keychain
  storage is planned but not yet implemented in `RecipeExecutor`)
- Recipe execution requires explicit user consent ("I'll use your mouse and keyboard")
- `ActionVerifier` safety checks remain active during recipe execution
  (no destructive keys, no sensitive data exposure, loop detection)
- Credentials are never sent to the LLM after capture — they are
  extracted in a post-processing step (secure storage TBD)
