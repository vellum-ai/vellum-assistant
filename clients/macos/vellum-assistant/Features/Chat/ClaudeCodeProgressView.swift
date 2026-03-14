import SwiftUI
import VellumAssistantShared

struct ClaudeCodeProgressView: View {
    let steps: [ClaudeCodeSubStep]
    let isRunning: Bool

    @State private var isExpanded: Bool = true
    @State private var userHasToggled: Bool = false

    // Show only the last 8 steps to keep the view manageable
    private var visibleSteps: [ClaudeCodeSubStep] {
        if steps.count <= 8 { return steps }
        return Array(steps.suffix(8))
    }

    private var completedCount: Int {
        steps.filter { $0.isComplete }.count
    }

    private var currentStep: ClaudeCodeSubStep? {
        steps.last(where: { !$0.isComplete }) ?? steps.last
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header button
            Button(action: {
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                    userHasToggled = true
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    // Status indicator
                    if isRunning {
                        // Pulsing dot for running state
                        Circle()
                            .fill(VColor.primaryBase)
                            .frame(width: 8, height: 8)
                            .modifier(PulsingModifier())
                    } else {
                        VIconView(.circleCheck, size: 12)
                            .foregroundColor(VColor.systemPositiveStrong)
                    }

                    // Label
                    if isRunning, let current = currentStep {
                        Text(current.friendlyName)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        if !current.inputSummary.isEmpty {
                            Text(abbreviatePath(current.inputSummary))
                                .font(VFont.monoSmall)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                        }
                    } else {
                        Text("Completed \(completedCount) step\(completedCount == 1 ? "" : "s")")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }

                    Spacer()

                    // Chevron
                    VIconView(.chevronRight, size: 9)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)

            // Expanded step list
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    ForEach(visibleSteps) { step in
                        HStack(spacing: VSpacing.sm) {
                            // Tool icon + name
                            VIconView(step.toolIcon, size: 10)
                                .foregroundColor(VColor.contentTertiary)
                                .frame(width: 14)

                            Text(step.friendlyName)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentSecondary)

                            // Input summary
                            if !step.inputSummary.isEmpty {
                                Text(abbreviatePath(step.inputSummary))
                                    .font(VFont.monoSmall)
                                    .foregroundColor(VColor.contentTertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }

                            Spacer()
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                    }

                    if steps.count > 8 {
                        Text("+ \(steps.count - 8) earlier steps")
                            .font(VFont.small)
                            .foregroundColor(VColor.contentTertiary)
                            .padding(.horizontal, VSpacing.sm)
                    }
                }
                .padding(.bottom, VSpacing.xs)
            }
        }
        .background(VColor.surfaceBase.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onChange(of: isRunning) { _, newValue in
            // Auto-collapse when done, unless the user has manually toggled
            if !newValue && !userHasToggled {
                withAnimation(VAnimation.fast) {
                    isExpanded = false
                }
            }
        }
    }

    /// Abbreviate long file paths to just the last component
    private func abbreviatePath(_ input: String) -> String {
        // If it looks like a file path, show just the filename
        if input.contains("/") && !input.contains(" ") {
            return URL(fileURLWithPath: input).lastPathComponent
        }
        // For commands, truncate
        if input.count > 60 {
            return String(input.prefix(57)) + "..."
        }
        return input
    }
}

/// A simple pulsing opacity modifier for the running indicator dot
private struct PulsingModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(
                Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}


