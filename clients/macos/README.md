# vellum-assistant

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by Claude Haiku 4.5 for action inference via the Anthropic Messages API with tool use.

## Requirements

- macOS 14.0 (Sonoma) or later
- Xcode 15+ (for building)
- Anthropic API key

## Build

```bash
# Resolve dependencies
swift package resolve

# Build
swift build

# Run tests
swift test

# Build for release
swift build -c release
```

## Permissions

The app requires two macOS permissions:
- **Accessibility** — For reading UI element trees and injecting mouse/keyboard events
- **Screen Recording** — For capturing screenshots (vision fallback when AX tree is sparse)

Grant these in System Settings → Privacy & Security.

## Usage

1. Launch the app — it appears as a ✨ sparkles icon in your menu bar
2. Open Settings (click icon → gear) and enter your Anthropic API key
3. Click the menu bar icon or press `⌘⇧G` to open the task input
4. Type a task (e.g., "Fill in the name field with John Smith") and press Go
5. Watch the overlay as vellum-assistant works through the task
6. Press Escape at any time to cancel

## Architecture

```
App/                  Entry point, AppDelegate, menu bar setup, permissions
ComputerUse/          Core perception + action pipeline
  AccessibilityTree   AX element enumeration & formatting
  ActionExecutor      CGEvent mouse/keyboard injection
  ActionVerifier      Safety checks (sensitive data, loops, limits)
  ScreenCapture       ScreenCaptureKit screenshot fallback
  Session             Main orchestration loop
Inference/            AI action selection
  AnthropicProvider   Claude Haiku API integration
  ToolDefinitions     Tool schemas for function calling
UI/                   SwiftUI views + overlay window
Logging/              Session recording to JSON
```

## Safety

- Credit cards, SSNs, and passwords are blocked at the verifier level
- Destructive key combos (Cmd+Q, Cmd+W, Cmd+Delete) require explicit user confirmation
- Form submission (Enter after typing) requires confirmation
- Loop detection aborts stuck agents (3 identical consecutive actions)
- Step limit enforced (default 50, configurable)
- System menu bar (top 25px) is off-limits
- Escape key or Stop button instantly cancels

## Project Structure

```
vellum-assistant/
├── Package.swift                          SPM manifest
├── vellum-assistant/
│   ├── App/
│   │   ├── VellumAssistantApp.swift       @main entry point
│   │   ├── AppDelegate.swift              Menu bar + hotkey + session lifecycle
│   │   ├── APIKeyManager.swift            Keychain storage
│   │   └── PermissionManager.swift        AX + Screen Recording checks
│   ├── ComputerUse/
│   │   ├── ActionTypes.swift              AgentAction, ActionRecord
│   │   ├── AccessibilityTree.swift        AX tree enumeration
│   │   ├── ScreenCapture.swift            Screenshot capture
│   │   ├── ActionExecutor.swift           CGEvent input injection
│   │   ├── ActionVerifier.swift           Safety verification
│   │   └── Session.swift                  Main orchestration loop
│   ├── Inference/
│   │   ├── ActionInferenceProvider.swift   Protocol
│   │   ├── AnthropicProvider.swift        Claude Haiku API
│   │   └── ToolDefinitions.swift          Tool schemas
│   ├── UI/
│   │   ├── TaskInputView.swift            Popover input
│   │   ├── SessionOverlayWindow.swift     Floating NSPanel
│   │   ├── SessionOverlayView.swift       Session status UI
│   │   ├── ConfirmationView.swift         Action confirmation
│   │   ├── SettingsView.swift             API key + preferences
│   │   └── MenuBarController.swift        Reserved
│   ├── Logging/
│   │   ├── SessionLogger.swift            JSON session logs
│   │   └── LogViewer.swift                Log browser UI
│   └── Resources/
│       ├── Info.plist
│       └── Assets.xcassets
└── vellum-assistantTests/
    ├── ActionVerifierTests.swift
    ├── AccessibilityTreeTests.swift
    └── ToolDefinitionsTests.swift
```
