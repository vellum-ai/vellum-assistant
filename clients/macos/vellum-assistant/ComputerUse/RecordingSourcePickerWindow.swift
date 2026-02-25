import AppKit
import SwiftUI
import VellumAssistantShared

/// Window wrapper for presenting the recording source picker modally.
///
/// Creates an NSWindow hosting `RecordingSourcePickerView` and centers it
/// on the main screen.
@MainActor
final class RecordingSourcePickerWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var viewModel: RecordingSourcePickerViewModel?
    private var onCancelCallback: (() -> Void)?
    /// Guards against double-invocation of the cancel callback (e.g., if
    /// the Cancel button is pressed and then the window also closes).
    private var cancelFired = false

    /// Show the source picker window.
    ///
    /// - Parameters:
    ///   - onStart: Called with the selected recording options when the user clicks Start.
    ///   - onCancel: Called when the user dismisses the picker.
    func show(onStart: @escaping (IPCRecordingOptions) -> Void, onCancel: @escaping () -> Void) {
        // Dismiss any existing picker window
        dismiss()

        self.onCancelCallback = onCancel
        self.cancelFired = false

        let vm = RecordingSourcePickerViewModel()
        self.viewModel = vm

        let pickerView = RecordingSourcePickerView(
            viewModel: vm,
            onStart: { [weak self] options in
                // Start was chosen — clear the cancel callback so closing
                // the window doesn't also fire cancel.
                self?.onCancelCallback = nil
                self?.cancelFired = true
                onStart(options)
                self?.dismiss()
            },
            onCancel: { [weak self] in
                self?.fireCancel()
                self?.dismiss()
            }
        )

        let hostingController = NSHostingController(rootView: pickerView)
        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 440),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        newWindow.contentViewController = hostingController
        newWindow.titleVisibility = .hidden
        newWindow.titlebarAppearsTransparent = true
        newWindow.isMovableByWindowBackground = true
        newWindow.backgroundColor = NSColor(VColor.background)
        newWindow.isReleasedWhenClosed = false
        newWindow.level = .floating
        newWindow.center()
        newWindow.delegate = self

        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = newWindow
    }

    /// Dismiss the picker window.
    func dismiss() {
        window?.delegate = nil
        window?.close()
        window = nil
        viewModel = nil
    }

    // MARK: - NSWindowDelegate

    /// Handles the window being closed via the title bar close button or Cmd+W.
    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            fireCancel()
            window = nil
            viewModel = nil
        }
    }

    // MARK: - Private

    private func fireCancel() {
        guard !cancelFired else { return }
        cancelFired = true
        onCancelCallback?()
        onCancelCallback = nil
    }
}
