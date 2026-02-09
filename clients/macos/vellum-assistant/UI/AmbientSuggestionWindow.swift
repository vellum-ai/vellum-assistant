import AppKit
import SwiftUI

final class AmbientSuggestionWindow {
    private var panel: NSPanel?
    private let detail: AmbientSuggestionDetail
    private let onAccept: () -> Void
    private let onDismiss: () -> Void

    init(detail: AmbientSuggestionDetail, onAccept: @escaping () -> Void, onDismiss: @escaping () -> Void) {
        self.detail = detail
        self.onAccept = onAccept
        self.onDismiss = onDismiss
    }

    func show() {
        let view = AmbientSuggestionView(
            detail: detail,
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
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 200),
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
            let x = screenFrame.maxX - 360 - 20
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
    let detail: AmbientSuggestionDetail
    let onAccept: () -> Void
    let onDismiss: () -> Void

    private var iconColor: Color {
        switch detail.icon.tintColor {
        case "blue": return .blue
        case "red": return .red
        case "purple": return .purple
        case "orange": return .orange
        case "teal": return .teal
        case "yellow": return .yellow
        default: return .blue
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: icon + title
            HStack(spacing: 8) {
                Image(systemName: detail.icon.sfSymbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(iconColor)
                Text(detail.title)
                    .font(.headline)
                Spacer()
            }

            // Headline stat (if present)
            if let stat = detail.headlineStat {
                Text(stat)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(iconColor)
            }

            // Action steps
            if !detail.actionSteps.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(detail.actionSteps, id: \.self) { step in
                        HStack(alignment: .top, spacing: 6) {
                            Text("\u{2022}")
                                .foregroundStyle(.secondary)
                            Text(step)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            // Buttons
            HStack {
                Spacer()
                Button("Dismiss") {
                    onDismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])

                Button("Let\u{2019}s do it") {
                    onAccept()
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
                .tint(iconColor)
            }
        }
        .padding()
        .frame(width: 360)
    }
}
