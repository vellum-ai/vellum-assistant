import AVKit
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InlineVideoAttachment")

/// How long to poll for daemon port availability before giving up.
private let portWaitTimeout: TimeInterval = 4.0
/// Interval between port availability polls.
private let portPollInterval: UInt64 = 500_000_000 // 0.5s in nanoseconds

/// Classifies playback failures so we can log specific root causes and show
/// slightly more helpful messages to the user.
private enum VideoPlaybackError: String {
    case portMissing = "port_missing"
    case fetchFailed = "fetch_failed"
    case invalidMedia = "invalid_media"

    /// User-facing description shown in the failed-state overlay.
    var userMessage: String {
        switch self {
        case .portMissing:
            return "Could not connect to video service"
        case .fetchFailed:
            return "Could not download video"
        case .invalidMedia:
            return "Could not play video"
        }
    }

    /// Copy shown during the reconnecting/waiting phase, distinct from
    /// the final failure message.
    static let reconnectingMessage = "Reconnecting to video service..."
}

/// Inline video player for file-based video attachments (e.g. video/mp4).
///
/// Decodes base64 attachment data to a temp file and plays it with native
/// AVPlayerView. Uses a click-to-play pattern to avoid auto-playing videos
/// on scroll. Supports lazy-loading large attachments via the daemon HTTP API.
struct InlineVideoAttachmentView: View {
    let attachment: ChatAttachment
    /// Resolves the daemon HTTP port at call time so we always use the
    /// current port even after a daemon reconnect.
    let resolveDaemonPort: () -> Int?

    @State private var player: AVPlayer?
    @State private var isPlaying = false
    @State private var isLoading = false
    @State private var loadingMessage = "Loading video..."
    @State private var failureReason: VideoPlaybackError?
    @State private var videoAspectRatio: CGFloat
    @State private var isHovering = false
    @State private var isSaving = false
    @State private var thumbnailImage: NSImage?
    /// Prevents multiple auto-retries from stacking up.
    @State private var hasAutoRetried = false
    /// Tracks whether we already retried from the failed tile tap so the
    /// next tap falls back to opening in an external player.
    @State private var hasRetriedFromFailedTile = false

    init(attachment: ChatAttachment, resolveDaemonPort: @escaping () -> Int?) {
        self.attachment = attachment
        self.resolveDaemonPort = resolveDaemonPort

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

    private var failed: Bool { failureReason != nil }

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
        .onReceive(NotificationCenter.default.publisher(for: .daemonDidReconnect)) { _ in
            // Auto-retry once on daemon reconnect if the last failure was port_missing.
            guard failureReason == .portMissing, !hasAutoRetried else { return }
            log.info("Daemon reconnected — auto-retrying playback for attachment \(self.attachment.id, privacy: .public)")
            hasAutoRetried = true
            hasRetriedFromFailedTile = false
            failureReason = nil
            prepareAndPlay()
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

            Text(loadingMessage)
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

            Text(failureReason?.userMessage ?? "Could not play video")
                .font(VFont.caption)
                .foregroundStyle(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            retryOrOpenExternal()
        }
    }

    // MARK: - Retry Logic

    /// Tap on failed tile: retry playback first. If the view was already in a
    /// failed state from a previous retry (i.e. this is the second consecutive
    /// tap on a failed tile), open in an external player as a fallback.
    private func retryOrOpenExternal() {
        if hasRetriedFromFailedTile {
            // Second tap on failed tile — fall back to external player.
            openInExternalPlayer()
            return
        }
        hasRetriedFromFailedTile = true
        failureReason = nil
        prepareAndPlay()
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

        let fileURL: URL
        if !attachment.data.isEmpty, let data = Data(base64Encoded: attachment.data) {
            // Inline attachment: decode base64 to temp file.
            let url = safeTempURL()
            do { try data.write(to: url) } catch { return }
            fileURL = url
        } else {
            // For lazy (file-backed) attachments, don't download the full video
            // just for a thumbnail — large recordings (100MB+) cause unnecessary
            // network traffic and memory pressure. The view already shows a
            // play-button placeholder when thumbnailImage is nil.
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
            log.warning("Base64 decode failed for attachment \(self.attachment.id, privacy: .public) — category: \(VideoPlaybackError.invalidMedia.rawValue, privacy: .public)")
            await MainActor.run { failureReason = .invalidMedia }
            return
        }

        let fileURL = safeTempURL()
        do {
            try data.write(to: fileURL)
        } catch {
            log.error("Failed to write decoded video to disk for attachment \(self.attachment.id, privacy: .public): \(error.localizedDescription, privacy: .public) — category: \(VideoPlaybackError.invalidMedia.rawValue, privacy: .public)")
            await MainActor.run { failureReason = .invalidMedia }
            return
        }

        await playFromFile(fileURL)
    }

    private func fetchAndPlay() {
        // If port is nil, show a reconnecting state and poll for a short window
        // before giving up. This handles the brief gap during daemon restart.
        if resolveDaemonPort() == nil {
            log.info("Daemon HTTP port unavailable — waiting for reconnect for attachment \(self.attachment.id, privacy: .public)")
            isLoading = true
            loadingMessage = VideoPlaybackError.reconnectingMessage
            Task {
                let port = await waitForPort()
                guard let port else {
                    log.warning("Daemon HTTP port still unavailable after wait — category: \(VideoPlaybackError.portMissing.rawValue, privacy: .public)")
                    await MainActor.run {
                        isLoading = false
                        loadingMessage = "Loading video..."
                        failureReason = .portMissing
                    }
                    return
                }
                await MainActor.run {
                    loadingMessage = "Loading video..."
                }
                await doFetch(port: port)
            }
            return
        }

        guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
            log.warning("Attachment ID is empty — cannot fetch — category: \(VideoPlaybackError.fetchFailed.rawValue, privacy: .public)")
            failureReason = .fetchFailed
            return
        }

        isLoading = true
        loadingMessage = "Loading video..."
        Task {
            guard let port = resolveDaemonPort() else {
                await MainActor.run {
                    isLoading = false
                    failureReason = .portMissing
                }
                return
            }
            await doFetch(port: port)
        }
    }

    /// Poll `resolveDaemonPort()` at short intervals for up to `portWaitTimeout`.
    private func waitForPort() async -> Int? {
        let deadline = Date().addingTimeInterval(portWaitTimeout)
        while Date() < deadline {
            if let port = resolveDaemonPort() {
                return port
            }
            try? await Task.sleep(nanoseconds: portPollInterval)
        }
        return resolveDaemonPort()
    }

    /// Shared fetch-and-play logic used by fetchAndPlay after port resolution.
    private func doFetch(port: Int) async {
        guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
            log.warning("Attachment ID is empty — cannot fetch — category: \(VideoPlaybackError.fetchFailed.rawValue, privacy: .public)")
            await MainActor.run {
                isLoading = false
                failureReason = .fetchFailed
            }
            return
        }

        do {
            let data = try await fetchAttachmentContent(port: port, attachmentId: attachmentId)
            let fileURL = safeTempURL()
            try data.write(to: fileURL)
            await MainActor.run { isLoading = false }
            await playFromFile(fileURL)
        } catch {
            log.error("Failed to fetch attachment \(attachmentId, privacy: .public): \(error.localizedDescription, privacy: .public) — category: \(VideoPlaybackError.fetchFailed.rawValue, privacy: .public)")
            await MainActor.run {
                isLoading = false
                failureReason = .fetchFailed
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
                do {
                    // Copy to a temp location first, then atomically replace the destination so the
                    // original file is never removed before we have a working replacement in hand.
                    let tempURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent(UUID().uuidString)
                        .appendingPathExtension(destURL.pathExtension)
                    try FileManager.default.copyItem(at: sourceURL, to: tempURL)
                    if FileManager.default.fileExists(atPath: destURL.path) {
                        _ = try FileManager.default.replaceItemAt(destURL, withItemAt: tempURL)
                    } else {
                        try FileManager.default.moveItem(at: tempURL, to: destURL)
                    }
                } catch {
                    log.error("Failed to save video: \(error)")
                }
                await MainActor.run { isSaving = false }
            }
        } else if attachment.isLazyLoad {
            guard let port = resolveDaemonPort() else {
                log.warning("Daemon HTTP port unavailable — cannot save attachment \(self.attachment.id, privacy: .public)")
                isSaving = false
                return
            }
            guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
                isSaving = false
                return
            }
            Task {
                do {
                    let data = try await fetchAttachmentContent(port: port, attachmentId: attachmentId)
                    try data.write(to: destURL)
                    await MainActor.run { isSaving = false }
                } catch {
                    log.error("Failed to save attachment \(attachmentId, privacy: .public) via fetch: \(error.localizedDescription, privacy: .public)")
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
            guard let port = resolveDaemonPort() else {
                log.warning("Daemon HTTP port unavailable — cannot open attachment \(self.attachment.id, privacy: .public) in external player")
                return
            }
            guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else { return }
            isLoading = true
            Task {
                do {
                    let data = try await fetchAttachmentContent(port: port, attachmentId: attachmentId)
                    let fileURL = safeTempURL()
                    try data.write(to: fileURL)
                    await MainActor.run {
                        isLoading = false
                        NSWorkspace.shared.open(fileURL)
                    }
                } catch {
                    log.error("Failed to fetch attachment \(attachmentId, privacy: .public) for external player: \(error.localizedDescription, privacy: .public)")
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

/// Fetch raw attachment bytes from the daemon HTTP content endpoint.
private func fetchAttachmentContent(port: Int, attachmentId: String) async throws -> Data {
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
    let url = URL(string: "http://localhost:\(port)/v1/attachments/\(attachmentId)/content")!
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        throw URLError(.badServerResponse)
    }

    return data
}

/// NSViewRepresentable wrapper for AVPlayerView.
private struct VideoPlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .floating
        view.showsFullScreenToggleButton = true
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        nsView.player = player
    }
}
