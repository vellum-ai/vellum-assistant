#if os(macOS)
import AppKit
import WebKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "OffscreenPreviewCapture")

/// Captures a preview screenshot of app HTML using an offscreen WKWebView.
/// The window is positioned off-screen and never made visible to the user.
/// The entire lifecycle (create → load → render → capture → teardown) is automatic.
enum OffscreenPreviewCapture {

    /// Renders `html` in a hidden WKWebView and returns a base64-encoded PNG thumbnail.
    /// Returns `nil` if the capture fails for any reason. Safe to call from `@MainActor`.
    @MainActor
    static func capture(html: String) async -> String? {
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
        let base64 = await captureSnapshot(webView: webView, config: snapshotConfig)
        log.info("[Timing] offscreen phase=snapshotCaptured hasImage=\(base64 != nil) elapsed=\(elapsedMs())ms")

        tearDown(webView: webView, window: window)
        log.info("[Timing] offscreen phase=teardownComplete elapsed=\(elapsedMs())ms")
        return base64
    }

    // MARK: - Private

    @MainActor
    private static func captureSnapshot(webView: WKWebView, config: WKSnapshotConfiguration) async -> String? {
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
                guard let image = image,
                      let tiff = image.tiffRepresentation,
                      let _ = NSBitmapImageRep(data: tiff) else {
                    continuation.resume(returning: nil)
                    return
                }
                // Resize to max 400px wide thumbnail
                let resizeStart = CFAbsoluteTimeGetCurrent()
                let maxWidth: CGFloat = 400
                let scale = min(1.0, maxWidth / image.size.width)
                let targetSize = NSSize(
                    width: image.size.width * scale,
                    height: image.size.height * scale
                )
                let resized = NSImage(size: targetSize)
                resized.lockFocus()
                image.draw(
                    in: NSRect(origin: .zero, size: targetSize),
                    from: NSRect(origin: .zero, size: image.size),
                    operation: .copy,
                    fraction: 1.0
                )
                resized.unlockFocus()
                guard let resizedTiff = resized.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: resizedTiff),
                      let pngData = bitmap.representation(using: .png, properties: [.compressionFactor: 0.8]) else {
                    continuation.resume(returning: nil)
                    return
                }
                let resizeMs = Int((CFAbsoluteTimeGetCurrent() - resizeStart) * 1000)
                log.info("[Timing] offscreen phase=imageResize elapsed=\(resizeMs)ms")
                continuation.resume(returning: pngData.base64EncodedString())
            }
        }
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
