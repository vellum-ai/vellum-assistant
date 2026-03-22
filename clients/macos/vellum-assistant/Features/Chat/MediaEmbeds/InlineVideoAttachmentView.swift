import AVKit
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InlineVideoAttachment")

// MARK: - Failure State Buckets

/// Deterministic failure categories for video playback.
/// Each bucket has a clear UI treatment and recovery path.
enum VideoPlaybackFailure: Equatable {
    /// Daemon not connected or HTTP port not available.
    /// Recovery: retry when daemon reconnects (auto) or on user tap (manual).
    case port_missing

    /// HTTP request to daemon failed (network error, 4xx/5xx).
    /// Recovery: retry on user tap.
    case fetch_failed(String)

    /// Content fetched but not playable (corrupt file, wrong format, bad base64).
    /// Recovery: open in external player as fallback.
    case invalid_media

    var userMessage: String {
        switch self {
        case .port_missing:
            return "Reconnecting to assistant..."
        case .fetch_failed(let detail):
            return detail.isEmpty ? "Could not fetch video" : detail
        case .invalid_media:
            return "Could not play video"
        }
    }

    /// Whether this failure is eligible for automatic retry on daemon reconnect.
    var isRetryableOnReconnect: Bool {
        if case .port_missing = self { return true }
        return false
    }
}

// MARK: - View

/// Inline video player for file-based video attachments (e.g. video/mp4).
///
/// Decodes base64 attachment data to a temp file and plays it with native
/// AVPlayerView. Uses a click-to-play pattern to avoid auto-playing videos
/// on scroll. Supports lazy-loading large attachments via the daemon HTTP API.
///
/// Fetches lazy-load attachments via the gateway's runtime proxy. On transient
/// connection errors (e.g. gateway mid-restart), retries up to 3 times with
/// 1s delays before showing the error state. Non-transient errors (4xx/5xx,
/// auth) fail immediately. Listens for `daemonDidReconnect` to auto-retry
/// `port_missing` failures.
struct InlineVideoAttachmentView: View {
    let attachment: ChatAttachment

    @State private var player: AVPlayer?
    @State private var isPlaying = false
    @State private var isLoading = false
    @State private var failure: VideoPlaybackFailure?
    @State private var videoAspectRatio: CGFloat
    @State private var isHovering = false
    @State private var isSaving = false
    @State private var thumbnailImage: NSImage?
    /// Tracks whether a user-initiated retry has already failed, so the next
    /// tap on the failed tile opens the external player instead of retrying again.
    @State private var hasRetriedOnce = false

    init(attachment: ChatAttachment) {
        self.attachment = attachment

        if let img = attachment.thumbnailImage {
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
                .fill(VColor.surfaceOverlay)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase.opacity(0.4), lineWidth: 0.5)
                )

            if let failure {
                failedView(failure)
            } else if isLoading {
                loadingView
            } else if let player, isPlaying {
                VideoPlayerView(player: player)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            } else {
                placeholderView
            }

            if failure == nil && !isLoading && isHovering {
                Button(action: saveVideo) {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        VIconView(.arrowDownToLine, size: 24)
                            .foregroundStyle(VColor.auxWhite)
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
            // Auto-retry playback when daemon reconnects and the current failure
            // is port_missing (the most common transient failure).
            guard let failure, failure.isRetryableOnReconnect else { return }
            self.failure = nil
            hasRetriedOnce = false
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
                VIconView(.play, size: 44)
                    .foregroundStyle(thumbnailImage != nil ? VColor.auxWhite : VColor.contentSecondary)
                    .shadow(radius: thumbnailImage != nil ? 4 : 0)

                Text(attachment.filename)
                    .font(VFont.caption)
                    .foregroundStyle(thumbnailImage != nil ? VColor.auxWhite : VColor.contentSecondary)
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
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failedView(_ failure: VideoPlaybackFailure) -> some View {
        VStack(spacing: VSpacing.xs) {
            if case .port_missing = failure {
                VIconView(.refreshCw, size: 20)
                    .foregroundStyle(VColor.contentSecondary)
            } else {
                VIconView(.triangleAlert, size: 20)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Text(failure.userMessage)
                .font(VFont.caption)
                .foregroundStyle(VColor.contentSecondary)

            if case .port_missing = failure {
                Text("Tap to retry")
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            } else if case .invalid_media = failure {
                Text("Tap to open externally")
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                Text(hasRetriedOnce ? "Tap to open externally" : "Tap to retry")
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            handleFailedTileTap(failure)
        }
    }

    // MARK: - Failure Tap Handling

    /// Failed tile tap retries playback first; external-open is a fallback
    /// only after retry fails or for non-retryable failures.
    private func handleFailedTileTap(_ failure: VideoPlaybackFailure) {
        switch failure {
        case .port_missing:
            // Always retry for port_missing — daemon may have reconnected.
            self.failure = nil
            hasRetriedOnce = false
            prepareAndPlay()

        case .fetch_failed:
            if hasRetriedOnce {
                // Second tap: fall back to external player.
                openInExternalPlayer()
            } else {
                // First tap: retry playback.
                self.failure = nil
                hasRetriedOnce = true
                prepareAndPlay()
            }

        case .invalid_media:
            // Media is fundamentally broken; skip retry, open externally.
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

    /// Returns a file URL for the local file path if set and the file exists on disk.
    private var localFileURL: URL? {
        guard let path = attachment.filePath, !path.isEmpty else { return nil }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func generateThumbnail() async {
        // Server thumbnail and aspect ratio are set eagerly in init.
        if thumbnailImage != nil { return }

        let fileURL: URL
        if let localURL = localFileURL {
            // Local file-backed attachment (e.g. recording): generate thumbnail
            // directly from the on-disk file — no download or base64 decode needed.
            fileURL = localURL
        } else if !attachment.data.isEmpty, let data = Data(base64Encoded: attachment.data) {
            // Inline attachment: decode base64 to temp file.
            let url = safeTempURL()
            do { try data.write(to: url) } catch { return }
            fileURL = url
        } else {
            // For lazy (file-backed) attachments without a local path, don't
            // download the full video just for a thumbnail — large recordings
            // (100MB+) cause unnecessary network traffic and memory pressure.
            // The view already shows a play-button placeholder when thumbnailImage is nil.
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
        // Prefer the local file path (recordings on the same Mac).
        if let localURL = localFileURL {
            Task { await playFromFile(localURL) }
        } else if let fileURL = cachedFileURL {
            // Reuse the temp file written by generateThumbnail() if available.
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

        // Verify the file is actually playable before handing it to AVPlayer.
        let isPlayable = (try? await asset.load(.isPlayable)) ?? false
        guard isPlayable else {
            await MainActor.run { failure = .invalid_media }
            return
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
            await MainActor.run { failure = .invalid_media }
            return
        }

        let fileURL = safeTempURL()
        do {
            try data.write(to: fileURL)
        } catch {
            await MainActor.run { failure = .invalid_media }
            return
        }

        await playFromFile(fileURL)
    }

    /// Fetch attachment content via the gateway's runtime proxy with retry logic.
    ///
    /// Retries up to 3 times with 1s delays for transient connection errors
    /// (e.g. cannotConnectToHost, networkConnectionLost, timedOut) that can
    /// occur when the gateway or daemon is mid-restart. Non-transient errors
    /// (4xx/5xx, auth failures) break immediately without retry.
    private func fetchAndPlay() {
        guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
            failure = .invalid_media
            return
        }

        isLoading = true
        Task {
            let gatewayBaseUrl = resolveGatewayBaseUrl()
            let maxRetries = 3
            var lastError: VideoPlaybackFailure?

            for attempt in 0..<maxRetries {
                if attempt > 0 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s between retries
                }

                do {
                    let data = try await fetchAttachmentContent(gatewayBaseUrl: gatewayBaseUrl, attachmentId: attachmentId)
                    let fileURL = safeTempURL()
                    try data.write(to: fileURL)
                    await MainActor.run { isLoading = false }
                    await playFromFile(fileURL)
                    return
                } catch let urlError as URLError where isTransientConnectionError(urlError) {
                    log.error("Fetch attempt \(attempt + 1)/\(maxRetries) failed (transient) for \(attachmentId): \(urlError.localizedDescription)")
                    lastError = .fetch_failed(urlError.localizedDescription)
                    continue
                } catch {
                    log.error("Fetch attempt \(attempt + 1)/\(maxRetries) failed for \(attachmentId): \(error.localizedDescription)")
                    lastError = .fetch_failed(error.localizedDescription)
                    break
                }
            }

            await MainActor.run {
                isLoading = false
                failure = lastError ?? .fetch_failed("Could not fetch video")
            }
        }
    }

    /// Whether a URLError represents a transient connection-level failure
    /// worth retrying (e.g. gateway/daemon mid-restart).
    private func isTransientConnectionError(_ error: URLError) -> Bool {
        switch error.code {
        case .cannotConnectToHost,
             .networkConnectionLost,
             .timedOut,
             .cannotFindHost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .secureConnectionFailed:
            return true
        default:
            return false
        }
    }

    private func saveVideo() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (attachment.filename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        // Use begin() instead of runModal() — runModal() fails on macOS Tahoe
        // with "failed to connect to the open and save panel service".
        let sourceURL = localFileURL ?? cachedFileURL
        let isLazy = attachment.isLazyLoad
        let attachmentId = attachment.id.isEmpty ? nil : attachment.id
        let gatewayBaseUrl = isLazy ? resolveGatewayBaseUrl() : ""
        let base64 = attachment.data
        panel.begin { response in
            guard response == .OK, let destURL = panel.url else { return }
            self.isSaving = true
            if let sourceURL {
                Task.detached {
                    var succeeded = false
                    do {
                        let tempURL = FileManager.default.temporaryDirectory
                            .appendingPathComponent(UUID().uuidString)
                            .appendingPathExtension(destURL.pathExtension)
                        try FileManager.default.copyItem(at: sourceURL, to: tempURL)
                        if FileManager.default.fileExists(atPath: destURL.path) {
                            _ = try FileManager.default.replaceItemAt(destURL, withItemAt: tempURL)
                        } else {
                            try FileManager.default.moveItem(at: tempURL, to: destURL)
                        }
                        succeeded = true
                    } catch {
                        log.error("Failed to save video: \(error)")
                    }
                    let didSucceed = succeeded
                    await MainActor.run {
                        self.isSaving = false
                        if didSucceed { Self.showSaveSuccessToast(destURL) }
                    }
                }
            } else if isLazy, let attachmentId {
                Task {
                    do {
                        let data = try await fetchAttachmentContent(gatewayBaseUrl: gatewayBaseUrl, attachmentId: attachmentId)
                        try data.write(to: destURL)
                        await MainActor.run {
                            self.isSaving = false
                            Self.showSaveSuccessToast(destURL)
                        }
                    } catch {
                        await MainActor.run { self.isSaving = false }
                    }
                }
            } else if isLazy {
                // Lazy-load attachment with no valid ID — cannot save
                self.isSaving = false
                return
            } else {
                Task.detached {
                    guard let data = Data(base64Encoded: base64) else {
                        await MainActor.run { self.isSaving = false }
                        return
                    }
                    do {
                        try data.write(to: destURL)
                        await MainActor.run {
                            self.isSaving = false
                            Self.showSaveSuccessToast(destURL)
                        }
                    } catch {
                        log.error("Failed to save video: \(error)")
                        await MainActor.run { self.isSaving = false }
                    }
                }
            }
        }
    }

    @MainActor
    private static func showSaveSuccessToast(_ url: URL) {
        AppDelegate.shared?.mainWindow?.windowState.showToast(
            message: "Saved to \(url.lastPathComponent)",
            style: .success
        )
    }

    private func openInExternalPlayer() {
        if let fileURL = localFileURL ?? cachedFileURL {
            NSWorkspace.shared.open(fileURL)
        } else if attachment.isLazyLoad {
            guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else { return }
            let gatewayBaseUrl = resolveGatewayBaseUrl()
            isLoading = true
            Task {
                do {
                    let data = try await fetchAttachmentContent(gatewayBaseUrl: gatewayBaseUrl, attachmentId: attachmentId)
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

/// Resolve the local gateway base URL: env var > lockfile > default 7830.
private func resolveGatewayBaseUrl() -> String {
    let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
    return "http://127.0.0.1:\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
}

/// Fetch raw attachment bytes via the gateway's runtime proxy.
private func fetchAttachmentContent(gatewayBaseUrl: String, attachmentId: String) async throws -> Data {
    guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
        throw URLError(.userAuthenticationRequired)
    }
    let url = URL(string: "\(gatewayBaseUrl)/v1/attachments/\(attachmentId)/content")!
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        log.error("Attachment fetch failed with HTTP \(statusCode) for \(attachmentId)")
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
