import AVFoundation
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InlineAudioAttachment")

// MARK: - Failure State Buckets

/// Deterministic failure categories for audio playback.
/// Each bucket has a clear UI treatment and recovery path.
enum AudioPlaybackFailure: Equatable {
    /// Daemon not connected or HTTP port not available.
    /// Recovery: retry when daemon reconnects (auto) or on user tap (manual).
    case port_missing

    /// HTTP request to daemon failed (network error, 4xx/5xx).
    /// Recovery: retry on user tap.
    case fetch_failed(String)

    /// Content fetched but not playable (corrupt file, wrong format, bad base64).
    /// Recovery: none — show error message.
    case invalid_media

    var userMessage: String {
        switch self {
        case .port_missing:
            return "Reconnecting to assistant..."
        case .fetch_failed(let detail):
            return detail.isEmpty ? "Could not fetch audio" : detail
        case .invalid_media:
            return "Could not play audio"
        }
    }

    /// Whether this failure is eligible for automatic retry on daemon reconnect.
    var isRetryableOnReconnect: Bool {
        if case .port_missing = self { return true }
        return false
    }
}

// MARK: - View

/// Inline audio player for file-based audio attachments (e.g. audio/mpeg, audio/wav).
///
/// Renders as a compact horizontal bar with play/pause, filename, progress bar,
/// and elapsed/total time. Uses AVAudioPlayer for playback. Supports local files,
/// cached temp files, lazy-loaded gateway fetch, and base64-decoded data.
///
/// Fetches lazy-load attachments via the gateway's runtime proxy. On transient
/// connection errors (e.g. gateway mid-restart), retries up to 3 times with
/// 1s delays before showing the error state. Listens for `daemonDidReconnect`
/// to auto-retry `port_missing` failures.
struct InlineAudioAttachmentView: View {
    let attachment: ChatAttachment

    @State private var audioPlayer: AVAudioPlayer?
    @State private var isPlaying = false
    @State private var isLoading = false
    @State private var failure: AudioPlaybackFailure?
    @State private var progress: Double = 0
    @State private var duration: TimeInterval = 0
    @State private var hasRetriedOnce = false
    @State private var isSaving = false
    @State private var isHovering = false

    /// Coordinator object that acts as AVAudioPlayerDelegate to detect playback
    /// completion and relay it back to the SwiftUI state.
    @State private var coordinator: AudioPlayerCoordinator?

    /// Timer publisher for updating progress during playback.
    private let timer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            // Play/pause button
            playPauseButton

            // Center: filename + progress bar
            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.filename)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if let failure {
                    Text(failure.userMessage)
                        .font(VFont.small)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                } else {
                    progressBar
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Right: time display or save button
            if isHovering && failure == nil {
                Button(action: saveAudio) {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        VIconView(.arrowDownToLine, size: 14)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isSaving)
                .accessibilityLabel("Save audio")
            } else {
                timeDisplay
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.surfaceOverlay)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(VColor.borderBase.opacity(0.4), lineWidth: 0.5)
                )
        )
        .frame(maxWidth: 360)
        .onHover { isHovering = $0 }
        .onReceive(timer) { _ in
            guard isPlaying, let player = audioPlayer else { return }
            progress = player.currentTime
            duration = player.duration
        }
        .onDisappear {
            stop()
        }
        .onReceive(NotificationCenter.default.publisher(for: .daemonDidReconnect)) { _ in
            guard let failure, failure.isRetryableOnReconnect else { return }
            self.failure = nil
            hasRetriedOnce = false
            prepareAndPlay()
        }
    }

    // MARK: - Subviews

    private var playPauseButton: some View {
        Button(action: {
            if let failure {
                handleFailedTap(failure)
            } else {
                togglePlayPause()
            }
        }) {
            Group {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else if failure != nil {
                    VIconView(.triangleAlert, size: 18)
                        .foregroundStyle(VColor.contentSecondary)
                } else if isPlaying {
                    VIconView(.square, size: 18)
                        .foregroundStyle(VColor.contentDefault)
                } else {
                    VIconView(.circlePlay, size: 18)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
            .frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                // Track
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(VColor.borderBase.opacity(0.5))
                    .frame(height: 3)

                // Filled portion
                if duration > 0 {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(VColor.systemPositiveStrong)
                        .frame(width: max(0, geo.size.width * CGFloat(progress / duration)), height: 3)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { location in
                guard duration > 0, let player = audioPlayer else { return }
                let fraction = max(0, min(1, location.x / geo.size.width))
                let seekTime = fraction * duration
                player.currentTime = seekTime
                progress = seekTime
            }
        }
        .frame(height: 3)
    }

    private var timeDisplay: some View {
        Group {
            if duration > 0 || isPlaying {
                Text("\(formatTime(progress)) / \(formatTime(duration))")
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            } else if attachment.dataLength > 0 {
                Text(formattedFileSize(base64Length: attachment.dataLength))
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            } else if let sizeBytes = attachment.sizeBytes {
                Text(formattedFileSize(bytes: sizeBytes))
                    .font(VFont.small)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .monospacedDigit()
    }

    // MARK: - Playback Control

    private func togglePlayPause() {
        if isPlaying {
            audioPlayer?.pause()
            isPlaying = false
        } else if let player = audioPlayer {
            player.play()
            isPlaying = true
        } else {
            prepareAndPlay()
        }
    }

    private func stop() {
        audioPlayer?.stop()
        audioPlayer = nil
        coordinator = nil
        isPlaying = false
        progress = 0
    }

    // MARK: - Failure Tap Handling

    private func handleFailedTap(_ failure: AudioPlaybackFailure) {
        switch failure {
        case .port_missing:
            self.failure = nil
            hasRetriedOnce = false
            prepareAndPlay()

        case .fetch_failed:
            if hasRetriedOnce {
                // Second tap: no external player fallback for audio, just retry again
                self.failure = nil
                prepareAndPlay()
            } else {
                self.failure = nil
                hasRetriedOnce = true
                prepareAndPlay()
            }

        case .invalid_media:
            // Nothing useful to do — media is fundamentally broken
            break
        }
    }

    // MARK: - File Resolution & Playback

    /// Builds a safe temp-file URL by stripping path components from the filename
    /// to prevent traversal attacks (e.g. "../../etc/passwd").
    /// Includes attachment.id to avoid collisions between attachments with the same filename.
    private func safeTempURL() -> URL {
        let sanitized = (attachment.filename as NSString).lastPathComponent
        let safeName = sanitized.isEmpty ? "audio" : sanitized
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

    /// Check if the temp file is already on disk.
    private var cachedFileURL: URL? {
        let url = safeTempURL()
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func prepareAndPlay() {
        if let localURL = localFileURL {
            playFromFile(localURL)
        } else if let fileURL = cachedFileURL {
            playFromFile(fileURL)
        } else if attachment.isLazyLoad {
            fetchAndPlay()
        } else {
            playFromBase64(attachment.data)
        }
    }

    private func playFromFile(_ fileURL: URL) {
        do {
            let player = try AVAudioPlayer(contentsOf: fileURL)
            let coord = AudioPlayerCoordinator { [self] in
                self.isPlaying = false
                self.progress = 0
            }
            player.delegate = coord
            self.coordinator = coord
            self.audioPlayer = player
            self.duration = player.duration
            self.progress = 0
            player.play()
            self.isPlaying = true
        } catch {
            log.error("Failed to create AVAudioPlayer: \(error.localizedDescription)")
            failure = .invalid_media
        }
    }

    private func playFromBase64(_ base64: String) {
        guard let data = Data(base64Encoded: base64) else {
            failure = .invalid_media
            return
        }

        let fileURL = safeTempURL()
        do {
            try data.write(to: fileURL)
        } catch {
            failure = .invalid_media
            return
        }

        playFromFile(fileURL)
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
            let gatewayBaseUrl = resolveAudioGatewayBaseUrl()
            let maxRetries = 3
            var lastError: AudioPlaybackFailure?

            for attempt in 0..<maxRetries {
                if attempt > 0 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s between retries
                }

                do {
                    let data = try await fetchAudioAttachmentContent(gatewayBaseUrl: gatewayBaseUrl, attachmentId: attachmentId)
                    let fileURL = safeTempURL()
                    try data.write(to: fileURL)
                    await MainActor.run {
                        isLoading = false
                        playFromFile(fileURL)
                    }
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
                failure = lastError ?? .fetch_failed("Could not fetch audio")
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

    // MARK: - Save

    private func saveAudio() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (attachment.filename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destURL = panel.url else { return }

        isSaving = true
        if let sourceURL = localFileURL ?? cachedFileURL {
            Task.detached {
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
                } catch {
                    log.error("Failed to save audio: \(error)")
                }
                await MainActor.run { isSaving = false }
            }
        } else if attachment.isLazyLoad {
            guard let attachmentId = attachment.id.isEmpty ? nil : attachment.id else {
                isSaving = false
                return
            }
            let gatewayBaseUrl = resolveAudioGatewayBaseUrl()
            Task {
                do {
                    let data = try await fetchAudioAttachmentContent(gatewayBaseUrl: gatewayBaseUrl, attachmentId: attachmentId)
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

    // MARK: - Formatting Helpers

    /// Formats a time interval as "M:SS" for durations under an hour,
    /// "H:MM:SS" for longer durations.
    private func formatTime(_ seconds: TimeInterval) -> String {
        let totalSeconds = Int(max(0, seconds))
        let h = totalSeconds / 3600
        let m = (totalSeconds % 3600) / 60
        let s = totalSeconds % 60

        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        } else {
            return String(format: "%d:%02d", m, s)
        }
    }

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        return formattedFileSize(bytes: bytes)
    }

    private func formattedFileSize(bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }
}

// MARK: - AVAudioPlayer Delegate Coordinator

/// Coordinator that bridges AVAudioPlayerDelegate callbacks to SwiftUI state.
/// AVAudioPlayer requires an NSObject-based delegate; this coordinator relays
/// the `audioPlayerDidFinishPlaying` callback via a closure.
private final class AudioPlayerCoordinator: NSObject, AVAudioPlayerDelegate {
    private let onFinish: @MainActor () -> Void

    init(onFinish: @escaping @MainActor () -> Void) {
        self.onFinish = onFinish
        super.init()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            onFinish()
        }
    }
}

// MARK: - Gateway Helpers (file-private duplicates)

/// Resolve the local gateway base URL: env var > lockfile > default 7830.
private func resolveAudioGatewayBaseUrl() -> String {
    let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
    return "http://127.0.0.1:\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
}

/// Fetch raw attachment bytes via the gateway's runtime proxy.
private func fetchAudioAttachmentContent(gatewayBaseUrl: String, attachmentId: String) async throws -> Data {
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
