import os
import SwiftUI

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "CurrentStepIndicator"
)

/// A simple indicator showing the current step being executed.
/// Clicking it opens the Activity sidebar with all step details.
public struct CurrentStepIndicator: View {
    public let toolCalls: [ToolCallData]
    public let isStreaming: Bool
    public let onTap: () -> Void

    public init(toolCalls: [ToolCallData], isActivityPanelOpen: Bool = false, isStreaming: Bool = false, onTap: @escaping () -> Void) {
        self.toolCalls = toolCalls
        self.isStreaming = isStreaming
        self.onTap = onTap
    }

    private var currentStep: ToolCallData? {
        // Find the first incomplete step, or the last step if all are complete
        toolCalls.first(where: { !$0.isComplete }) ?? toolCalls.last
    }

    private var completedCount: Int {
        toolCalls.filter { $0.isComplete }.count
    }

    private var totalCount: Int {
        toolCalls.count
    }

    @State private var isHovered = false
    @State private var pulseOpacity: Double = 1.0

    private var isLoading: Bool {
        // Show loading state if streaming OR if there are incomplete tools
        isStreaming || !toolCalls.allSatisfy { $0.isComplete }
    }

    public var body: some View {
        // Show indicator when streaming OR when there are tool calls
        if isStreaming || currentStep != nil {
            let current = currentStep

            HStack(spacing: VSpacing.sm) {
                // Spinner or checkmark
                if let current = current, current.isComplete {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.primaryBase)
                } else {
                    ProgressView()
                        .scaleEffect(0.7)
                        .frame(width: 16, height: 16)
                        .tint(VColor.primaryBase)
                }

                // Current step text with loading indicator
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    HStack(spacing: VSpacing.xs) {
                        // Show tool name if available, otherwise show generic "Thinking..."
                        Text(current?.friendlyName ?? "Thinking...")
                            .font(VFont.bodyMediumDefault)
                            .foregroundColor(VColor.contentDefault)

                        // Progress counter inline with title
                        if totalCount > 1 {
                            Text("(\(completedCount)/\(totalCount))")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }

                    if isLoading {
                        Text("Working...")
                            .font(VFont.labelSmall)
                            .foregroundColor(VColor.primaryBase)
                            .opacity(pulseOpacity)
                    }
                }

                Spacer()

                // Chevron to indicate it's clickable
                VIconView(.chevronRight, size: 10)
                    .foregroundColor(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered ? VColor.borderBase.opacity(0.5) : VColor.surfaceOverlay)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isLoading ? VColor.primaryBase.opacity(0.5) : VColor.borderBase, lineWidth: isLoading ? 1.5 : 1)
            )
            .onHover { hovering in
                withAnimation(VAnimation.fast) {
                    isHovered = hovering
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                log.debug("CurrentStepIndicator tapped")
                onTap()
            }
            .padding(.top, VSpacing.md)
            .onAppear {
                if isLoading {
                    startPulseAnimation()
                }
            }
            .onChange(of: isLoading) { _, newValue in
                if newValue {
                    startPulseAnimation()
                }
            }
        }
    }

    private func startPulseAnimation() {
        withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
            pulseOpacity = 0.4
        }
    }
}
