import VellumAssistantShared
import AppKit
import SwiftUI

#Preview {
    ThinkingIndicatorView()
}

struct ThinkingIndicatorView: View {
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0

    private var thinkingText: String {
        if completedConversationCount < 5, let name = IdentityInfo.load()?.name {
            return "\(name) is thinking..."
        }
        return "Thinking..."
    }

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text(thinkingText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(VColor.backgroundSubtle)
    }
}

@MainActor
final class ThinkingIndicatorWindow {
    private var panel: NSPanel?

    func show() {
        let hostingView = NSHostingView(rootView: ThinkingIndicatorView())
        hostingView.setFrameSize(hostingView.fittingSize)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: hostingView.fittingSize),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hostingView
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.hasShadow = true
        panel.backgroundColor = NSColor.clear
        panel.isOpaque = false
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position at bottom-right of screen (same as SessionOverlayWindow)
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let windowSize = hostingView.fittingSize
            let x = screenFrame.maxX - windowSize.width - 20
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
