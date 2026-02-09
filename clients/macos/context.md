## Current Objective
Implement a passive ambient screen-watching agent that uses a three-tier cost funnel (local OCR diff → Haiku analysis → Sonnet session) to proactively offer help.

## Progress Summary
- All 5 new files created and compiling: `ScreenOCR.swift`, `KnowledgeStore.swift`, `AmbientAnalyzer.swift`, `AmbientAgent.swift`, `AmbientSuggestionWindow.swift`
- All existing files modified: `AppDelegate.swift` (lifecycle + menu), `SettingsView.swift` (ambient section), `VellumAssistantApp.swift` (pass agent), `Package.swift` (Vision framework), `project.pbxproj` (new files added)
- Fixed menu bar icon not updating (voice input callback was overriding, state changes now call `updateMenuBarIcon()` via didSet)
- Fixed Haiku model ID: was `claude-haiku-4-5-20250929` (404), corrected to `claude-haiku-4-5-20251001`

## Active Work
- Model ID fix just applied, needs runtime verification
- `AddInstanceForFactory` warning is a benign macOS system log noise from audio/Core Audio — not actionable

## Technical Context
- **Stack/Dependencies**: Swift 5.9, macOS 14+, SPM + XcodeGen, Vision framework (OCR), Anthropic Messages API (Haiku for analysis, Sonnet for sessions)
- **Architecture Decisions**: Three-tier cost funnel; `@MainActor ObservableObject` for AmbientAgent; Jaccard word-set similarity for OCR diff (>0.85 = skip); `didSet` on `state` property notifies AppDelegate to update icon; `NSPanel` with `.nonactivatingPanel` for suggestions
- **Constraints**: Must use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for SPM builds; `Bundle.main.bundleIdentifier` is nil in SPM builds (hardcoded fallback); new files must be added to both SPM (automatic) and `project.pbxproj` (manual)

## Next Steps
1. Runtime-verify the Haiku API call succeeds with corrected model ID
2. Verify knowledge.json is created and populated after a few ambient cycles
3. Verify suggestion window appears when Haiku returns `suggest`
4. Verify ambient agent pauses during manual sessions and resumes after
5. Consider adding ambient cycle stats to the Settings view (cycle count, last analysis time)

## Important Files
```
vellum-assistant/Ambient/AmbientAgent.swift - Watch loop orchestrator, @MainActor ObservableObject, owns all ambient components
vellum-assistant/Ambient/AmbientAnalyzer.swift - Haiku API integration, model ID: claude-haiku-4-5-20251001
vellum-assistant/Ambient/ScreenOCR.swift - VNRecognizeTextRequest wrapper + Jaccard similarity
vellum-assistant/Ambient/KnowledgeStore.swift - JSON persistence at ~/Library/Application Support/vellum-assistant/knowledge.json
vellum-assistant/UI/AmbientSuggestionWindow.swift - Floating NSPanel for suggestions, 30s auto-dismiss
vellum-assistant/App/AppDelegate.swift - Wiring: setupAmbientAgent(), updateMenuBarIcon(), pause/resume around sessions
vellum-assistant/UI/SettingsView.swift - Ambient Agent section with toggle, interval slider, knowledge count, clear button
vellum-assistant/App/VellumAssistantApp.swift - Passes ambientAgent to SettingsView
Package.swift - Added .linkedFramework("Vision")
vellum-assistant.xcodeproj/project.pbxproj - Added 5 new files (Ambient group + AmbientSuggestionWindow in UI)
```

## Open Questions/Blockers
- None currently blocking; runtime verification needed for the model ID fix
