#if os(macOS)
import AppKit
import ImageIO
import WebKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "OffscreenPreviewCapture")

/// Captures a preview screenshot of app HTML using an offscreen WKWebView.
/// The window is positioned off-screen and never made visible to the user.
/// The entire lifecycle (create → load → render → capture → teardown) is automatic.
///
/// Captures are serialized: only one offscreen WKWebView exists at a time.
/// A shared `WKProcessPool` is reused across sequential captures so WebKit
/// can keep a single WebContent process alive instead of spawning a new one
/// per capture. Image encoding (resize + PNG + base64) runs off the main
/// thread via `CGContext` to avoid blocking the UI.
enum OffscreenPreviewCapture {

    // MARK: - Serial Queue

    /// Continuation-based semaphore that serializes captures (max concurrency = 1).
    /// Callers `await acquireSlot()` before starting work and call `releaseSlot()`
    /// when done. Waiters are resumed in FIFO order.
    private static var isSlotOccupied = false
    private static var waiters: [CheckedContinuation<Void, Never>] = []

    @MainActor
    private static func acquireSlot() async {
        if !isSlotOccupied {
            isSlotOccupied = true
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters.append(continuation)
        }
    }

    @MainActor
    private static func releaseSlot() {
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            isSlotOccupied = false
        }
    }

    // MARK: - Shared Process Pool

    /// Reused across sequential captures so WebKit keeps a single WebContent
    /// process alive instead of spawning one per WKWebViewConfiguration.
    private static let sharedProcessPool = WKProcessPool()

    // MARK: - Public API

    /// Renders `html` in a hidden WKWebView and returns a base64-encoded PNG thumbnail.
    /// Returns `nil` if the capture fails for any reason. Safe to call from `@MainActor`.
    ///
    /// Captures are serialized — concurrent callers wait in a FIFO queue. This
    /// prevents multiple simultaneous WebContent processes and memory spikes when
    /// many app cards request previews at the same time.
    @MainActor
    static func capture(html: String) async -> String? {
        await acquireSlot()
        defer { releaseSlot() }

        let startTime = CFAbsoluteTimeGetCurrent()

        func elapsedMs() -> Int {
            Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000)
        }

        let width: CGFloat = 400
        let height: CGFloat = 300

        // Create an off-screen window that is never shown to the user.
        let window = NSWindow(
            contentRect: NSRect(x: -10000, y: -10000, width: width, height: height),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        log.info("[Timing] offscreen phase=windowCreated elapsed=\(elapsedMs())ms")

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        config.processPool = sharedProcessPool
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        window.contentView = webView

        // Load the HTML and wait for navigation to finish.
        let didLoad = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let delegate = NavigationDelegate(continuation: continuation)
            webView.navigationDelegate = delegate
            // Hold a reference so ARC doesn't deallocate the delegate before it fires.
            objc_setAssociatedObject(webView, "navDelegate", delegate, .OBJC_ASSOCIATION_RETAIN)
            webView.loadHTMLString(html, baseURL: nil)
        }

        log.info("[Timing] offscreen phase=htmlLoadComplete success=\(didLoad) elapsed=\(elapsedMs())ms")

        guard didLoad else {
            log.warning("Offscreen WKWebView failed to load HTML")
            tearDown(webView: webView, window: window)
            return nil
        }

        // Give the page a moment to finish rendering (CSS, fonts, initial paint).
        try? await Task.sleep(nanoseconds: 800_000_000) // 800ms
        log.info("[Timing] offscreen phase=renderDelayComplete elapsed=\(elapsedMs())ms")

        // Capture the snapshot.
        let snapshotConfig = WKSnapshotConfiguration()
        snapshotConfig.afterScreenUpdates = true
        let image = await takeSnapshot(webView: webView, config: snapshotConfig)
        log.info("[Timing] offscreen phase=snapshotCaptured hasImage=\(image != nil) elapsed=\(elapsedMs())ms")

        tearDown(webView: webView, window: window)
        log.info("[Timing] offscreen phase=teardownComplete elapsed=\(elapsedMs())ms")

        // Extract CGImage on the main thread (NSImage is not thread-safe),
        // then encode off-main using only thread-safe CG/ImageIO APIs.
        guard let image,
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let base64 = await encodeOffMain(cgImage: cgImage)
        log.info("[Timing] offscreen phase=imageEncoded hasResult=\(base64 != nil) elapsed=\(elapsedMs())ms")
        return base64
    }

    // MARK: - Private

    /// Takes a WKWebView snapshot and returns the raw NSImage.
    /// Runs on MainActor because `takeSnapshot` requires it.
    @MainActor
    private static func takeSnapshot(webView: WKWebView, config: WKSnapshotConfiguration) async -> NSImage? {
        await withCheckedContinuation { continuation in
            let takeSnapshotStart = CFAbsoluteTimeGetCurrent()
            webView.takeSnapshot(with: config) { image, error in
                let takeSnapshotMs = Int((CFAbsoluteTimeGetCurrent() - takeSnapshotStart) * 1000)
                log.info("[Timing] offscreen phase=takeSnapshotCallback elapsed=\(takeSnapshotMs)ms")
                if let error = error {
                    log.error("Offscreen snapshot failed: \(error.localizedDescription, privacy: .public)")
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: image)
            }
        }
    }

    /// Resizes and encodes a CGImage to a base64 PNG string using CGContext.
    /// Runs on a background thread using only thread-safe CG/ImageIO APIs.
    /// The caller must extract the CGImage from NSImage on the main thread
    /// before calling this method (NSImage is not thread-safe).
    private static func encodeOffMain(cgImage: CGImage) async -> String? {
        await Task.detached(priority: .userInitiated) {
            let encodeStart = CFAbsoluteTimeGetCurrent()

            // Resize to max 400px wide thumbnail using CGContext (thread-safe).
            let maxWidth: CGFloat = 400
            let originalWidth = CGFloat(cgImage.width)
            let originalHeight = CGFloat(cgImage.height)
            let scale = min(1.0, maxWidth / originalWidth)
            let targetWidth = Int(originalWidth * scale)
            let targetHeight = Int(originalHeight * scale)

            guard let colorSpace = cgImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
                  let ctx = CGContext(
                      data: nil,
                      width: targetWidth,
                      height: targetHeight,
                      bitsPerComponent: 8,
                      bytesPerRow: 0,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  ) else {
                log.warning("Failed to create CGContext for image resize")
                return nil as String?
            }

            ctx.interpolationQuality = .high
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))

            guard let resizedCGImage = ctx.makeImage() else {
                log.warning("Failed to create resized CGImage")
                return nil as String?
            }

            // Encode to PNG via ImageIO (thread-safe, no AppKit dependency).
            let mutableData = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                mutableData as CFMutableData,
                "public.png" as CFString,
                1,
                nil
            ) else {
                log.warning("Failed to create PNG image destination")
                return nil as String?
            }
            CGImageDestinationAddImage(destination, resizedCGImage, nil)
            guard CGImageDestinationFinalize(destination) else {
                log.warning("Failed to finalize PNG image destination")
                return nil as String?
            }

            let encodeMs = Int((CFAbsoluteTimeGetCurrent() - encodeStart) * 1000)
            log.info("[Timing] offscreen phase=imageEncode elapsed=\(encodeMs)ms")
            return (mutableData as Data).base64EncodedString()
        }.value
    }

    @MainActor
    private static func tearDown(webView: WKWebView, window: NSWindow) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        window.contentView = nil
        window.close()
    }
}

// MARK: - Navigation Delegate

private final class NavigationDelegate: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Bool, Never>?

    init(continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume(returning: true)
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(returning: false)
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(returning: false)
        continuation = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        continuation?.resume(returning: false)
        continuation = nil
    }
}
#endif
