import AppKit
import SwiftUI
import VellumAssistantShared

/// Window wrapper for presenting the recording source picker modally.
///
/// Creates an NSWindow hosting `RecordingSourcePickerView` and centers it
/// on the main screen.
@MainActor
final class RecordingSourcePickerWindow {
    private var window: NSWindow?
    private var viewModel: RecordingSourcePickerViewModel?

    /// Show the source picker window.
    ///
    /// - Parameters:
    ///   - onStart: Called with the selected recording options when the user clicks Start.
    ///   - onCancel: Called when the user dismisses the picker.
    func show(onStart: @escaping (IPCRecordingOptions) -> Void, onCancel: @escaping () -> Void) {
        // Dismiss any existing picker window
        dismiss()

        let vm = RecordingSourcePickerViewModel()
        self.viewModel = vm

        let pickerView = RecordingSourcePickerView(
            viewModel: vm,
            onStart: { [weak self] options in
                onStart(options)
                self?.dismiss()
            },
            onCancel: { [weak self] in
                onCancel()
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

        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = newWindow
    }

    /// Dismiss the picker window.
    func dismiss() {
        window?.close()
        window = nil
        viewModel = nil
    }
}
