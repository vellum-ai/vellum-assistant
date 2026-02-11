import AppKit
import SwiftUI

final class InsightNotificationWindow {
    private var panel: NSPanel?
    private let insight: KnowledgeInsight
    private let onDismiss: () -> Void
    private let onViewAll: () -> Void

    init(insight: KnowledgeInsight, onDismiss: @escaping () -> Void, onViewAll: @escaping () -> Void) {
        self.insight = insight
        self.onDismiss = onDismiss
        self.onViewAll = onViewAll
    }

    func show() {
        let view = InsightNotificationView(
            insight: insight,
            onDismiss: { [weak self] in
                self?.close()
                self?.onDismiss()
            },
            onViewAll: { [weak self] in
                self?.close()
                self?.onViewAll()
            }
        )
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 160),
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

        // Position top-right, below where session overlay would appear
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 340 - 20
            let y = screenFrame.maxY - 160 - 200
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel

        // Auto-dismiss after 60 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
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

private struct InsightNotificationView: View {
    let insight: KnowledgeInsight
    let onDismiss: () -> Void
    let onViewAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VellumSpacing.lg) {
            HStack {
                Image(systemName: "lightbulb.fill")
                    .foregroundStyle(Amber._600)
                Text("Knowledge Insight")
                    .font(VellumFont.heading)
                Spacer()
                categoryBadge
            }

            Text(insight.title)
                .font(VellumFont.body)
                .fontWeight(.bold)
                .lineLimit(2)

            Text(insight.description)
                .font(VellumFont.caption)
                .lineLimit(3)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("Dismiss") {
                    onDismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])

                Button("View All") {
                    onViewAll()
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 340)
    }

    private var categoryBadge: some View {
        Text(insight.category.rawValue.capitalized)
            .font(.caption)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(categoryColor.opacity(0.2))
            .foregroundStyle(categoryColor)
            .clipShape(Capsule())
    }

    private var categoryColor: Color {
        switch insight.category {
        case .pattern: return Indigo._600
        case .automation: return Emerald._600
        case .insight: return Amber._600
        }
    }
}
