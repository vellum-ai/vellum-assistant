import SwiftUI

/// A horizontal progress bar that displays tool calls as clickable steps.
/// Each step can be expanded to show details like results and screenshots.
public struct ToolCallProgressBar: View {
    public let toolCalls: [ToolCallData]
    @State private var expandedStepId: UUID?
    /// Cached line count for the expanded tool call's result text — avoids O(n)
    /// byte scan on every SwiftUI render pass when a step is expanded.
    @State private var cachedResultLineCount: Int?

    public init(toolCalls: [ToolCallData]) {
        self.toolCalls = toolCalls
    }

    /// The most relevant tool call to label: the first incomplete one, or the
    /// last one if all are complete (same heuristic as CurrentStepIndicator).
    private var representativeToolCall: ToolCallData? {
        toolCalls.first(where: { !$0.isComplete }) ?? toolCalls.last
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Progress bar with steps
            VStack(spacing: VSpacing.xs) {
                // Icons and lines row
                HStack(spacing: 0) {
                    ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                        // Step circle
                        stepCircle(for: toolCall, index: index)

                        // Connector line (skip for last item)
                        if index < toolCalls.count - 1 {
                            connectorLine(isComplete: toolCall.isComplete)
                        }
                    }
                }

                // Summary label — shows the active/last tool name + progress count.
                // Replaces per-step fixed-width labels that truncated on narrow
                // iOS screens (LUM-1026).
                if let representative = representativeToolCall {
                    HStack(spacing: VSpacing.xs) {
                        Text(representative.friendlyName)
                            .font(VFont.labelSmall)
                            .foregroundStyle(stepTextColor(for: representative))
                            .lineLimit(1)

                        if toolCalls.count > 1 {
                            let completedCount = toolCalls.filter(\.isComplete).count
                            Text("(\(completedCount)/\(toolCalls.count))")
                                .font(VFont.labelSmall)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                }
            }
            .padding(.top, VSpacing.md)

            // Expanded details (shown when a step is clicked)
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }) {
                expandedDetails(for: expandedCall)
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.95).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
        }
    }

    // MARK: - Step Circle

    @ViewBuilder
    private func stepCircle(for toolCall: ToolCallData, index: Int) -> some View {
        Button {
            withAnimation(VAnimation.fast) {
                // Toggle expansion when clicked
                if expandedStepId == toolCall.id {
                    expandedStepId = nil
                } else if toolCall.isComplete {
                    cachedResultLineCount = nil
                    expandedStepId = toolCall.id
                }
            }
        } label: {
            ZStack {
                if toolCall.isComplete {
                    // Filled circle for completed steps
                    Circle()
                        .fill(toolCall.isError ? VColor.systemNegativeStrong : VColor.primaryBase)
                        .frame(width: 20, height: 20)

                    if toolCall.isError {
                        // Error icon
                        VIconView(.x, size: 8)
                            .foregroundStyle(VColor.auxWhite)
                    } else {
                        // Checkmark
                        VIconView(.check, size: 8)
                            .foregroundStyle(VColor.auxWhite)
                    }
                } else {
                    // Outlined circle for in-progress
                    Circle()
                        .strokeBorder(VColor.primaryBase, lineWidth: 2)
                        .frame(width: 20, height: 20)

                    // Loading spinner inside
                    ProgressView()
                        .scaleEffect(0.35)
                        .tint(VColor.primaryBase)
                        .frame(width: 20, height: 20)
                }
            }
            .frame(width: 20, height: 20)
        }
        .frame(minWidth: 28, minHeight: 28)
        .contentShape(Circle())
        .buttonStyle(.plain)
        .disabled(!toolCall.isComplete)
        .accessibilityLabel(toolCall.isError ? "\(toolCall.friendlyName), failed" : toolCall.isComplete ? "\(toolCall.friendlyName), completed" : "\(toolCall.friendlyName), in progress")
    }

    // MARK: - Connector Line

    private func connectorLine(isComplete: Bool) -> some View {
        Rectangle()
            .fill(VColor.borderBase)
            .frame(width: 32, height: 2)
    }

    // MARK: - Expanded Details

    @ViewBuilder
    private func expandedDetails(for toolCall: ToolCallData) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header
            HStack {
                VIconView(.terminal, size: 12)
                    .foregroundStyle(toolCall.isError ? VColor.systemNegativeStrong : VColor.primaryBase)

                Text(toolCall.friendlyName)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                Button {
                    withAnimation(VAnimation.fast) {
                        expandedStepId = nil
                    }
                } label: {
                    VIconView(.x, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close details")
            }

            // Input summary
            if !toolCall.inputSummary.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Input")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    Text(toolCall.inputSummary)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                }
            }

            // Screenshots / generated images
            ForEach(Array(toolCall.cachedImages.enumerated()), id: \.offset) { _, cachedImage in
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Image")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    #if os(macOS)
                    HStack(spacing: 0) {
                        Image(nsImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        Spacer(minLength: 0)
                    }
                    #elseif os(iOS)
                    HStack(spacing: 0) {
                        Image(uiImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        Spacer(minLength: 0)
                    }
                    #endif
                }
            }

            // Result
            if let result = toolCall.result {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Result")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    if let exitCode = ToolCallChip.parseExitCode(from: result) {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            HStack(spacing: VSpacing.xs) {
                                VIconView(.triangleAlert, size: 11)
                                    .foregroundStyle(VColor.systemNegativeStrong)
                                Text("Exit code \(exitCode)")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.systemNegativeStrong)
                            }
                            if let explanation = ToolCallChip.exitCodeExplanation(exitCode) {
                                Text(explanation)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            let extraOutput = result
                                .replacingOccurrences(of: #"<command_exit code="\d+" />"#, with: "", options: .regularExpression)
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !extraOutput.isEmpty {
                                Text(extraOutput)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                            }
                        }
                    } else if result == "<command_completed />" {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 11)
                                .foregroundStyle(VColor.primaryBase)
                            Text("Command completed successfully (no output).")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    } else {
                        ScrollView {
                            HStack(spacing: 0) {
                                Text(result)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                                Spacer(minLength: 0)
                            }
                        }
                        .adaptiveScrollFrame(for: result, maxHeight: 200, lineThreshold: 12, lineCount: cachedResultLineCount)
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .onAppear {
            if cachedResultLineCount == nil,
               let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            }
        }
        .onChange(of: expandedStepId) {
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            } else {
                cachedResultLineCount = nil
            }
        }
        .onChange(of: toolCalls.first(where: { $0.id == expandedStepId })?.resultLength) {
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            } else {
                cachedResultLineCount = nil
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Colors

    private func stepBackgroundColor(for toolCall: ToolCallData) -> Color {
        if toolCall.isError {
            return VColor.systemNegativeStrong
        } else if !toolCall.isComplete {
            return VColor.primaryBase
        } else {
            return VColor.primaryBase
        }
    }

    private func stepBorderColor(for toolCall: ToolCallData) -> Color {
        if toolCall.isError {
            return VColor.systemNegativeStrong
        } else if !toolCall.isComplete {
            return VColor.primaryBase.opacity(0.5)
        } else {
            return VColor.primaryBase.opacity(0.8)
        }
    }

    private func stepTextColor(for toolCall: ToolCallData) -> Color {
        if toolCall.isError {
            return VColor.systemNegativeStrong
        } else if !toolCall.isComplete {
            return VColor.contentSecondary
        } else {
            return VColor.contentDefault
        }
    }
}
