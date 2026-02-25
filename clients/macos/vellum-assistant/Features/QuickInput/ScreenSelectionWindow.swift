import AppKit
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

/// A full-screen transparent window overlay for drag-to-select screen region capture.
///
/// Creates a borderless, transparent window covering the entire screen. The user
/// drags to select a region, then a screenshot is captured using ScreenCaptureKit
/// (excluding the overlay window itself).
@MainActor
final class ScreenSelectionWindow {

    /// Called when the user completes a selection. Provides JPEG data and the
    /// selection rect in screen coordinates.
    var onComplete: ((Data, NSRect) -> Void)?

    /// Called when the user cancels (Escape or click without drag).
    var onCancel: (() -> Void)?

    private var window: NSWindow?

    func show() {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.frame

        let window = NSWindow(
            contentRect: screenFrame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = .screenSaver
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let selectionView = ScreenSelectionView(frame: screenFrame)
        selectionView.onSelectionComplete = { [weak self] viewRect in
            self?.handleSelectionComplete(viewRect: viewRect, screen: screen)
        }
        selectionView.onCancel = { [weak self] in
            self?.close()
            self?.onCancel?()
        }

        window.contentView = selectionView
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(selectionView)

        // Activate the app so the overlay window can receive keyboard events
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
        window?.close()
        window = nil
    }

    // MARK: - Capture

    private func handleSelectionComplete(viewRect: NSRect, screen: NSScreen) {
        let screenFrame = screen.frame

        // The selection rect in NSScreen coordinates for repositioning the panel
        let screenRect = NSRect(
            x: screenFrame.origin.x + viewRect.origin.x,
            y: viewRect.origin.y,
            width: viewRect.width,
            height: viewRect.height
        )

        // Hide the overlay before capturing so it doesn't appear in the screenshot.
        window?.orderOut(nil)

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 50_000_000) // 50ms

            do {
                let jpegData = try await captureRegion(viewRect: viewRect, screen: screen)
                self.close()
                onComplete?(jpegData, screenRect)
            } catch {
                self.close()
                onCancel?()
            }
        }
    }

    /// Captures the selected screen region using ScreenCaptureKit.
    private func captureRegion(viewRect: NSRect, screen: NSScreen) async throws -> Data {
        let content = try await SCShareableContent.current

        let mainDisplayID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainDisplayID })
                ?? content.displays.first else {
            throw CaptureError.noDisplay
        }

        // Exclude our own app's windows so the overlay doesn't appear
        let myPID = ProcessInfo.processInfo.processIdentifier
        let ownWindows = content.windows.filter { $0.owningApplication?.processID == myPID }
        let filter = SCContentFilter(display: display, excludingWindows: ownWindows)

        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false

        // Capture the full display, then crop to the selection
        let fullImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        // Convert view rect (origin bottom-left) to image rect (origin top-left)
        let screenFrame = screen.frame
        let scaleX = CGFloat(fullImage.width) / screenFrame.width
        let scaleY = CGFloat(fullImage.height) / screenFrame.height

        let cropRect = CGRect(
            x: viewRect.origin.x * scaleX,
            y: (screenFrame.height - viewRect.origin.y - viewRect.height) * scaleY,
            width: viewRect.width * scaleX,
            height: viewRect.height * scaleY
        )

        guard let croppedImage = fullImage.cropping(to: cropRect) else {
            throw CaptureError.conversionFailed
        }

        // Convert to JPEG via ImageIO
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw CaptureError.conversionFailed
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
        CGImageDestinationAddImage(destination, croppedImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureError.conversionFailed
        }

        return data as Data
    }
}
