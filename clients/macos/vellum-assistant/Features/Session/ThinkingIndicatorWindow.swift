import VellumAssistantShared
import AppKit
import SwiftUI

#Preview {
    ThinkingIndicatorView()
}

struct ThinkingIndicatorView: View {
    var statusText: String?
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0

    private var thinkingText: String {
        if let statusText, !statusText.isEmpty {
            return "\(statusText)..."
        }
        if completedConversationCount <= 5,
           let name = AssistantDisplayName.firstUserFacing(from: [IdentityInfo.load()?.name]) {
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
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }
}

@MainActor
final class ThinkingIndicatorWindow {
    private var panel: NSPanel?

    private var currentStatusText: String?

    func show(statusText: String? = nil) {
        currentStatusText = statusText
        let hostingView = NSHostingView(rootView: ThinkingIndicatorView(statusText: statusText))
        hostingView.setFrameSize(hostingView.fittingSize)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: hostingView.fittingSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hostingView
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
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

    func update(statusText: String?) {
        guard let panel else { return }
        currentStatusText = statusText
        let hostingView = NSHostingView(rootView: ThinkingIndicatorView(statusText: statusText))
        hostingView.setFrameSize(hostingView.fittingSize)
        panel.contentView = hostingView
        panel.setContentSize(hostingView.fittingSize)
    }

    func close() {
        panel?.close()
        panel = nil
        currentStatusText = nil
    }
}
