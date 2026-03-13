import SwiftUI
import VellumAssistantShared

/// Card for a video embed that transitions through click-to-play states.
///
/// Shows a thumbnail placeholder with a play button overlay, then builds an
/// embed URL with autoplay parameters via `VideoEmbedURLBuilder` and displays
/// the video inside an `InlineVideoWebView`. The card uses 16:9 aspect ratio.
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

    /// Card height varies by state: expanded for active playback,
    /// medium for the click-to-play placeholder, compact for the
    /// link-only fallback shown after a load failure.
    private var cardHeight: CGFloat {
        switch stateManager.state {
        case .playing, .initializing:
            return 315
        case .placeholder:
            return 315
        case .failed:
            return 60
        }
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase.opacity(0.4), lineWidth: 0.5)
                )

            stateContent
        }
        .frame(maxWidth: .infinity)
        .frame(height: cardHeight)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .animation(.easeInOut(duration: 0.25), value: cardHeight)
        .onDisappear {
            // Only reset states that own an active WKWebView.
            // .placeholder and .failed have no WKWebView; preserve .failed to keep error context.
            switch stateManager.state {
            case .placeholder, .failed:
                break
            default:
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
        case .initializing, .playing:
            activePlayerView
        case .failed(let message):
            failedView(message)
        }
    }

    private var placeholderView: some View {
        ZStack {
            // Video thumbnail background
            if let thumbnailURL = VideoThumbnailURL.thumbnailURL(provider: provider, videoID: videoID) {
                AsyncImage(url: thumbnailURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    case .failure:
                        fallbackPlaceholder
                    case .empty:
                        // Loading state — show dark background
                        VColor.auxBlack
                    @unknown default:
                        fallbackPlaceholder
                    }
                }
            } else {
                fallbackPlaceholder
            }

            // Play button overlay
            Circle()
                .fill(VColor.auxBlack.opacity(0.7))
                .frame(width: 56, height: 56)
                .overlay(
                    VIconView(.play, size: 22)
                        .foregroundColor(VColor.auxWhite)
                        .offset(x: 2)
                )
        }
        .contentShape(Rectangle())
        .onTapGesture {
            stateManager.requestPlay()
        }
    }

    private var fallbackPlaceholder: some View {
        VColor.auxBlack.opacity(0.8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Single view for both .initializing and .playing so SwiftUI preserves
    /// the WKWebView identity across the state transition, avoiding a
    /// redundant teardown-and-reload cycle.
    private var activePlayerView: some View {
        InlineVideoWebView(
            url: playerURL,
            provider: provider,
            onLoadSuccess: { stateManager.didStartPlaying() },
            onLoadFailure: { msg in stateManager.didFail(msg) }
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    /// Link-only fallback shown when the webview fails to load.
    /// Displays the provider name and the original embed URL as a
    /// clickable link that opens in the default browser.
    private func failedView(_ message: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.play, size: 16)
                .foregroundStyle(VColor.contentSecondary)

            Text(provider.capitalized)
                .font(VFont.caption)
                .foregroundStyle(VColor.contentSecondary)

            Text(embedURL.absoluteString)
                .font(VFont.caption)
                .foregroundStyle(VColor.primaryBase)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, VSpacing.md)
        .contentShape(Rectangle())
        .onTapGesture {
            NSWorkspace.shared.open(embedURL)
        }
    }
}

#if DEBUG
#endif
