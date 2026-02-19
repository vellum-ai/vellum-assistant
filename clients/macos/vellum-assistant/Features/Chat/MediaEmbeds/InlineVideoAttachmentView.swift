import AVKit
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InlineVideoAttachment")

/// Inline video player for file-based video attachments (e.g. video/mp4).
///
/// Decodes base64 attachment data to a temp file and plays it with native
/// AVPlayerView. Uses a click-to-play pattern to avoid auto-playing videos
/// on scroll. Supports lazy-loading large attachments via the daemon HTTP API.
struct InlineVideoAttachmentView: View {
    let attachment: ChatAttachment
    let daemonHttpPort: Int?

    @State private var player: AVPlayer?
    @State private var isPlaying = false
    @State private var isLoading = false
    @State private var failed = false
    @State private var videoAspectRatio: CGFloat
    @State private var isHovering = false
    @State private var isSaving = false
    @State private var thumbnailImage: NSImage?

    init(attachment: ChatAttachment, daemonHttpPort: Int?) {
        self.attachment = attachment
        self.daemonHttpPort = daemonHttpPort

        if let img = attachment.thumbnailImage {
            // Use pixel dimensions for accurate aspect ratio (immune to DPI metadata).
            var w: CGFloat = 0
            var h: CGFloat = 0
            if let rep = img.representations.first {
                w = CGFloat(rep.pixelsWide)
                h = CGFloat(rep.pixelsHigh)
            }
            if w <= 0 || h <= 0 {
                w = img.size.width
                h = img.size.height
            }
            _videoAspectRatio = State(initialValue: w > 0 && h > 0 ? w / h : 3.0 / 4.0)
            _thumbnailImage = State(initialValue: img)
        } else {
            _videoAspectRatio = State(initialValue: 3.0 / 4.0)
        }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 0.5)
                )

            if failed {
                failedView
            } else if isLoading {
                loadingView
            } else if let player, isPlaying {
                VideoPlayerView(player: player)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            } else {
                placeholderView
            }

            if !failed && !isLoading && isHovering {
                Button(action: saveVideo) {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 24))
                            .foregroundStyle(.white)
                            .shadow(radius: 2)
                    }
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
                .disabled(isSaving)
                .accessibilityLabel("Save video")
            }
        }
        .frame(maxWidth: 360)
        .aspectRatio(videoAspectRatio, contentMode: .fit)
        .onHover { isHovering = $0 }
        .onDisappear {
            player?.pause()
            player = nil
            isPlaying = false
        }
    }

    private var placeholderView: some View {
        ZStack {
            if let thumbnailImage {
                Image(nsImage: thumbnailImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }

            VStack(spacing: VSpacing.sm) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(thumbnailImage != nil ? .white : VColor.textSecondary)
                    .shadow(radius: thumbnailImage != nil ? 4 : 0)

                Text(attachment.filename)
                    .font(VFont.caption)
                    .foregroundStyle(thumbnailImage != nil ? .white : VColor.textSecondary)
                    .shadow(radius: thumbnailImage != nil ? 2 : 0)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            prepareAndPlay()
        }
        .task {
            await generateThumbnail()
        }
    }

    private var loadingView: some View {
        VStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.regular)

            Text("Loading video...")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

    /// Builds a safe temp-file URL by stripping path components from the filename
    /// to prevent traversal attacks (e.g. "../../etc/passwd").
    /// Includes attachment.id to avoid collisions between attachments with the same filename.
    private func safeTempURL() -> URL {
        let sanitized = (attachment.filename as NSString).lastPathComponent
        let safeName = sanitized.isEmpty ? "video" : sanitized
        let sanitizedId = (attachment.id as NSString).lastPathComponent
        let uniqueName = sanitizedId.isEmpty ? safeName : "\(sanitizedId)-\(safeName)"
        return FileManager.default.temporaryDirectory.appendingPathComponent(uniqueName)
    }

    private func generateThumbnail() async {
        // Server thumbnail and aspect ratio are set eagerly in init.
        if thumbnailImage != nil { return }

        // Fallback: extract thumbnail from inline video data.
        guard !attachment.data.isEmpty, let data = Data(base64Encoded: attachment.data) else { return }

        let fileURL = safeTempURL()
        do {
            try data.write(to: fileURL)
        } catch {
            return
        }

        let asset = AVAsset(url: fileURL)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 720, height: 720)

        if let cgImage = try? generator.copyCGImage(at: .zero, actualTime: nil) {
            let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))

            let w = CGFloat(cgImage.width)
            let h = CGFloat(cgImage.height)
            if w > 0, h > 0 {
                await MainActor.run {
                    videoAspectRatio = w / h
                    thumbnailImage = nsImage
                }
            } else {
                await MainActor.run {
                    thumbnailImage = nsImage
                }
            }
        }
    }

    /// Check if the temp file from thumbnail generation is already on disk.
    private var cachedFileURL: URL? {
        let url = safeTempURL()
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func prepareAndPlay() {
        // Reuse the temp file written by generateThumbnail() if available.
        if let fileURL = cachedFileURL {
            Task { await playFromFile(fileURL) }
        } else if attachment.isLazyLoad {
            fetchAndPlay()
        } else {
            Task { await playFromBase64(attachment.data) }
        }
    }

    private func playFromFile(_ fileURL: URL) async {
        let asset = AVAsset(url: fileURL)
        if let tracks = try? await asset.load(.tracks),
           let videoTrack = tracks.first(where: { $0.mediaType == .video }),
           let size = try? await videoTrack.load(.naturalSize),
           let transform = try? await videoTrack.load(.preferredTransform),
           size.width > 0, size.height > 0 {
            let transformed = CGRect(origin: .zero, size: size).applying(transform).size
            let w = abs(transformed.width)
            let h = abs(transformed.height)
            if w > 0, h > 0 {
                await MainActor.run { videoAspectRatio = w / h }
            }
        }

        let avPlayer = AVPlayer(url: fileURL)
        await MainActor.run {
            self.player = avPlayer
            self.isPlaying = true
            avPlayer.play()
        }
    }

    private func playFromBase64(_ base64: String) async {
        guard let data = Data(base64Encoded: base64) else {
            await MainActor.run { failed = true }
            return
        }

        let fileURL = safeTempURL()
        do {
            try data.write(to: fileURL)
        } catch {
            await MainActor.run { failed = true }
            return
        }

        await playFromFile(fileURL)
    }

    private func fetchAndPlay() {
        guard let port = daemonHttpPort, let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
            failed = true
            return
        }

        isLoading = true
        Task {
            do {
                let base64 = try await fetchAttachmentData(port: port, attachmentId: attachmentId)
                await MainActor.run { isLoading = false }
                await playFromBase64(base64)
            } catch {
                log.error("Failed to fetch attachment \(attachmentId): \(error.localizedDescription)")
                await MainActor.run {
                    isLoading = false
                    failed = true
                }
            }
        }
    }

    private func saveVideo() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (attachment.filename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destURL = panel.url else { return }

        isSaving = true
        if let sourceURL = cachedFileURL {
            Task.detached {
                try? FileManager.default.copyItem(at: sourceURL, to: destURL)
                await MainActor.run { isSaving = false }
            }
        } else if attachment.isLazyLoad {
            guard let port = daemonHttpPort, let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
                isSaving = false
                return
            }
            Task {
                do {
                    let base64 = try await fetchAttachmentData(port: port, attachmentId: attachmentId)
                    guard let data = Data(base64Encoded: base64) else {
                        await MainActor.run { isSaving = false }
                        return
                    }
                    try data.write(to: destURL)
                    await MainActor.run { isSaving = false }
                } catch {
                    await MainActor.run { isSaving = false }
                }
            }
        } else {
            let base64 = attachment.data
            Task.detached {
                guard let data = Data(base64Encoded: base64) else {
                    await MainActor.run { isSaving = false }
                    return
                }
                try? data.write(to: destURL)
                await MainActor.run { isSaving = false }
            }
        }
    }

    private func openInExternalPlayer() {
        if let fileURL = cachedFileURL {
            NSWorkspace.shared.open(fileURL)
        } else if attachment.isLazyLoad {
            guard let port = daemonHttpPort, let attachmentId = attachment.id.isEmpty ? nil : attachment.id else { return }
            isLoading = true
            Task {
                do {
                    let base64 = try await fetchAttachmentData(port: port, attachmentId: attachmentId)
                    guard let data = Data(base64Encoded: base64) else {
                        await MainActor.run {
                            isLoading = false
                            failed = true
                        }
                        return
                    }
                    let fileURL = safeTempURL()
                    try data.write(to: fileURL)
                    await MainActor.run {
                        isLoading = false
                        NSWorkspace.shared.open(fileURL)
                    }
                } catch {
                    await MainActor.run { isLoading = false }
                }
            }
        } else {
            guard let data = Data(base64Encoded: attachment.data) else { return }
            let fileURL = safeTempURL()
            try? data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        }
    }
}

/// Fetch attachment base64 data from the daemon HTTP endpoint.
private func fetchAttachmentData(port: Int, attachmentId: String) async throws -> String {
    let tokenBase: String
    if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       !baseDir.isEmpty {
        tokenBase = baseDir
    } else {
        tokenBase = NSHomeDirectory()
    }
    let tokenPath = tokenBase + "/.vellum/http-token"
    guard let tokenData = try? Data(contentsOf: URL(fileURLWithPath: tokenPath)),
          let token = String(data: tokenData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !token.isEmpty else {
        throw URLError(.userAuthenticationRequired)
    }
    let url = URL(string: "http://localhost:\(port)/v1/attachments/\(attachmentId)")!
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        throw URLError(.badServerResponse)
    }

    struct AttachmentResponse: Decodable {
        let data: String
    }
    let decoded = try JSONDecoder().decode(AttachmentResponse.self, from: data)
    return decoded.data
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
