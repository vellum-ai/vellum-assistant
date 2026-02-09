# Just-in-Time Onboarding Recipes

## The Vision

During onboarding, the assistant asks a single question:

> **"Where do you spend most of your time?"**
>
> `[ GitHub ]` `[ Gmail ]` `[ Slack ]` `[ Linear ]` `[ Notion ]`

When the user picks one (say, **GitHub**), the assistant responds:

> "Let me get **{assistant-name}** set up on GitHub.
> Can I take it from here?"
>
> `[ Yes — I'll use your mouse and keyboard ]` `[ Back ]`

If yes: the computer-use agent takes over, follows the recipe, and hands control
back when done. The whole thing takes ~60 seconds. The user watches their
assistant set itself up in real-time.

---

## How It Works

### 1. Recipe Files

Each integration has a recipe in this directory:

```
recipes/
├── README.md                    # this file
├── github-app-setup.md          # Register + install GitHub App
├── gmail-oauth-setup.md         # (future) Google OAuth consent
├── slack-app-setup.md           # (future) Slack App + Bot Token
├── linear-oauth-setup.md        # (future) Linear API key
└── notion-integration-setup.md  # (future) Notion integration
```

Recipes are **structured markdown** with:
- Prerequisites (what must be true)
- Steps (atomic computer-use actions with LOCATE/ACTION/WAIT/VERIFY/CAPTURE)
- Error recovery tables
- Credential output schemas

### 2. Orchestration Flow

```
┌─────────────────────────────────────────────────────────┐
│                    ONBOARDING FLOW                       │
│                                                         │
│  Step 1: Wake up + naming        (existing)             │
│  Step 2: Permissions             (existing)             │
│  Step 3: Fn key config           (existing)             │
│  Step 4: ★ Integration picker ★  (NEW)                  │
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

### 3. Recipe Executor (New Component)

The Recipe Executor sits between the onboarding flow and `ComputerUseSession`:

```swift
// Conceptual — RecipeExecutor.swift
@MainActor
final class RecipeExecutor {

    /// Load a recipe from the recipes directory
    func loadRecipe(_ name: String) -> Recipe { ... }

    /// Convert recipe steps into a ComputerUseSession task prompt
    func buildTaskPrompt(recipe: Recipe, context: OnboardingContext) -> String {
        // Interpolate {assistant-name}, {target-repo}, etc.
        // Include the full step sequence so the model knows what to do
        // Include error recovery guidance
    }

    /// Execute the recipe via computer use
    func execute(recipe: Recipe, context: OnboardingContext) async -> RecipeResult {
        let task = buildTaskPrompt(recipe: recipe, context: context)
        let session = ComputerUseSession(task: task, provider: provider)
        await session.run()
        // Parse captured credentials from session output
        return RecipeResult(credentials: ..., success: ...)
    }
}
```

### 4. Why This Is Fast

The recipe is a **pre-written plan**. Instead of the model figuring out what to do
from scratch ("set up a GitHub App"), it gets a step-by-step playbook with:

- Exact URLs to navigate to
- Exact field names to look for
- Exact values to type
- Exact verification checks

This means the model spends almost zero tokens on planning and almost all tokens
on perception + action execution. Expected: **~15-25 steps, ~60 seconds**.

### 5. Why Recipes Beat Documentation

| Approach | User effort | Time | Error rate |
|----------|------------|------|------------|
| Send docs link, user does it | High | 10-30 min | High |
| Walk through step by step (chat) | Medium | 5-15 min | Medium |
| **Recipe (computer use)** | **Zero** | **~60 sec** | **Low** |

The user literally watches their assistant set itself up. That's the onboarding
moment that makes people go "oh, this is different."

---

## Extending: Adding a New Recipe

1. Create `recipes/{service}-setup.md`
2. Follow the structure in `github-app-setup.md`
3. Add the service to the integration picker in `OnboardingFlowView`
4. Register the recipe name in `RecipeExecutor`

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

- Private keys are captured from browser downloads and stored in the
  assistant's secure credential store (Keychain on macOS)
- Recipe execution requires explicit user consent ("I'll use your mouse and keyboard")
- `ActionVerifier` safety checks remain active during recipe execution
  (no destructive keys, no sensitive data exposure, loop detection)
- Credentials are never sent to the LLM after capture — they go directly
  to secure storage via a post-processing step
