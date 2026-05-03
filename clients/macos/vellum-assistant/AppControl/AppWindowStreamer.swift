#if os(macOS)
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppWindowStreamer")

/// Maintains a long-running ScreenCaptureKit stream per target window and
/// returns the latest captured frame on demand.
///
/// Why streaming instead of one-shot `SCScreenshotManager.captureImage`:
/// the one-shot path with `SCContentFilter(desktopIndependentWindow:)` reads
/// from the window's AppKit/CoreAnimation backing store, which doesn't
/// reflect Metal/OpenGL composited pixels for apps that render to their own
/// GPU surface (emulators, OpenGL canvases, custom-rendered Electron). PRs
/// #29377, #29386 confirmed neither settle delays nor warmup-capture
/// patterns refresh the backing store. PR #29389 tried a one-shot display-
/// area capture and hung (reverted in #29443).
///
/// This streamer uses `SCContentFilter(display: ..., including: [scWindow])`,
/// which routes through the display-composite path (fresh GPU pixels) and
/// asks SCK to mask the captured frame down to just the target window —
/// no `sourceRect` cropping math required. The continuous stream amortizes
/// SCK setup across many `observe` calls, so the first capture takes
/// ~200-500ms and subsequent ones are ~5-15ms.
actor AppWindowStreamer {
    static let shared = AppWindowStreamer()

    private var streams: [CGWindowID: ActiveStream] = [:]

    enum CaptureResult {
        case success(pngBase64: String)
        case failure(String)
    }

    /// Pull the latest captured frame for `windowID`. Starts a new stream
    /// and waits for the first frame if none is active. If a previous stream
    /// has died (window closed, permission revoked, etc.), it's discarded
    /// and a fresh stream is attempted.
    func latestFrame(forWindow windowID: CGWindowID) async -> CaptureResult {
        if let existing = streams[windowID], await existing.isHealthy {
            return await existing.pullLatestPNG()
        }
        if let dead = streams.removeValue(forKey: windowID) {
            await dead.stop()
        }
        do {
            let stream = try await ActiveStream.start(windowID: windowID)
            streams[windowID] = stream
            return await stream.pullLatestPNG()
        } catch {
            return .failure("Failed to start window stream: \(error.localizedDescription)")
        }
    }

    /// Tear down every stream this client has open. Called from
    /// `app_control_stop` so an idle session doesn't keep burning CPU.
    func stopAll() async {
        for (_, stream) in streams {
            await stream.stop()
        }
        streams.removeAll()
    }
}

private enum StreamerError: LocalizedError {
    case windowNotFound
    case noDisplay
    case firstFrameTimeout

    var errorDescription: String? {
        switch self {
        case .windowNotFound:
            return "ScreenCaptureKit could not find the requested window — Screen Recording permission may be required (System Settings > Privacy & Security > Screen & System Audio Recording)"
        case .noDisplay:
            return "ScreenCaptureKit returned no displays — Screen Recording permission may be required"
        case .firstFrameTimeout:
            return "Stream produced no frames within timeout"
        }
    }
}

/// Owns one `SCStream` for a single target window. Holds the latest sample
/// buffer behind a serial dispatch queue and exposes async accessors.
private final class ActiveStream: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /// Implicitly unwrapped because `SCStream` requires the delegate at init
    /// time and we can't pass `self` until after `super.init()`. Set in the
    /// designated initializer; never nil after construction completes.
    private var stream: SCStream!
    private let frameQueue = DispatchQueue(label: "AppWindowStreamer.frame")
    private let ciContext = CIContext(options: nil)
    private var latestSampleBuffer: CMSampleBuffer?
    private var firstFrameContinuation: CheckedContinuation<Void, Never>?
    private var stopped = false

    /// Hard cap on how long the first-frame wait blocks. If SCK never
    /// produces a frame (permission revoked between start and first frame,
    /// window destroyed mid-startup), we resume the continuation and let
    /// `pullLatestPNG` surface the empty-buffer error.
    private static let FIRST_FRAME_TIMEOUT_MS: Int = 1_000

    var isHealthy: Bool {
        get async {
            frameQueue.sync { !stopped }
        }
    }

    static func start(windowID: CGWindowID) async throws -> ActiveStream {
        let shareable = try await SCShareableContent.current
        guard let scWindow = shareable.windows.first(where: { $0.windowID == windowID }) else {
            throw StreamerError.windowNotFound
        }
        // Pick the display containing the window's center; fall back to the
        // first available display if no display contains it (window dragged
        // partway off-screen, etc.).
        let center = CGPoint(x: scWindow.frame.midX, y: scWindow.frame.midY)
        let display = shareable.displays.first(where: { $0.frame.contains(center) })
            ?? shareable.displays.first
        guard let display else {
            throw StreamerError.noDisplay
        }

        let filter = SCContentFilter(display: display, including: [scWindow])
        let config = SCStreamConfiguration()
        config.width = max(Int(scWindow.frame.width), 1)
        config.height = max(Int(scWindow.frame.height), 1)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        // 30fps is plenty for an LLM-driven observe loop. Lower than the
        // emulator's 60fps but still well above the LLM's polling cadence,
        // and halves the CPU cost of a continuously-running stream.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 3

        let active = ActiveStream(filter: filter, configuration: config)
        try await active.stream.startCapture()
        await active.waitForFirstFrame()
        return active
    }

    private init(filter: SCContentFilter, configuration: SCStreamConfiguration) {
        super.init()
        self.stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try? self.stream.addStreamOutput(
            self,
            type: .screen,
            sampleHandlerQueue: frameQueue
        )
    }

    func stop() async {
        frameQueue.sync { stopped = true }
        try? await stream.stopCapture()
    }

    private func waitForFirstFrame() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            frameQueue.async {
                if self.latestSampleBuffer != nil {
                    continuation.resume()
                    return
                }
                self.firstFrameContinuation = continuation
                // Hard timeout: if no frame arrives, resume so the caller
                // doesn't hang. `pullLatestPNG` will then return
                // .failure("No frame available yet") to the LLM.
                let deadline = DispatchTime.now() + .milliseconds(Self.FIRST_FRAME_TIMEOUT_MS)
                self.frameQueue.asyncAfter(deadline: deadline) { [weak self] in
                    guard let self else { return }
                    if let pending = self.firstFrameContinuation {
                        self.firstFrameContinuation = nil
                        pending.resume()
                    }
                }
            }
        }
    }

    func pullLatestPNG() async -> AppWindowStreamer.CaptureResult {
        let buffer: CMSampleBuffer? = frameQueue.sync { latestSampleBuffer }
        guard let buffer, let pixelBuffer = CMSampleBufferGetImageBuffer(buffer) else {
            return .failure("No frame available yet — stream may still be warming up or has stopped")
        }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
            return .failure("Failed to convert sample buffer to CGImage")
        }
        guard let png = encodePNGBase64(cgImage: cgImage) else {
            return .failure("Failed to encode captured frame as PNG")
        }
        return .success(pngBase64: png)
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // SCK delivers idle/blank/suspended frames in addition to complete
        // ones; only `.complete` carries usable pixel data. Filter via the
        // SCStreamFrameInfo.status attachment.
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let attachments = attachmentsArray.first,
            let statusRaw = attachments[.status] as? Int,
            let status = SCFrameStatus(rawValue: statusRaw),
            status == .complete
        else {
            return
        }

        // Already on frameQueue (we passed it as sampleHandlerQueue).
        latestSampleBuffer = sampleBuffer
        if let pending = firstFrameContinuation {
            firstFrameContinuation = nil
            pending.resume()
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log.warning("ActiveStream stopped with error: \(error.localizedDescription, privacy: .public)")
        frameQueue.async {
            self.stopped = true
            if let pending = self.firstFrameContinuation {
                self.firstFrameContinuation = nil
                pending.resume()
            }
        }
    }
}

// MARK: - PNG encoding

private func encodePNGBase64(cgImage: CGImage) -> String? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        return nil
    }
    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else {
        return nil
    }
    return (data as Data).base64EncodedString()
}
#endif
