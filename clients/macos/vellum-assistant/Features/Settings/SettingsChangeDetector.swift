import Foundation

/// Snapshots a subset of SettingsStore at a point in time and detects meaningful changes.
struct SettingsSnapshot {
    let model: String
    let hasTelegram: Bool
    let hasTwitter: Bool
    let hasTwilio: Bool
    let hasSlack: Bool
    let hasBraveKey: Bool
    let hasPerplexityKey: Bool
    let hasElevenLabsKey: Bool
    let platformBaseUrl: String

    init(store: SettingsStore) {
        model = store.selectedModel
        hasTelegram = store.telegramConnected
        hasTwitter = store.twitterConnected
        hasTwilio = store.twilioHasCredentials
        hasSlack = store.slackChannelConnected
        hasBraveKey = store.hasBraveKey
        hasPerplexityKey = store.hasPerplexityKey
        hasElevenLabsKey = store.hasElevenLabsKey
        platformBaseUrl = store.platformBaseUrl
    }
}

struct SettingsChange {
    let description: String
    let suggestedPrompt: String
}

struct SettingsChangeDetector {
    static func detect(before: SettingsSnapshot, after: SettingsSnapshot) -> [SettingsChange] {
        var changes: [SettingsChange] = []

        if before.model != after.model {
            let displayName = SettingsStore.modelDisplayNames[after.model] ?? after.model
            changes.append(SettingsChange(
                description: "AI model changed to \(displayName)",
                suggestedPrompt: "What can you help me with using \(displayName)?"
            ))
        }
        if !before.hasTelegram && after.hasTelegram {
            changes.append(SettingsChange(
                description: "Telegram connected",
                suggestedPrompt: "Send me a message on Telegram"
            ))
        }
        if !before.hasTwitter && after.hasTwitter {
            changes.append(SettingsChange(
                description: "Twitter/X connected",
                suggestedPrompt: "Post a tweet saying..."
            ))
        }
        if !before.hasTwilio && after.hasTwilio {
            changes.append(SettingsChange(
                description: "SMS set up",
                suggestedPrompt: "Text me when this task is done"
            ))
        }
        if !before.hasSlack && after.hasSlack {
            changes.append(SettingsChange(
                description: "Slack connected",
                suggestedPrompt: "Send a Slack message to #general"
            ))
        }
        if !before.hasBraveKey && after.hasBraveKey {
            changes.append(SettingsChange(
                description: "Brave Search API key added",
                suggestedPrompt: "Search the web for..."
            ))
        }
        if !before.hasPerplexityKey && after.hasPerplexityKey {
            changes.append(SettingsChange(
                description: "Perplexity API key added",
                suggestedPrompt: "Use Perplexity to research..."
            ))
        }
        if !before.hasElevenLabsKey && after.hasElevenLabsKey {
            changes.append(SettingsChange(
                description: "ElevenLabs API key added",
                suggestedPrompt: "Generate speech saying..."
            ))
        }

        return changes
    }

    static func buildNudgeMessage(changes: [SettingsChange]) -> String {
        guard !changes.isEmpty else { return "" }
        var lines = ["I see you made some changes \u{2728}"]
        for change in changes {
            lines.append("\u{2022} \(change.description) \u{2014} try: \"\(change.suggestedPrompt)\"")
        }
        lines.append("\nFeel free to just ask me!")
        return lines.joined(separator: "\n")
    }
}
