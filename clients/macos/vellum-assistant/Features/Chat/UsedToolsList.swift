import SwiftUI
import VellumAssistantShared

/// Compact pill button shown after an assistant message completes tool calls.
/// `isExpanded` is owned by the parent so that the steps list can be rendered
/// in a separate row below all sibling pills (e.g. the permission chip).
struct UsedToolsList: View {
    let toolCalls: [ToolCallData]
    @Binding var isExpanded: Bool

    @State private var isHovered = false

    private var pillLabel: String {
        let count = toolCalls.count
        if count == 1 { return toolCalls[0].actionDescription }
        return "Completed \(count) steps"
    }

    private var pillIcon: String { "checkmark.circle.fill" }

    private var pillIconColor: Color { VColor.success }

    var body: some View {
        Button {
            withAnimation(VAnimation.fast) { isExpanded.toggle() }
        } label: {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: pillIcon)
                    .font(.system(size: 10))
                    .foregroundColor(pillIconColor)

                Text(pillLabel)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)

                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .animation(VAnimation.fast, value: isExpanded)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isHovered ? VColor.backgroundSubtle.opacity(0.6) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .buttonStyle(.plain)
        .fixedSize()
        .onHover { isHovered = $0 }
    }
}

// MARK: - Inline steps section (rendered in a separate row by the parent)

struct StepsSection: View {
    let toolCalls: [ToolCallData]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                UsedToolsRow(toolCall: toolCall)

                if index < toolCalls.count - 1 {
                    Divider()
                        .padding(.leading, 44)
                }
            }
        }
        .padding(.top, VSpacing.xs)
    }
}

// MARK: - Individual row

private struct UsedToolsRow: View {
    let toolCall: ToolCallData

    @State private var isExpanded = false
    @State private var isHovered = false
    @State private var isImageHovered = false
    @Environment(\.displayScale) private var displayScale

    private var hasDetails: Bool {
        !toolCall.inputFull.isEmpty ||
        (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true)) ||
        toolCall.cachedImage != nil ||
        !toolCall.claudeCodeSteps.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row header
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Colored status icon
                    ZStack {
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(toolCall.isError ? VColor.error : VColor.success)
                            .frame(width: 22, height: 22)

                        Image(systemName: toolCall.isError ? "xmark" : "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.white)
                    }

                    // Human-readable title + optional duration
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
                    Divider().padding(.horizontal, VSpacing.sm)

                    // Technical details
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Technical details")
                            .font(VFont.small)
                            .foregroundColor(VColor.textMuted)
                            .textCase(.uppercase)

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text(toolCall.friendlyName)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                            if !toolCall.inputFull.isEmpty {
                                Text(toolCall.inputFull)
                                    .font(VFont.monoSmall)
                                    .foregroundColor(VColor.textSecondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.horizontal, VSpacing.md)

                    // Claude Code sub-steps (if any)
                    if !toolCall.claudeCodeSteps.isEmpty {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Sub-steps")
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                                .textCase(.uppercase)

                            ClaudeCodeProgressView(
                                steps: toolCall.claudeCodeSteps,
                                isRunning: false
                            )
                        }
                        .padding(.horizontal, VSpacing.md)
                    }

                    // Screenshot — use CGImage + displayScale for pixel-perfect Retina rendering
                    if let img = toolCall.cachedImage,
                       let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                        Image(decorative: cgImage, scale: displayScale)
                            .resizable()
                            .interpolation(.high)
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .padding(.horizontal, VSpacing.md)
                            .onTapGesture(count: 2) { openImageInPreview(img) }
                            .onHover { hovering in
                                if hovering { NSCursor.pointingHand.push() }
                                else { NSCursor.pop() }
                                isImageHovered = hovering
                            }
                            .onDisappear { if isImageHovered { NSCursor.pop(); isImageHovered = false } }
                    } else if let img = toolCall.cachedImage {
                        Image(nsImage: img)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .padding(.horizontal, VSpacing.md)
                            .onTapGesture(count: 2) { openImageInPreview(img) }
                            .onHover { hovering in
                                if hovering { NSCursor.pointingHand.push() }
                                else { NSCursor.pop() }
                                isImageHovered = hovering
                            }
                            .onDisappear { if isImageHovered { NSCursor.pop(); isImageHovered = false } }
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
                                                .foregroundColor(diffLineColor(line, result: result, isError: toolCall.isError))
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

    /// Open the image in Preview.app. Tries the original file path first; falls
    /// back to writing the NSImage to a temp file when the path is unavailable.
    private func openImageInPreview(_ image: NSImage) {
        // Try opening the original file if inputFull points to a real file
        let path = toolCall.inputFull.components(separatedBy: "\n").first ?? ""
        if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
            openInPreview(URL(fileURLWithPath: path))
            return
        }
        // Fallback: write cached image to a temp file and open it
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-preview-\(UUID().uuidString).png")
        do {
            try png.write(to: tempURL)
            openInPreview(tempURL)
        } catch {
            // Not critical — silently fail
        }
    }

    private func openInPreview(_ url: URL) {
        let previewURL = URL(fileURLWithPath: "/System/Applications/Preview.app")
        NSWorkspace.shared.open(
            [url],
            withApplicationAt: previewURL,
            configuration: NSWorkspace.OpenConfiguration()
        )
    }

    private func diffLineColor(_ line: String, result: String, isError: Bool) -> Color {
        if isError { return VColor.error }
        let isDiff = result.contains("@@") && result.contains("---") && result.contains("+++")
        guard isDiff else { return VColor.textSecondary }
        if line.hasPrefix("+") { return Emerald._400 }
        if line.hasPrefix("-") { return Danger._400 }
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
private struct UsedToolsListPreview: View {
    @State private var expanded1 = false
    @State private var expanded2 = false
    let toolCalls1 = [
        ToolCallData(toolName: "bash", inputSummary: "ls -la /Users/test", result: "total 42\ndrwxr-xr-x  10 user staff 320", isComplete: true, startedAt: Date().addingTimeInterval(-1.4), completedAt: Date()),
        ToolCallData(toolName: "file_read", inputSummary: "/src/Config.swift", result: "import Foundation\n\nstruct Config { }", isComplete: true, startedAt: Date().addingTimeInterval(-0.9), completedAt: Date()),
        ToolCallData(toolName: "file_edit", inputSummary: "/src/Config.swift", result: "", isComplete: true, startedAt: Date().addingTimeInterval(-0.4), completedAt: Date())
    ]
    let toolCalls2 = [
        ToolCallData(toolName: "bash", inputSummary: "rm -rf /important", result: "Permission denied", isError: true, isComplete: true, startedAt: Date().addingTimeInterval(-0.5), completedAt: Date())
    ]
    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack { UsedToolsList(toolCalls: toolCalls1, isExpanded: $expanded1); Spacer() }
                    if expanded1 { StepsSection(toolCalls: toolCalls1) }
                }
                VStack(alignment: .leading, spacing: 0) {
                    HStack { UsedToolsList(toolCalls: toolCalls2, isExpanded: $expanded2); Spacer() }
                    if expanded2 { StepsSection(toolCalls: toolCalls2) }
                }
            }
            .padding(VSpacing.xl)
            .frame(width: 560)
        }
    }
}

#Preview("UsedToolsList") { UsedToolsListPreview() }
#endif
