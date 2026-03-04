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
    let prompt: String
}

struct SettingsChangeDetector {
    @MainActor static func detect(before: SettingsSnapshot, after: SettingsSnapshot) -> [SettingsChange] {
        var changes: [SettingsChange] = []

        if before.model != after.model {
            let displayName = SettingsStore.modelDisplayNames[after.model] ?? after.model
            changes.append(SettingsChange(prompt: "switch to \(displayName)"))
        }
        if before.userTimezone != after.userTimezone, let tz = after.userTimezone {
            changes.append(SettingsChange(prompt: "set my timezone to \(tz)"))
        }
        if before.maxSteps != after.maxSteps {
            changes.append(SettingsChange(prompt: "set max steps to \(Int(after.maxSteps))"))
        }
        if !before.mediaEmbedsEnabled && after.mediaEmbedsEnabled {
            changes.append(SettingsChange(prompt: "enable media embeds"))
        }
        if !before.hasTelegram && after.hasTelegram {
            changes.append(SettingsChange(prompt: "send me a message on Telegram"))
        }
        if !before.hasTwitter && after.hasTwitter {
            changes.append(SettingsChange(prompt: "post a tweet for me"))
        }
        if !before.hasTwilio && after.hasTwilio {
            changes.append(SettingsChange(prompt: "text me when this is done"))
        }
        if !before.hasSlack && after.hasSlack {
            changes.append(SettingsChange(prompt: "send a Slack message"))
        }
        if !before.hasBraveKey && after.hasBraveKey {
            changes.append(SettingsChange(prompt: "search the web for..."))
        }
        if !before.hasPerplexityKey && after.hasPerplexityKey {
            changes.append(SettingsChange(prompt: "research ... with Perplexity"))
        }
        if !before.hasElevenLabsKey && after.hasElevenLabsKey {
            changes.append(SettingsChange(prompt: "generate speech saying..."))
        }
        if !before.hasImageGenKey && after.hasImageGenKey {
            changes.append(SettingsChange(prompt: "generate an image of..."))
        }
        if !before.hasVercelKey && after.hasVercelKey {
            changes.append(SettingsChange(prompt: "deploy my project to Vercel"))
        }

        return changes
    }

    static func buildNudgeMessage(changes: [SettingsChange]) -> String {
        guard !changes.isEmpty else { return "" }
        let combined = changes.map(\.prompt).joined(separator: ", ")
        return "**I noticed you made some changes to settings**\nYou could just ask: \"\(combined)\" — no need to open Settings!"
    }
}
