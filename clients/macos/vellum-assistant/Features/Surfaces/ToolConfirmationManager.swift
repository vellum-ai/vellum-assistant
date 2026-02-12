import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ToolConfirmationManager")

/// Manages floating confirmation panels for daemon tool permission requests.
///
/// When the daemon needs user approval for a tool invocation, it sends a
/// `confirmation_request` message. This manager creates a floating NSPanel
/// with Allow/Deny buttons and sends back a `confirmation_response`.
@MainActor
final class ToolConfirmationManager {

    private var panels: [String: NSPanel] = [:]
    private let panelWidth: CGFloat = 420
    private let panelMargin: CGFloat = 20

    var onResponse: ((String, String) -> Void)?

    func showConfirmation(_ message: ConfirmationRequestMessage) {
        // Dismiss existing panel for same request, if any
        dismissConfirmation(requestId: message.requestId)

        let view = ToolConfirmationView(
            toolName: message.toolName,
            riskLevel: message.riskLevel,
            diff: message.diff,
            onAllow: { [weak self] in
                self?.respond(requestId: message.requestId, decision: "allow")
            },
            onDeny: { [weak self] in
                self?.respond(requestId: message.requestId, decision: "deny")
            }
        )

        let hostingController = NSHostingController(rootView: view)

        let panelHeight: CGFloat = message.diff != nil ? 340 : 160
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
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

        // Position at top-right of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panelWidth - panelMargin
            let y = screenFrame.maxY - panelHeight - panelMargin
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panels[message.requestId] = panel
        panel.orderFront(nil)

        log.info("Showing tool confirmation: requestId=\(message.requestId), tool=\(message.toolName), risk=\(message.riskLevel)")
    }

    func dismissConfirmation(requestId: String) {
        panels[requestId]?.close()
        panels.removeValue(forKey: requestId)
    }

    func dismissAll() {
        for (requestId, panel) in panels {
            panel.close()
            onResponse?(requestId, "deny")
        }
        panels.removeAll()
    }

    private func respond(requestId: String, decision: String) {
        dismissConfirmation(requestId: requestId)
        onResponse?(requestId, decision)
    }
}

// MARK: - ToolConfirmationView

struct ToolConfirmationView: View {
    let toolName: String
    let riskLevel: String
    let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    let onAllow: () -> Void
    let onDeny: () -> Void

    private var isHighRisk: Bool { riskLevel.lowercased() == "high" }

    private var toolDisplayName: String {
        switch toolName {
        case "file_write": return "Write File"
        case "file_edit": return "Edit File"
        case "bash": return "Run Command"
        case "web_fetch": return "Fetch URL"
        default: return toolName.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack(spacing: VSpacing.md) {
                Image(systemName: isHighRisk ? "exclamationmark.triangle.fill" : "shield.checkered")
                    .font(.title2)
                    .foregroundStyle(isHighRisk ? VColor.error : VColor.warning)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Tool Permission Request")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                    Text("\(toolDisplayName) — \(riskLevel) risk")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                Spacer()
            }

            // Diff preview
            if let diff = diff {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(diff.filePath)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if diff.isNewFile {
                        Text("New file")
                            .font(VFont.caption)
                            .foregroundColor(VColor.success)
                    }

                    ScrollView {
                        Text(diff.newContent.prefix(500))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(VColor.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 140)
                    .padding(VSpacing.sm)
                    .background(VColor.surface)
                    .cornerRadius(VRadius.md)
                }
            }

            // Action buttons
            HStack(spacing: VSpacing.lg) {
                Spacer()

                VButton(label: "Deny", style: .ghost) {
                    onDeny()
                }

                VButton(label: "Allow", style: isHighRisk ? .danger : .primary) {
                    onAllow()
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 420)
        .vPanelBackground()
    }
}