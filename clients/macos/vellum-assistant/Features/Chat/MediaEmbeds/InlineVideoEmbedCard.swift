import SwiftUI
import VellumAssistantShared

/// Card for a video embed that transitions through click-to-play states.
///
/// Shows a play-button placeholder, a loading spinner while initializing,
/// a "playing" label once active, or an error with retry. Actual WebView
/// playback will be wired in a later PR.
struct InlineVideoEmbedCard: View {
    let provider: String
    let videoID: String
    let embedURL: URL

    @StateObject private var stateManager = InlineVideoEmbedStateManager()

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
        .frame(height: 180)
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
        ProgressView()
            .controlSize(.large)
    }

    private var playingView: some View {
        // Placeholder for the future WebView player mount point
        Text("Playing")
            .font(VFont.caption)
            .foregroundStyle(VColor.textSecondary)
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
