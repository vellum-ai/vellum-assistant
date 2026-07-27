import AppIntents

/// Publishes the voice intents to every system surface that consumes App
/// Shortcuts: Siri, Spotlight, the Shortcuts app gallery, and the Action Button
/// picker in Settings.
///
/// Declaring the provider is the whole of the work — none of those surfaces has
/// an API of its own. The Action Button in particular offers any `AppShortcut`
/// under Settings → Action Button → Shortcut → the app's name, so a shortcut
/// listed here is bindable to it with no further code.
///
/// Every phrase must interpolate `\(.applicationName)`. App Intents drops the
/// ones that omit it, and the drop is silent at runtime — the shortcut still
/// appears in the Shortcuts app while Siri never matches a word of it. The
/// token resolves to `CFBundleDisplayName`, which each environment's xcconfig
/// sets via `BUNDLE_DISPLAY_NAME`: "Vellum", "Vellum Staging", "Vellum Dev".
/// All three are pronounceable, so one phrase list serves every build.
///
/// Localized phrases go in `Intents/<locale>.lproj/AppShortcuts.strings` — the
/// filename App Intents looks for — keyed by the English literals below, with
/// the token spelled `${applicationName}`. There is no `en.lproj`: App Intents
/// falls back to these literals, so an English table would be identity mappings
/// that only add a second place to keep the phrases in sync.
struct VoiceAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartVoiceModeIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Start voice mode in \(.applicationName)",
                "Voice mode in \(.applicationName)",
            ],
            shortTitle: "Voice mode",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: StartNewVoiceConversationIntent(),
            phrases: [
                "New voice conversation in \(.applicationName)",
                "Start a new voice chat in \(.applicationName)",
            ],
            shortTitle: "New voice conversation",
            systemImageName: "waveform.badge.plus"
        )
        // These phrases end at the app name rather than trailing into the
        // question. App Shortcut phrases can interpolate a parameter only when
        // its type is an `AppEnum` or `AppEntity`, and `AskVellumIntent.request`
        // is free-form text — so Siri matches the phrase and then collects the
        // question through the parameter's `requestValueDialog`.
        AppShortcut(
            intent: AskVellumIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Ask \(.applicationName) something",
            ],
            shortTitle: "Ask a question",
            systemImageName: "questionmark.bubble"
        )
    }
}
