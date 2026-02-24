import AppKit
import SwiftUI
import VellumAssistantShared

/// A modal window that presents the recording source picker before a session starts.
@MainActor
final class RecordingSourcePickerWindow {
    private var panel: NSPanel?
    private let viewModel: RecordingSourcePickerViewModel
    private let onStart: () -> Void
    private let onCancel: () -> Void
    private let panelDelegate = PanelDelegate()

    /// Intercepts the native close button (X) so we can resume the
    /// continuation that would otherwise be stuck forever.
    private class PanelDelegate: NSObject, NSWindowDelegate {
        var onClose: (() -> Void)?

        func windowWillClose(_ notification: Notification) {
            onClose?()
            onClose = nil
        }
    }

    init(viewModel: RecordingSourcePickerViewModel, onStart: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.viewModel = viewModel
        self.onStart = onStart
        self.onCancel = onCancel
    }

    func show() {
        let pickerView = RecordingSourcePickerView(
            viewModel: viewModel,
            onStart: { [weak self] in
                // Disarm the delegate before closing to prevent double-fire
                self?.panelDelegate.onClose = nil
                self?.close()
                self?.onStart()
            },
            onCancel: { [weak self] in
                self?.panelDelegate.onClose = nil
                self?.close()
                self?.onCancel()
            }
        )

        let hostingView = NSHostingView(rootView: pickerView)
        hostingView.setFrameSize(hostingView.fittingSize)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: hostingView.fittingSize),
            styleMask: [.titled, .closable, .hudWindow, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hostingView
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.hasShadow = true
        panel.backgroundColor = NSColor.clear
        panel.isOpaque = false
        panel.isReleasedWhenClosed = false

        // Wire up the delegate so native X-button close triggers onCancel
        panelDelegate.onClose = { [weak self] in
            self?.onCancel()
        }
        panel.delegate = panelDelegate

        // Center on screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let windowSize = hostingView.fittingSize
            let x = screenFrame.midX - windowSize.width / 2
            let y = screenFrame.midY - windowSize.height / 2
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func close() {
        // Disarm delegate before closing to prevent double-fire
        panelDelegate.onClose = nil
        panel?.close()
        panel = nil
    }
}
