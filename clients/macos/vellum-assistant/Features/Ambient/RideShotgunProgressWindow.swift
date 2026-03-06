import VellumAssistantShared
import AppKit
import SwiftUI

final class RideShotgunProgressWindow {
    private var panel: NSPanel?
    private let session: RideShotgunSession
    private let onStop: () -> Void

    init(session: RideShotgunSession, onStop: @escaping () -> Void) {
        self.session = session
        self.onStop = onStop
    }

    func show() {
        let view = RideShotgunProgressView(
            session: session,
            onStop: { [weak self] in
                self?.close()
                self?.onStop()
            }
        )
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 80),
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
            let x = screenFrame.maxX - 300 - 20
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
    }
}

private struct RideShotgunProgressView: View {
    @ObservedObject var session: RideShotgunSession
    let onStop: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.sm) {
            HStack {
                Image(systemName: "binoculars.fill")
                    .foregroundStyle(VColor.accent)
                    .symbolEffect(.pulse)
                Text("Riding shotgun...")
                    .font(VFont.bodyMedium)
                Spacer()
                Button {
                    onStop()
                } label: {
                    VIconView(.circleX, size: 14)
                        .foregroundStyle(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
            }

            ProgressView(value: session.elapsedSeconds, total: Double(session.durationSeconds))
                .tint(VColor.accent)

            HStack {
                if !session.currentApp.isEmpty {
                    Text(session.currentApp)
                        .font(VFont.caption)
                        .foregroundStyle(VColor.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Text("\(Int(session.elapsedSeconds))s / \(session.durationSeconds)s")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
            }
        }
        .padding()
        .frame(width: 300)
        .vPanelBackground()
    }
}
