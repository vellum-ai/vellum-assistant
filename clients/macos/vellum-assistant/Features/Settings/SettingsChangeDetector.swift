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
    let pttEnabled: Bool
    let wakeWordEnabled: Bool
    let cmdEnterToSend: Bool

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
        pttEnabled = PTTActivator.fromStored().kind != .none
        wakeWordEnabled = UserDefaults.standard.bool(forKey: "wakeWordEnabled")
        cmdEnterToSend = store.cmdEnterToSend
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
            changes.append(SettingsChange(description: "model switched to \(displayName)"))
        }
        if before.userTimezone != after.userTimezone, let tz = after.userTimezone {
            changes.append(SettingsChange(description: "timezone set to \(tz)"))
        }
        if before.maxSteps != after.maxSteps {
            changes.append(SettingsChange(description: "max steps set to \(Int(after.maxSteps))"))
        }
        if before.mediaEmbedsEnabled != after.mediaEmbedsEnabled {
            changes.append(SettingsChange(description: "media embeds \(after.mediaEmbedsEnabled ? "enabled" : "disabled")"))
        }
        if before.pttEnabled != after.pttEnabled {
            changes.append(SettingsChange(description: "push to talk \(after.pttEnabled ? "enabled" : "disabled")"))
        }
        if before.wakeWordEnabled != after.wakeWordEnabled {
            changes.append(SettingsChange(description: "wake word \(after.wakeWordEnabled ? "enabled" : "disabled")"))
        }
        if before.cmdEnterToSend != after.cmdEnterToSend {
            changes.append(SettingsChange(description: after.cmdEnterToSend ? "send with Cmd+Enter" : "send with Enter"))
        }
        if !before.hasTelegram && after.hasTelegram {
            changes.append(SettingsChange(description: "Telegram connected"))
        }
        if !before.hasTwitter && after.hasTwitter {
            changes.append(SettingsChange(description: "Twitter connected"))
        }
        if !before.hasTwilio && after.hasTwilio {
            changes.append(SettingsChange(description: "Twilio connected"))
        }
        if !before.hasSlack && after.hasSlack {
            changes.append(SettingsChange(description: "Slack connected"))
        }
        if !before.hasBraveKey && after.hasBraveKey {
            changes.append(SettingsChange(description: "Brave search connected"))
        }
        if !before.hasPerplexityKey && after.hasPerplexityKey {
            changes.append(SettingsChange(description: "Perplexity connected"))
        }
        if !before.hasElevenLabsKey && after.hasElevenLabsKey {
            changes.append(SettingsChange(description: "ElevenLabs TTS connected"))
        }
        if !before.hasImageGenKey && after.hasImageGenKey {
            changes.append(SettingsChange(description: "image generation connected"))
        }
        if !before.hasVercelKey && after.hasVercelKey {
            changes.append(SettingsChange(description: "Vercel connected"))
        }

        return changes
    }

    static func buildNudgeMessage(changes: [SettingsChange]) -> String {
        guard !changes.isEmpty else { return "" }
        let bullets = changes.map { "- \($0.description)" }.joined(separator: "\n")
        return "**I noticed you changed some settings:**\n\(bullets)"
    }
}
