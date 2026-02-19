#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Resolves and renders media embeds (images, videos) for a chat message on iOS.
///
/// Runs the async MediaEmbedResolver when the message text changes
/// (but not during streaming to avoid per-token re-resolution).
struct MessageMediaEmbedsView: View {
    let message: ChatMessage

    @State private var intents: [MediaEmbedIntent] = []

    /// Default settings: embeds always enabled, all major video domains allowed.
    private static let defaultSettings = MediaEmbedResolverSettings(
        enabled: true,
        enabledSince: nil,
        allowedDomains: [
            "youtube.com", "youtu.be",
            "vimeo.com",
            "loom.com",
        ]
    )

    private var taskID: String {
        if message.isStreaming { return "streaming-\(message.id)" }
        return "\(message.text.hashValue)"
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
                    settings: Self.defaultSettings
                )
                guard !Task.isCancelled else { return }
                intents = resolved
            }
    }
}
#endif
