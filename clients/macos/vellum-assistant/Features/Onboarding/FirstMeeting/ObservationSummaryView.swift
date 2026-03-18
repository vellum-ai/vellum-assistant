import VellumAssistantShared
import SwiftUI

/// Post-observation summary view — shown after the observation session completes.
/// Displays key observations and proposes a first autonomous action.
@MainActor
struct ObservationSummaryView: View {
    @Bindable var state: OnboardingState
    var onAccept: () -> Void
    var onDecline: () -> Void

    @State private var summaryDone = false
    @State private var showInsights = false
    @State private var showProposal = false
    @State private var showButtons = false

    private let summaryText = "Okay, I think I\u{2019}ve got a good read on how you work. Here\u{2019}s what I noticed:"

    /// Stub observations — in production these would come from ambient analysis.
    private var displayInsights: [String] {
        if state.observationInsights.isEmpty {
            return [
                "You switch between apps frequently \u{2014} I can help keep context across windows.",
                "You tend to organize files methodically \u{2014} I\u{2019}ll match that style.",
                "You like keyboard shortcuts \u{2014} I\u{2019}ll suggest efficient workflows.",
            ]
        }
        // Use a curated subset of the collected insights
        return Array(state.observationInsights.prefix(3))
    }

    private var proposalText: String {
        let task = state.firstTaskCandidate ?? "your next task"
        return "Based on what I saw, I think I could help with \(task) right away. Want me to give it a try?"
    }

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.xxxl) {
            CreatureView(visible: true, animated: false)
                .scaleEffect(0.5)
                .frame(width: 200, height: 200)

            OnboardingPanel {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Summary introduction
                    TypewriterText(
                        fullText: summaryText,
                        speed: 0.03,
                        font: VFont.body,
                        onComplete: {
                            summaryDone = true
                            withAnimation(.easeOut(duration: 0.4)) {
                                showInsights = true
                            }
                        }
                    )

                    // Key observations
                    if showInsights {
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            ForEach(Array(displayInsights.enumerated()), id: \.offset) { index, insight in
                                InsightRow(text: insight, index: index)
                                    .transition(.opacity.combined(with: .offset(y: 6)))
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: 6)))
                        .onAppear {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                withAnimation(.easeOut(duration: 0.4)) {
                                    showProposal = true
                                }
                            }
                        }
                    }

                    // Proposal
                    if showProposal {
                        Text(proposalText)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                            .textSelection(.enabled)
                            .transition(.opacity.combined(with: .offset(y: 6)))
                            .onAppear {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                    withAnimation(.easeOut(duration: 0.5)) {
                                        showButtons = true
                                    }
                                }
                            }
                    }

                    // Action buttons
                    if showButtons {
                        VStack(spacing: VSpacing.md) {
                            OnboardingButton(
                                title: "Let\u{2019}s try it",
                                style: .primary,
                                fadeIn: true,
                                fadeDelay: 0.1
                            ) {
                                state.observationCompleted = true
                                onAccept()
                            }

                            OnboardingButton(
                                title: "Maybe later",
                                style: .tertiary,
                                fadeIn: true,
                                fadeDelay: 0.3
                            ) {
                                state.observationCompleted = true
                                onDecline()
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: 8)))
                    }
                }
            }
            .frame(maxWidth: 420)
        }
    }
}

// MARK: - Insight Row

private struct InsightRow: View {
    let text: String
    let index: Int

    @State private var appeared = false

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.sparkles, size: 12)
                .foregroundColor(VColor.primaryBase)
                .padding(.top, 2)

            Text(text)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
        }
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 4)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(index) * 0.2) {
                withAnimation(.easeOut(duration: 0.4)) {
                    appeared = true
                }
            }
        }
    }
}
