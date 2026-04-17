#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Resolves and renders media embeds (images, videos) for a chat message on iOS.
///
/// Runs the async MediaEmbedResolver when the message text changes
/// (but not during streaming to avoid per-token re-resolution).
/// Settings are read from UserDefaults so embed preferences stay in sync with their
/// writers without requiring a restart.
struct MessageMediaEmbedsView: View {
    let message: ChatMessage

    @State private var intents: [MediaEmbedIntent] = []

    @AppStorage(UserDefaultsKeys.mediaEmbedsEnabled)
    private var mediaEmbedsEnabled: Bool = true

    @AppStorage(UserDefaultsKeys.mediaEmbedVideoAllowlistDomains)
    private var domainsRaw: String = MediaEmbedSettings.defaultDomains.joined(separator: "\n")

    private var resolverSettings: MediaEmbedResolverSettings {
        let domains = domainsRaw
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return MediaEmbedResolverSettings(
            enabled: mediaEmbedsEnabled,
            enabledSince: nil,
            allowedDomains: domains
        )
    }

    /// Re-resolve when message content or settings change.
    private var taskID: String {
        if message.isStreaming { return "streaming-\(message.id)" }
        return "\(message.text.hashValue)-\(mediaEmbedsEnabled)-\(domainsRaw.hashValue)"
    }

    var body: some View {
        if !intents.isEmpty {
            VStack(spacing: VSpacing.sm) {
                ForEach(intents.indices, id: \.self) { idx in
                    switch intents[idx] {
                    case .image(let url):
                        InlineImageEmbedView(url: url)
                    case .video(let provider, let videoID, let embedURL):
                        InlineVideoEmbedView(provider: provider, videoID: videoID, embedURL: embedURL)
                    }
                }
            }
        }

        EmptyView()
            .task(id: taskID) {
                guard !message.isStreaming else { return }
                let resolved = await MediaEmbedResolver.resolve(
                    message: message,
                    settings: resolverSettings
                )
                guard !Task.isCancelled else { return }
                intents = resolved
            }
    }
}
#endif
