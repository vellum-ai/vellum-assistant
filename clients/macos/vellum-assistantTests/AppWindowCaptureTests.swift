#if os(macOS)
import XCTest
import AppKit
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AppWindowCaptureTests: XCTestCase {

    /// Capture Finder's frontmost normal window. Finder is kept alive by macOS, so on
    /// any normal desktop session there should always be a layer-0 Finder window
    /// (the desktop window itself qualifies). If a hardened CI/headless environment
    /// somehow hides Finder entirely, the test skips with `XCTSkip` rather than failing.
    ///
    /// This test also exercises the ScreenCaptureKit path, which requires Screen
    /// Recording permission. In CI without that permission, the capture fails
    /// internally and `pngBase64` will be `nil`; we tolerate that and skip rather
    /// than fail.
    func test_capture_finder_returnsRunningWithBounds() async throws {
        let finders = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.apple.finder"
        )
        guard let pid = finders.first?.processIdentifier else {
            throw XCTSkip("Finder is not running in this environment; cannot exercise capture path.")
        }

        let result = await AppWindowCapture.capture(forPid: pid)

        // Finder may be in a state with no on-screen layer-0 window in some headless CI
        // contexts; tolerate that by skipping rather than failing.
        guard result.state == .running else {
            throw XCTSkip("Finder produced state \(result.state) — no on-screen normal window available.")
        }

        XCTAssertNotNil(result.bounds, "Expected non-nil bounds for a running Finder window")

        // pngBase64 may be nil if Screen Recording permission is not granted in this
        // test environment. When it is present, validate the PNG magic header
        // and assert no captureError was reported. When it is absent, captureError
        // should explain why (typically a Screen Recording permission hint).
        if let pngBase64 = result.pngBase64 {
            XCTAssertNil(
                result.captureError,
                "Expected no captureError when pngBase64 is present; got: \(result.captureError ?? "")"
            )
            let pngData = try XCTUnwrap(Data(base64Encoded: pngBase64))
            XCTAssertGreaterThanOrEqual(pngData.count, 8, "PNG payload too small to contain magic bytes")

            // PNG magic header: 0x89 0x50 0x4E 0x47.
            let magic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
            let prefix = Array(pngData.prefix(4))
            XCTAssertEqual(prefix, magic, "PNG bytes do not begin with the PNG magic header")
        } else {
            // If we got no PNG, captureError must explain why so the daemon and
            // LLM can surface that to the user (commonly: Screen Recording
            // permission missing).
            let error = result.captureError ?? ""
            XCTAssertFalse(
                error.isEmpty,
                "Expected non-empty captureError when pngBase64 is nil for a running window"
            )
        }
    }

    /// A bogus PID is a "no window" failure — the result is `.missing` and
    /// `captureError` stays `nil`. The error field is reserved for *capture*
    /// failures (ScreenCaptureKit returned no image even though the window
    /// existed), not window-state classification failures.
    func test_capture_unknownPid_returnsMissingWithNoCaptureError() async {
        let unknownPid: pid_t = 999_999
        let result = await AppWindowCapture.capture(forPid: unknownPid)
        XCTAssertEqual(result.state, .missing)
        XCTAssertNil(result.pngBase64)
        XCTAssertNil(result.bounds)
        XCTAssertNil(result.captureError)
    }
}
#endif
