import SwiftUI

struct ToolConfirmationBubble: View {
    let confirmation: ToolConfirmationData
    let onAllow: () -> Void
    let onDeny: () -> Void
    let onAddTrustRule: (String, String, String, String) -> Bool

    @State private var showRulePicker = false
    @State private var selectedPattern: String = ""
    @State private var selectedScope: String = ""
    @State private var ruleSaved = false

    private var isHighRisk: Bool { confirmation.riskLevel.lowercased() == "high" }

    private var hasRuleOptions: Bool {
        !confirmation.allowlistOptions.isEmpty && !confirmation.scopeOptions.isEmpty
    }

    private var toolDisplayName: String {
        switch confirmation.toolName {
        case "file_write": return "Write File"
        case "file_edit": return "Edit File"
        case "bash": return "Run Command"
        case "web_fetch": return "Fetch URL"
        default: return confirmation.toolName.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Header row: icon + tool name + risk badge
            HStack(spacing: VSpacing.sm) {
                Image(systemName: isHighRisk ? "exclamationmark.triangle.fill" : "shield.checkered")
                    .font(.system(size: 14))
                    .foregroundStyle(isHighRisk ? VColor.error : VColor.warning)

                Text(toolDisplayName)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)

                Text(confirmation.riskLevel.lowercased())
                    .font(VFont.caption)
                    .foregroundColor(isHighRisk ? VColor.error : VColor.warning)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill((isHighRisk ? VColor.error : VColor.warning).opacity(0.15))
                    )

                Spacer()
            }

            // Diff preview (if present)
            if let diff = confirmation.diff {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(diff.filePath)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if diff.isNewFile {
                        Text("New file")
                            .font(VFont.caption)
                            .foregroundColor(VColor.success)
                    }

                    ScrollView {
                        Text(String(diff.newContent.prefix(500)))
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 120)
                    .padding(VSpacing.sm)
                    .background(VColor.backgroundSubtle)
                    .cornerRadius(VRadius.md)
                }
            }

            // Action buttons or decided state
            switch confirmation.state {
            case .pending:
                HStack(spacing: VSpacing.md) {
                    Spacer()
                    VButton(label: "Deny", style: .ghost) {
                        onDeny()
                    }
                    VButton(label: "Allow", style: isHighRisk ? .danger : .primary) {
                        onAllow()
                    }
                }

            case .approved, .denied:
                decisionLabel

                if hasRuleOptions && !ruleSaved {
                    if showRulePicker {
                        rulePickerView
                    } else {
                        HStack {
                            Spacer()
                            VButton(
                                label: confirmation.state == .approved ? "Add to Allowlist" : "Add to Denylist",
                                style: .ghost
                            ) {
                                if selectedPattern.isEmpty, let first = confirmation.allowlistOptions.first {
                                    selectedPattern = first.pattern
                                }
                                if selectedScope.isEmpty, let first = confirmation.scopeOptions.first {
                                    selectedScope = first.scope
                                }
                                withAnimation(VAnimation.standard) {
                                    showRulePicker = true
                                }
                            }
                        }
                    }
                }

                if ruleSaved {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                        Text("Rule saved")
                            .font(VFont.caption)
                            .foregroundColor(VColor.success)
                    }
                    .transition(.opacity)
                }

            case .timedOut:
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                    Text("Timed out")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(isHighRisk ? VColor.error.opacity(0.4) : VColor.warning.opacity(0.4), lineWidth: 1)
                )
        )
        .frame(maxWidth: 520)
    }

    @ViewBuilder
    private var decisionLabel: some View {
        if confirmation.state == .approved {
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
    private var rulePickerView: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Pattern picker
            if confirmation.allowlistOptions.count > 1 {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Pattern")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Picker("", selection: $selectedPattern) {
                        ForEach(confirmation.allowlistOptions, id: \.pattern) { option in
                            Text(option.label).tag(option.pattern)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            } else if let single = confirmation.allowlistOptions.first {
                HStack(spacing: VSpacing.xs) {
                    Text("Pattern:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Text(single.label)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textPrimary)
                }
            }

            // Scope picker
            if confirmation.scopeOptions.count > 1 {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Scope")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Picker("", selection: $selectedScope) {
                        ForEach(confirmation.scopeOptions, id: \.scope) { option in
                            Text(option.label).tag(option.scope)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            } else if let single = confirmation.scopeOptions.first {
                HStack(spacing: VSpacing.xs) {
                    Text("Scope:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Text(single.label)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textPrimary)
                }
            }

            // Save / Cancel
            HStack(spacing: VSpacing.md) {
                Spacer()
                VButton(label: "Cancel", style: .ghost) {
                    withAnimation(VAnimation.standard) {
                        showRulePicker = false
                    }
                }
                VButton(label: "Save Rule", style: .primary) {
                    let ruleDecision = confirmation.state == .approved ? "allow" : "deny"
                    guard onAddTrustRule(confirmation.toolName, selectedPattern, selectedScope, ruleDecision) else { return }
                    withAnimation(VAnimation.standard) {
                        showRulePicker = false
                        ruleSaved = true
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .background(VColor.backgroundSubtle)
        .cornerRadius(VRadius.md)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

#if DEBUG
#Preview("ToolConfirmationBubble") {
    VStack(spacing: VSpacing.lg) {
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-1",
                toolName: "bash",
                riskLevel: "medium",
                diff: nil,
                allowlistOptions: [
                    .init(label: "git push", description: "This exact command", pattern: "git push"),
                    .init(label: "git *", description: "Any git command", pattern: "git *"),
                ],
                scopeOptions: [
                    .init(label: "This project", scope: "/Users/test/project"),
                    .init(label: "Everywhere", scope: "everywhere"),
                ]
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-2",
                toolName: "file_write",
                riskLevel: "high",
                diff: ConfirmationRequestMessage.ConfirmationDiffInfo(
                    filePath: "/Users/test/project/src/main.swift",
                    oldContent: "",
                    newContent: "import Foundation\n\nfunc hello() {\n    print(\"Hello, World!\")\n}",
                    isNewFile: true
                )
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-3",
                toolName: "bash",
                riskLevel: "medium",
                diff: nil,
                allowlistOptions: [
                    .init(label: "npm install", description: "This exact command", pattern: "npm install"),
                ],
                scopeOptions: [
                    .init(label: "Everywhere", scope: "everywhere"),
                ],
                state: .approved
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
}
#endif
