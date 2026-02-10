# Recipe: GitHub App Setup

> High-level outline for setting up GitHub integration using GitHub Desktop.
> The computer-use agent should follow these steps flexibly, adapting to
> what it sees on screen rather than following rigid click sequences.

## Prerequisites

- GitHub Desktop is installed (if not, open App Store or download from desktop.github.com)
- User is signed into their GitHub account in GitHub Desktop
- macOS Accessibility + Screen Recording permissions are granted (handled by prior onboarding steps)

---

## Recipe Steps

### Phase 1: Open GitHub Desktop

```
STEP 1: Launch GitHub Desktop
  Open the GitHub Desktop application.
  If it's not installed, open Safari and navigate to desktop.github.com to download it.
  Wait for the app to finish launching and show its main window.
```

### Phase 2: Sign In (if needed)

```
STEP 2: Ensure User is Signed In
  Check if GitHub Desktop shows a signed-in state (shows repositories or "Clone a Repository" option).
  If not signed in, click "Sign in to GitHub.com" and wait for the user to complete authentication.
  Once signed in, verify the user's GitHub username is visible in the app.
```

### Phase 3: Clone a Repository

```
STEP 3: Clone the Target Repository
  Use the "Clone a Repository" option (File menu or welcome screen).
  Search for or select {target-repo} from the user's available repositories.
  Choose a local path for the clone and confirm.
  Wait for the clone to complete.
```

### Phase 4: Verify Setup

```
STEP 4: Verify Repository Access
  Confirm the cloned repository appears in GitHub Desktop's repository list.
  Verify the current branch is visible and the repository status shows correctly.
  Open the repository in Finder to confirm files are present on disk.
```

### Phase 5: Report Completion

```
STEP 5: Report Success
  DONE: "{assistant-name} is now set up with GitHub Desktop.
         The repository {target-repo} has been cloned and is ready.
         I can help you manage branches, commits, and pull requests."
```

---

## Error Recovery

| Scenario | Recovery |
|----------|----------|
| GitHub Desktop not installed | Navigate to desktop.github.com in Safari, download and install it |
| Not signed in | Click sign-in button, wait for user to authenticate in browser |
| Repository not found | Ask user to confirm the repository name, check spelling |
| Clone fails (permissions) | Check if user has access to the repository, suggest requesting access |
| Clone fails (disk space) | Notify user about disk space issue |
| App not responding | Wait a few seconds, try clicking the app in the Dock |

## Credentials Output

```json
{
  "github_username": "(from GitHub Desktop profile)",
  "cloned_repo": "{target-repo}",
  "local_path": "(path where repo was cloned)"
}
```
