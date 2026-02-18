import SwiftUI
import VellumAssistantShared

/// Inline expandable list of tool calls shown after an assistant message completes.
/// Replaces the former Activity Panel side panel with a self-contained in-chat view.
struct UsedToolsList: View {
    let toolCalls: [ToolCallData]

    @State private var isListExpanded = false

    private var hasErrors: Bool { toolCalls.contains { $0.isError } }

    private var headerLabel: String {
        let count = toolCalls.count
        if count == 1 {
            return toolCalls[0].actionDescription
        }
        if hasErrors {
            let errCount = toolCalls.filter { $0.isError }.count
            return errCount == count
                ? "All \(count) steps failed"
                : "\(errCount) of \(count) steps failed"
        }
        return "Completed \(count) steps"
    }

    private var headerIcon: String {
        hasErrors ? "xmark.circle.fill" : "checkmark.circle.fill"
    }

    private var headerIconColor: Color {
        hasErrors ? VColor.error : VColor.success
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Header row (always visible) ──────────────────────────
            Button {
                withAnimation(VAnimation.fast) { isListExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: headerIcon)
                        .font(.system(size: 13))
                        .foregroundColor(headerIconColor)

                    Text(headerLabel)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)

                    Spacer()

                    Image(systemName: isListExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
            }
            .buttonStyle(.plain)

            // ── Expanded rows ─────────────────────────────────────────
            if isListExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    Divider().padding(.horizontal, VSpacing.sm)

                    ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                        UsedToolsRow(toolCall: toolCall)

                        if index < toolCalls.count - 1 {
                            Divider()
                                .padding(.leading, 44) // align with text after icon
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(hasErrors ? VColor.error.opacity(0.3) : VColor.surfaceBorder, lineWidth: 0.5)
        )
        .frame(maxWidth: 520, alignment: .leading)
        .padding(.top, VSpacing.xxs)
    }
}

// MARK: - Individual row

private struct UsedToolsRow: View {
    let toolCall: ToolCallData

    @State private var isExpanded = false
    @State private var isHovered = false

    private var hasDetails: Bool {
        (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true)) || toolCall.cachedImage != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row header
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Status icon with colored background
                    ZStack {
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(toolCall.isError ? VColor.error : VColor.success)
                            .frame(width: 22, height: 22)

                        Image(systemName: toolCall.isError ? "xmark" : "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.white)
                    }

                    // Human-readable action description
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(toolCall.actionDescription)
                            .font(VFont.captionMedium)
                            .foregroundColor(toolCall.isError ? VColor.error : VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if let started = toolCall.startedAt, let completed = toolCall.completedAt {
                            Text(formatDuration(completed.timeIntervalSince(started)))
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                        }
                    }

                    Spacer()

                    if hasDetails {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(isHovered && hasDetails ? VColor.surfaceBorder.opacity(0.3) : .clear)
            .onHover { isHovered = $0 }

            // Expanded detail section
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    // Technical info
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Technical details")
                            .font(VFont.small)
                            .foregroundColor(VColor.textMuted)
                            .textCase(.uppercase)

                        HStack(spacing: VSpacing.xs) {
                            Text(toolCall.friendlyName)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                            if !toolCall.inputSummary.isEmpty {
                                Text("·")
                                    .foregroundColor(VColor.textMuted)
                                Text(toolCall.inputSummary)
                                    .font(VFont.monoSmall)
                                    .foregroundColor(VColor.textSecondary)
                                    .textSelection(.enabled)
                                    .lineLimit(3)
                            }
                        }
                    }
                    .padding(.horizontal, VSpacing.md)

                    // Screenshot
                    if let img = toolCall.cachedImage {
                        Image(nsImage: img)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .padding(.horizontal, VSpacing.md)
                    }

                    // Output
                    if let result = toolCall.result, !result.isEmpty {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Output")
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                                .textCase(.uppercase)

                            ZStack(alignment: .topTrailing) {
                                ScrollView {
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(Array(result.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                            Text(line)
                                                .font(VFont.monoSmall)
                                                .foregroundColor(diffLineColor(line))
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                    }
                                    .textSelection(.enabled)
                                }
                                .frame(maxHeight: 200)
                                .padding(VSpacing.sm)
                                .background(VColor.background.opacity(0.6))
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .overlay(
                                    RoundedRectangle(cornerRadius: VRadius.sm)
                                        .stroke(VColor.surfaceBorder, lineWidth: 0.5)
                                )

                                Button {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(result, forType: .string)
                                } label: {
                                    Image(systemName: "doc.on.doc")
                                        .font(.system(size: 10, weight: .medium))
                                        .foregroundColor(VColor.textMuted)
                                        .frame(width: 24, height: 24)
                                        .background(VColor.backgroundSubtle)
                                        .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                                }
                                .buttonStyle(.plain)
                                .padding(VSpacing.xs)
                                .accessibilityLabel("Copy output")
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                    }
                }
                .padding(.bottom, VSpacing.sm)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(VAnimation.fast, value: isExpanded)
    }

    private var resultIsDiff: Bool {
        guard let r = toolCall.result else { return false }
        return r.contains("@@") && r.contains("---") && r.contains("+++")
    }

    private func diffLineColor(_ line: String) -> Color {
        if toolCall.isError { return VColor.error }
        guard resultIsDiff else { return VColor.textSecondary }
        if line.hasPrefix("+") { return Emerald._400 }
        if line.hasPrefix("-") { return Rose._400 }
        if line.hasPrefix("@@") { return VColor.textMuted }
        return VColor.textSecondary
    }

    private func formatDuration(_ s: TimeInterval) -> String {
        s < 60
            ? String(format: "%.1fs", s)
            : "\(Int(s) / 60)m \(Int(s) % 60)s"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("UsedToolsList") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            UsedToolsList(toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls -la /Users/test", result: "total 42\ndrwxr-xr-x  10 user staff 320", isComplete: true, startedAt: Date().addingTimeInterval(-1.4), completedAt: Date()),
                ToolCallData(toolName: "file_read", inputSummary: "/src/Config.swift", result: "import Foundation\n\nstruct Config { }", isComplete: true, startedAt: Date().addingTimeInterval(-0.9), completedAt: Date()),
                ToolCallData(toolName: "file_edit", inputSummary: "/src/Config.swift", result: "", isComplete: true, startedAt: Date().addingTimeInterval(-0.4), completedAt: Date())
            ])

            UsedToolsList(toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "rm -rf /important", result: "Permission denied", isError: true, isComplete: true, startedAt: Date().addingTimeInterval(-0.5), completedAt: Date()),
                ToolCallData(toolName: "file_read", inputSummary: "/etc/hosts", result: "127.0.0.1 localhost", isComplete: true, startedAt: Date().addingTimeInterval(-0.2), completedAt: Date())
            ])
        }
        .padding(VSpacing.xl)
        .frame(width: 560)
    }
}
#endif
