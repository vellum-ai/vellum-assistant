import AppKit
import SwiftUI

final class AmbientSuggestionWindow {
    private var panel: NSPanel?
    private let suggestion: String
    private let onAccept: () -> Void
    private let onDismiss: () -> Void

    init(suggestion: String, onAccept: @escaping () -> Void, onDismiss: @escaping () -> Void) {
        self.suggestion = suggestion
        self.onAccept = onAccept
        self.onDismiss = onDismiss
    }

    func show() {
        let view = AmbientSuggestionView(
            suggestion: suggestion,
            onAccept: { [weak self] in
                self?.close()
                self?.onAccept()
            },
            onDismiss: { [weak self] in
                self?.close()
                self?.onDismiss()
            }
        )
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 140),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position bottom-right, above where session overlay would appear
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 340 - 20
            let y = screenFrame.minY + 20 + 160 + 10
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel

        // Auto-dismiss after 30 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            if self?.panel != nil {
                self?.close()
                self?.onDismiss()
            }
        }
    }

    func close() {
        panel?.close()
        panel = nil
    }
}

private struct AmbientSuggestionView: View {
    let suggestion: String
    let onAccept: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                Image(systemName: "eye.fill")
                    .foregroundStyle(.blue)
                Text("Ambient Suggestion")
                    .font(VFont.heading)
                Spacer()
            }

            Text(suggestion)
                .font(VFont.body)
                .lineLimit(3)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("Dismiss") {
                    onDismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])

                Button("Accept") {
                    onAccept()
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 340)
    }
}
