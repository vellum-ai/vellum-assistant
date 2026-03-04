import Foundation

/// Snapshots integration/connection flags at a point in time.
/// Only tracks settings where the assistant can genuinely act via chat.
struct SettingsSnapshot {
    let hasTelegram: Bool
    let hasTwitter: Bool
    let hasTwilio: Bool
    let hasSlack: Bool
    let hasBraveKey: Bool
    let hasPerplexityKey: Bool
    let hasElevenLabsKey: Bool
    let hasImageGenKey: Bool
    let hasVercelKey: Bool

    @MainActor init(store: SettingsStore) {
        hasTelegram = store.telegramConnected
        hasTwitter = store.twitterConnected
        hasTwilio = store.twilioHasCredentials
        hasSlack = store.slackChannelConnected
        hasBraveKey = store.hasBraveKey
        hasPerplexityKey = store.hasPerplexityKey
        hasElevenLabsKey = store.hasElevenLabsKey
        hasImageGenKey = store.hasImageGenKey
        hasVercelKey = store.hasVercelKey
    }
}

struct SettingsChange {
    let prompt: String
}

struct SettingsChangeDetector {
    @MainActor static func detect(before: SettingsSnapshot, after: SettingsSnapshot) -> [SettingsChange] {
        var changes: [SettingsChange] = []

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
        let bullets = changes.map { "- \($0.prompt)" }.joined(separator: "\n")
        return "**I noticed you made some changes to settings**\nInstead you can ask just right here:\n\(bullets)"
    }
}
