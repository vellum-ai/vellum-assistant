import SwiftUI
import VellumAssistantShared

/// Static placeholder card for a video embed intent.
///
/// Shows a play icon and provider badge on a themed card background.
/// No actual playback — that will be wired in a later PR once the
/// WebView-based player is ready.
struct InlineVideoEmbedCard: View {
    let provider: String
    let videoID: String
    let embedURL: URL

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 0.5)
                )

            VStack(spacing: VSpacing.sm) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(VColor.textSecondary)

                Text(provider.capitalized)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 180)
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
