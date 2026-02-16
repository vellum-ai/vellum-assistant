import VellumAssistantShared
import AppKit
import SwiftUI

final class RideShotgunSummaryWindow {
    private var panel: NSPanel?
    private let summary: String
    private let onDismiss: () -> Void
    private let onHelp: (String) -> Void

    init(summary: String, onDismiss: @escaping () -> Void, onHelp: @escaping (String) -> Void) {
        self.summary = summary
        self.onDismiss = onDismiss
        self.onHelp = onHelp
    }

    func show() {
        let view = RideShotgunSummaryView(
            summary: summary,
            onDismiss: { [weak self] in
                self?.close()
                self?.onDismiss()
            },
            onHelp: { [weak self] in
                guard let self else { return }
                self.close()
                self.onHelp(self.summary)
            }
        )
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 400),
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

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 420 - 20
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel

        // Auto-dismiss after 5 minutes
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self] in
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

private struct RideShotgunSummaryView: View {
    let summary: String
    let onDismiss: () -> Void
    let onHelp: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                Image(systemName: "binoculars.fill")
                    .foregroundStyle(VColor.accent)
                Text("Here's what I noticed")
                    .font(VFont.headline)
                Spacer()
            }

            ScrollView {
                Text(summary)
                    .font(VFont.body)
                    .foregroundStyle(VColor.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 280)

            HStack {
                Spacer()
                Button("Dismiss") {
                    onDismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])

                Button("Help me with something") {
                    onHelp()
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 420)
    }
}
