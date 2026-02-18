import SwiftUI
import VellumAssistantShared

/// Card for a video embed that transitions through click-to-play states.
///
/// Shows a play-button placeholder, then builds an embed URL with autoplay
/// parameters via `VideoEmbedURLBuilder` and displays the video inside an
/// `InlineVideoWebView`. The card expands to 16:9 aspect ratio when playing.
struct InlineVideoEmbedCard: View {
    let provider: String
    let videoID: String
    let embedURL: URL

    @StateObject private var stateManager = InlineVideoEmbedStateManager()

    /// The embed URL enriched with autoplay/rel query parameters, built on
    /// first play request. Falls back to the raw `embedURL` if the provider
    /// is unrecognised by `VideoEmbedURLBuilder`.
    private var playerURL: URL {
        VideoEmbedURLBuilder.buildEmbedURL(provider: provider, videoID: videoID) ?? embedURL
    }

    private var isExpanded: Bool {
        switch stateManager.state {
        case .playing, .initializing:
            return true
        case .placeholder, .failed:
            return false
        }
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 0.5)
                )

            stateContent
        }
        .frame(maxWidth: .infinity)
        .frame(height: isExpanded ? 315 : 180)
        .animation(.easeInOut(duration: 0.25), value: isExpanded)
        .onDisappear {
            // Tear down active/loading webviews when scrolled offscreen
            // to prevent memory leaks and background audio playback.
            if stateManager.state == .playing || stateManager.state == .initializing {
                stateManager.reset()
            }
        }
    }

    // MARK: - State-driven content

    @ViewBuilder
    private var stateContent: some View {
        switch stateManager.state {
        case .placeholder:
            placeholderView
        case .initializing:
            initializingView
        case .playing:
            playingView
        case .failed(let message):
            failedView(message)
        }
    }

    private var placeholderView: some View {
        VStack(spacing: VSpacing.sm) {
            Image(systemName: "play.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(VColor.textSecondary)

            Text(provider.capitalized)
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            stateManager.requestPlay()
        }
    }

    private var initializingView: some View {
        // The webview loads asynchronously, so we transition straight to
        // .playing and let the embedded player handle its own loading UI.
        InlineVideoWebView(url: playerURL, provider: provider)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .onAppear {
                stateManager.didStartPlaying()
            }
    }

    private var playingView: some View {
        InlineVideoWebView(url: playerURL, provider: provider)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(VColor.textSecondary)

            Text(message)
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
                .multilineTextAlignment(.center)

            Text("Tap to retry")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary.opacity(0.7))
        }
        .contentShape(Rectangle())
        .onTapGesture {
            stateManager.requestPlay()
        }
    }
}

#if DEBUG
#Preview("InlineVideoEmbedCard") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            InlineVideoEmbedCard(
                provider: "youtube",
                videoID: "dQw4w9WgXcQ",
                embedURL: URL(string: "https://www.youtube.com/embed/dQw4w9WgXcQ")!
            )
            InlineVideoEmbedCard(
                provider: "vimeo",
                videoID: "76979871",
                embedURL: URL(string: "https://player.vimeo.com/video/76979871")!
            )
            InlineVideoEmbedCard(
                provider: "loom",
                videoID: "abc123def456",
                embedURL: URL(string: "https://www.loom.com/embed/abc123def456")!
            )
        }
        .padding()
    }
    .frame(width: 400, height: 640)
}
#endif
