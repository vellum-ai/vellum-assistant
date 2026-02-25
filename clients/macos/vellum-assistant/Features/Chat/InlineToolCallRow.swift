import SwiftUI
import VellumAssistantShared

/// A compact, expandable row for a single tool call rendered inline between text blocks.
/// Styled like Kimi: pill-shaped bar with tool icon + label + down-chevron.
/// Running state shows a spinner; completed state shows the tool icon.
struct InlineToolCallRow: View {
    let toolCall: ToolCallData

    @State private var isExpanded = false
    @State private var isHovered = false
    @State private var isImageHovered = false
    @Environment(\.displayScale) private var displayScale

    private var isRunning: Bool { !toolCall.isComplete }
    private var isFailed: Bool { toolCall.isComplete && toolCall.isError }

    private var hasDetails: Bool {
        toolCall.isComplete && (
            !toolCall.inputFull.isEmpty ||
            (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true)) ||
            toolCall.cachedImage != nil ||
            !toolCall.claudeCodeSteps.isEmpty
        )
    }

    /// Label text for the current state.
    private var label: String {
        if isRunning {
            return ChatBubble.friendlyRunningLabel(toolCall.toolName, inputSummary: toolCall.inputSummary, buildingStatus: toolCall.buildingStatus)
        }
        if isFailed {
            return "Failed to \(toolCall.friendlyName.lowercased())"
        }
        return toolCall.actionDescription
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Compact pill row
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Icon: spinner when running, tool icon when done
                    if isRunning {
                        ProgressView()
                            .controlSize(.mini)
                            .scaleEffect(0.8)
                            .frame(width: 16, height: 16)
                    } else {
                        Image(systemName: toolCall.toolIcon)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(isFailed ? VColor.textMuted : VColor.textSecondary)
                            .frame(width: 16, height: 16)
                    }

                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Spacer()

                    // Chevron: down when expandable (Kimi style)
                    if hasDetails || isRunning {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .rotationEffect(.degrees(isExpanded ? -180 : 0))
                            .animation(VAnimation.fast, value: isExpanded)
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm + 2)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(isHovered && hasDetails ? VColor.surface : VColor.surface.opacity(0.7))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder.opacity(0.6), lineWidth: 0.5)
                )
                .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
            }
            .buttonStyle(.plain)
            .onHover { isHovered = $0 }

            // Expanded details
            if isExpanded {
                expandedDetails
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(VAnimation.fast, value: isExpanded)
    }

    // MARK: - Expanded Details

    @ViewBuilder
    private var expandedDetails: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
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

            // Claude Code sub-steps
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
            }

            // Screenshot
            if let img = toolCall.cachedImage,
               let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                Image(decorative: cgImage, scale: displayScale)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
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
                                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
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
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface.opacity(0.3))
        )
    }

    // MARK: - Helpers

    private func openImageInPreview(_ image: NSImage) {
        let path = toolCall.inputRawValue
        if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
            let url = URL(fileURLWithPath: path)
            let previewURL = URL(fileURLWithPath: "/System/Applications/Preview.app")
            NSWorkspace.shared.open([url], withApplicationAt: previewURL, configuration: NSWorkspace.OpenConfiguration())
            return
        }
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-preview-\(UUID().uuidString).png")
        do {
            try png.write(to: tempURL)
            let previewURL = URL(fileURLWithPath: "/System/Applications/Preview.app")
            NSWorkspace.shared.open([tempURL], withApplicationAt: previewURL, configuration: NSWorkspace.OpenConfiguration())
        } catch {}
    }
}

// MARK: - Preview

#if DEBUG
#Preview("InlineToolCallRow") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Completed
            InlineToolCallRow(toolCall: ToolCallData(
                toolName: "file_read",
                inputSummary: "/src/Config.swift",
                result: "import Foundation\n\nstruct Config { }",
                isComplete: true,
                startedAt: Date().addingTimeInterval(-0.9),
                completedAt: Date()
            ))

            // Running
            InlineToolCallRow(toolCall: ToolCallData(
                toolName: "web_fetch",
                inputSummary: "https://docs.openclaw.ai",
                result: nil,
                isComplete: false
            ))

            // Failed
            InlineToolCallRow(toolCall: ToolCallData(
                toolName: "web_fetch",
                inputSummary: "https://alaskaair.com",
                result: "Connection refused",
                isError: true,
                isComplete: true,
                startedAt: Date().addingTimeInterval(-0.5),
                completedAt: Date()
            ))
        }
        .padding(VSpacing.xl)
        .frame(width: 520)
    }
}
#endif
