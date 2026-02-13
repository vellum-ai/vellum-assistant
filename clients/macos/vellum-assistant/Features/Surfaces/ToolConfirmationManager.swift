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

    /// Called when the user responds to a floating confirmation panel.
    /// Returns `true` if the IPC send succeeded, `false` otherwise.
    var onResponse: ((String, String) -> Bool)?

    /// Called when the user saves a trust rule from the floating panel.
    /// Returns `true` if the IPC send succeeded, `false` otherwise.
    var onAddTrustRule: ((String, String, String, String) -> Bool)?

    func showConfirmation(_ message: ConfirmationRequestMessage) {
        // Dismiss existing panel for same request, if any
        dismissConfirmation(requestId: message.requestId)

        let hasRuleOptions = !message.allowlistOptions.isEmpty && !message.scopeOptions.isEmpty
        let view = ToolConfirmationView(
            toolName: message.toolName,
            riskLevel: message.riskLevel,
            diff: message.diff,
            allowlistOptions: message.allowlistOptions,
            scopeOptions: message.scopeOptions,
            onAllow: { [weak self] in
                self?.respond(requestId: message.requestId, decision: "allow", hasRuleOptions: hasRuleOptions) ?? false
            },
            onDeny: { [weak self] in
                self?.respond(requestId: message.requestId, decision: "deny", hasRuleOptions: hasRuleOptions) ?? false
            },
            onDismiss: { [weak self] in
                self?.dismissConfirmation(requestId: message.requestId)
            },
            onAddTrustRule: { [weak self] toolName, pattern, scope, decision in
                let success = self?.onAddTrustRule?(toolName, pattern, scope, decision) ?? false
                if success {
                    // Auto-dismiss after saving rule
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        self?.dismissConfirmation(requestId: message.requestId)
                    }
                }
                return success
            }
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = .preferredContentSize

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
            _ = onResponse?(requestId, "deny")
        }
        panels.removeAll()
    }

    private func respond(requestId: String, decision: String, hasRuleOptions: Bool) -> Bool {
        let success = onResponse?(requestId, decision) ?? true
        if success && !hasRuleOptions {
            dismissConfirmation(requestId: requestId)
        }
        return success
    }
}

// MARK: - ToolConfirmationView

struct ToolConfirmationView: View {
    let toolName: String
    let riskLevel: String
    let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    let allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption]
    let scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption]
    let onAllow: () -> Bool
    let onDeny: () -> Bool
    let onDismiss: () -> Void
    let onAddTrustRule: (String, String, String, String) -> Bool

    enum Phase: Equatable {
        case pending
        case decided(String)
        case pickingRule(String)
        case ruleSaved
    }

    @State private var phase: Phase = .pending
    @State private var selectedPattern: String = ""
    @State private var selectedScope: String = ""

    private var isHighRisk: Bool { riskLevel.lowercased() == "high" }

    private var hasRuleOptions: Bool {
        !allowlistOptions.isEmpty && !scopeOptions.isEmpty
    }

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

            // Phase-dependent content
            switch phase {
            case .pending:
                HStack(spacing: VSpacing.lg) {
                    Spacer()
                    VButton(label: "Deny", style: .ghost) {
                        guard onDeny() else { return }
                        if hasRuleOptions {
                            withAnimation(VAnimation.standard) { phase = .decided("deny") }
                        }
                    }
                    VButton(label: "Allow", style: isHighRisk ? .danger : .primary) {
                        guard onAllow() else { return }
                        if hasRuleOptions {
                            withAnimation(VAnimation.standard) { phase = .decided("allow") }
                        }
                    }
                }

            case .decided(let decision):
                decisionLabel(for: decision)

                HStack(spacing: VSpacing.md) {
                    Spacer()
                    VButton(label: "Done", style: .ghost) {
                        onDismiss()
                    }
                    VButton(
                        label: decision == "allow" ? "Add to Allowlist" : "Add to Denylist",
                        style: .ghost
                    ) {
                        if selectedPattern.isEmpty, let first = allowlistOptions.first {
                            selectedPattern = first.pattern
                        }
                        if selectedScope.isEmpty, let first = scopeOptions.first {
                            selectedScope = first.scope
                        }
                        withAnimation(VAnimation.standard) { phase = .pickingRule(decision) }
                    }
                }

            case .pickingRule(let decision):
                decisionLabel(for: decision)
                rulePickerView(decision: decision)

            case .ruleSaved:
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("Rule saved")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 420)
        .vPanelBackground()
    }

    @ViewBuilder
    private func decisionLabel(for decision: String) -> some View {
        if decision == "allow" {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(VColor.success)
                Text("Allowed")
                    .font(VFont.caption)
                    .foregroundColor(VColor.success)
            }
        } else {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(VColor.error)
                Text("Denied")
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }

    @ViewBuilder
    private func rulePickerView(decision: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if allowlistOptions.count > 1 {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Pattern")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Picker("", selection: $selectedPattern) {
                        ForEach(allowlistOptions, id: \.pattern) { option in
                            Text(option.label).tag(option.pattern)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            } else if let single = allowlistOptions.first {
                HStack(spacing: VSpacing.xs) {
                    Text("Pattern:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Text(single.label)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(VColor.textPrimary)
                }
            }

            if scopeOptions.count > 1 {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Scope")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Picker("", selection: $selectedScope) {
                        ForEach(scopeOptions, id: \.scope) { option in
                            Text(option.label).tag(option.scope)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            } else if let single = scopeOptions.first {
                HStack(spacing: VSpacing.xs) {
                    Text("Scope:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Text(single.label)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(VColor.textPrimary)
                }
            }

            HStack(spacing: VSpacing.md) {
                Spacer()
                VButton(label: "Cancel", style: .ghost) {
                    onDismiss()
                }
                VButton(label: "Save Rule", style: .primary) {
                    guard onAddTrustRule(toolName, selectedPattern, selectedScope, decision) else { return }
                    withAnimation(VAnimation.standard) { phase = .ruleSaved }
                }
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surface)
        .cornerRadius(VRadius.md)
    }
}
