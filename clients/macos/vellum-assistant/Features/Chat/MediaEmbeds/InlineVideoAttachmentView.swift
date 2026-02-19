import AVKit
import SwiftUI
import VellumAssistantShared

/// Inline video player for file-based video attachments (e.g. video/mp4).
///
/// Decodes base64 attachment data to a temp file and plays it with native
/// AVPlayerView. Uses a click-to-play pattern to avoid auto-playing videos
/// on scroll.
struct InlineVideoAttachmentView: View {
    let attachment: ChatAttachment

    @State private var player: AVPlayer?
    @State private var isPlaying = false
    @State private var failed = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 0.5)
                )

            if failed {
                failedView
            } else if let player, isPlaying {
                VideoPlayerView(player: player)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            } else {
                placeholderView
            }
        }
        .frame(maxWidth: 360)
        .aspectRatio(3.0 / 4.0, contentMode: .fit)
        .onDisappear {
            player?.pause()
            player = nil
            isPlaying = false
        }
    }

    private var placeholderView: some View {
        VStack(spacing: VSpacing.sm) {
            Image(systemName: "play.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(VColor.textSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            prepareAndPlay()
        }
    }

    private var failedView: some View {
        VStack(spacing: VSpacing.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 20))
                .foregroundStyle(VColor.textSecondary)

            Text("Could not play video")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            openInExternalPlayer()
        }
    }

    private func prepareAndPlay() {
        guard let data = Data(base64Encoded: attachment.data) else {
            failed = true
            return
        }

        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent(attachment.filename)
        do {
            try data.write(to: fileURL)
        } catch {
            failed = true
            return
        }

        let avPlayer = AVPlayer(url: fileURL)
        self.player = avPlayer
        self.isPlaying = true
        avPlayer.play()
    }

    private func openInExternalPlayer() {
        guard let data = Data(base64Encoded: attachment.data) else { return }
        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent(attachment.filename)
        try? data.write(to: fileURL)
        NSWorkspace.shared.open(fileURL)
    }
}

/// NSViewRepresentable wrapper for AVPlayerView.
private struct VideoPlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        nsView.player = player
    }
}
