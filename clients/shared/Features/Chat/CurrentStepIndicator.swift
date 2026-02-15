import SwiftUI

/// A simple indicator showing the current step being executed.
/// Clicking it opens the Activity sidebar with all step details.
public struct CurrentStepIndicator: View {
    public let toolCalls: [ToolCallData]
    public let isActivityPanelOpen: Bool
    public let onTap: () -> Void

    public init(toolCalls: [ToolCallData], isActivityPanelOpen: Bool = false, onTap: @escaping () -> Void) {
        self.toolCalls = toolCalls
        self.isActivityPanelOpen = isActivityPanelOpen
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

    public var body: some View {
        if let current = currentStep {
            HStack(spacing: VSpacing.sm) {
                // Spinner or checkmark
                if current.isComplete {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundColor(VColor.accent)
                } else {
                    ProgressView()
                        .scaleEffect(0.6)
                        .frame(width: 14, height: 14)
                }

                // Current step text
                Text(current.toolName)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                // Progress counter
                if totalCount > 1 {
                    Text("(\(completedCount)/\(totalCount))")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Spacer()

                // Chevron to indicate it's clickable
                Image(systemName: isActivityPanelOpen ? "chevron.left" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered ? VColor.surfaceBorder.opacity(0.5) : VColor.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
            .onHover { hovering in
                withAnimation(VAnimation.fast) {
                    isHovered = hovering
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                print("DEBUG: CurrentStepIndicator tapped")
                onTap()
            }
            .padding(.top, VSpacing.md)
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("CurrentStepIndicator") {
    ZStack {
        VColor.background.ignoresSafeArea()

        VStack(spacing: VSpacing.xl) {
            // In progress
            CurrentStepIndicator(
                toolCalls: [
                    ToolCallData(
                        toolName: "Web Search",
                        inputSummary: "flights from New York to London",
                        isComplete: true
                    ),
                    ToolCallData(
                        toolName: "Browser Navigate",
                        inputSummary: "https://google.com/flights",
                        isComplete: false
                    ),
                    ToolCallData(
                        toolName: "Browser Click",
                        inputSummary: "Departure field",
                        isComplete: false
                    )
                ],
                onTap: {}
            )

            // Single step
            CurrentStepIndicator(
                toolCalls: [
                    ToolCallData(
                        toolName: "Checking Navitime schedule for specific date",
                        inputSummary: "",
                        isComplete: false
                    )
                ],
                onTap: {}
            )

            // Completed
            CurrentStepIndicator(
                toolCalls: [
                    ToolCallData(
                        toolName: "Web Search",
                        inputSummary: "flights",
                        isComplete: true
                    ),
                    ToolCallData(
                        toolName: "Browser Navigate",
                        inputSummary: "url",
                        isComplete: true
                    )
                ],
                onTap: {}
            )
        }
        .padding(VSpacing.xl)
        .frame(width: 500)
    }
}
#endif
