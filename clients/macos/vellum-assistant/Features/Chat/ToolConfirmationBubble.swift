import SwiftUI

struct ToolConfirmationBubble: View {
    let confirmation: ToolConfirmationData
    let onAllow: () -> Void
    let onDeny: () -> Void

    private var isHighRisk: Bool { confirmation.riskLevel.lowercased() == "high" }

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

            case .approved:
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("Allowed")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }

            case .denied:
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                    Text("Denied")
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
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
}

#if DEBUG
#Preview("ToolConfirmationBubble") {
    VStack(spacing: VSpacing.lg) {
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-1",
                toolName: "bash",
                riskLevel: "medium",
                diff: nil
            ),
            onAllow: {},
            onDeny: {}
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
            onDeny: {}
        )
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-3",
                toolName: "bash",
                riskLevel: "medium",
                diff: nil,
                state: .approved
            ),
            onAllow: {},
            onDeny: {}
        )
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
}
#endif
