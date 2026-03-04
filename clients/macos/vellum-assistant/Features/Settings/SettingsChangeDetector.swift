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
    let hasImageGenKey: Bool
    let hasVercelKey: Bool
    let userTimezone: String?
    let maxSteps: Double
    let mediaEmbedsEnabled: Bool

    @MainActor init(store: SettingsStore) {
        model = store.selectedModel
        hasTelegram = store.telegramConnected
        hasTwitter = store.twitterConnected
        hasTwilio = store.twilioHasCredentials
        hasSlack = store.slackChannelConnected
        hasBraveKey = store.hasBraveKey
        hasPerplexityKey = store.hasPerplexityKey
        hasElevenLabsKey = store.hasElevenLabsKey
        hasImageGenKey = store.hasImageGenKey
        hasVercelKey = store.hasVercelKey
        userTimezone = store.userTimezone
        maxSteps = store.maxSteps
        mediaEmbedsEnabled = store.mediaEmbedsEnabled
    }
}

struct SettingsChange {
    let description: String
}

struct SettingsChangeDetector {
    @MainActor static func detect(before: SettingsSnapshot, after: SettingsSnapshot) -> [SettingsChange] {
        var changes: [SettingsChange] = []

        if before.model != after.model {
            let displayName = SettingsStore.modelDisplayNames[after.model] ?? after.model
            changes.append(SettingsChange(description: "Model → \(displayName)"))
        }
        if before.userTimezone != after.userTimezone, let tz = after.userTimezone {
            changes.append(SettingsChange(description: "Timezone → \(tz)"))
        }
        if before.maxSteps != after.maxSteps {
            changes.append(SettingsChange(description: "Max steps → \(Int(after.maxSteps))"))
        }
        if !before.mediaEmbedsEnabled && after.mediaEmbedsEnabled {
            changes.append(SettingsChange(description: "Media embeds enabled"))
        }
        if !before.hasTelegram && after.hasTelegram {
            changes.append(SettingsChange(description: "Telegram connected"))
        }
        if !before.hasTwitter && after.hasTwitter {
            changes.append(SettingsChange(description: "Twitter/X connected"))
        }
        if !before.hasTwilio && after.hasTwilio {
            changes.append(SettingsChange(description: "SMS set up"))
        }
        if !before.hasSlack && after.hasSlack {
            changes.append(SettingsChange(description: "Slack connected"))
        }
        if !before.hasBraveKey && after.hasBraveKey {
            changes.append(SettingsChange(description: "Brave Search key added"))
        }
        if !before.hasPerplexityKey && after.hasPerplexityKey {
            changes.append(SettingsChange(description: "Perplexity key added"))
        }
        if !before.hasElevenLabsKey && after.hasElevenLabsKey {
            changes.append(SettingsChange(description: "ElevenLabs key added"))
        }
        if !before.hasImageGenKey && after.hasImageGenKey {
            changes.append(SettingsChange(description: "Image generation key added"))
        }
        if !before.hasVercelKey && after.hasVercelKey {
            changes.append(SettingsChange(description: "Vercel key added"))
        }

        return changes
    }

    static func buildNudgeMessage(changes: [SettingsChange]) -> String {
        guard !changes.isEmpty else { return "" }
        var lines = ["**I noticed you made some changes to settings**"]
        for change in changes {
            lines.append("\u{2022} \(change.description)")
        }
        lines.append("\nYou don't need to open Settings — just ask me directly next time!")
        return lines.joined(separator: "\n")
    }
}
