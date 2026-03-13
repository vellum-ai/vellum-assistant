import VellumAssistantShared
import SwiftUI

/// Observation mode pitch view — step 4 of the first meeting flow.
/// Proposes that the assistant observe the user working for a few minutes
/// before offering autonomous help.
@MainActor
struct ObservationModeView: View {
    @Bindable var state: OnboardingState
    var onStartObserving: () -> Void
    var onSkip: () -> Void

    @State private var pitchDone = false
    @State private var showDurationPicker = false
    @State private var showButtons = false
    @State private var selectedMinutes: Int = 5

    private var pitchText: String {
        let task = state.firstTaskCandidate ?? "getting things done"
        return "You mentioned \(task). I can definitely help with that. But since we just met, can I ride along while you do it for a few minutes first? Like \(selectedMinutes) minutes \u{2014} I\u{2019}ll watch and learn how you work, then I\u{2019}ll know how to actually help the way you\u{2019}d want."
    }

    private let durationOptions = [3, 5, 10]

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.xxxl) {
            CreatureView(visible: true, animated: false)
                .scaleEffect(0.5)
                .frame(width: 200, height: 200)

            OnboardingPanel {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    TypewriterText(
                        fullText: pitchText,
                        speed: 0.03,
                        font: VFont.body,
                        onComplete: {
                            pitchDone = true
                            withAnimation(.easeOut(duration: 0.4)) {
                                showDurationPicker = true
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                withAnimation(.easeOut(duration: 0.5)) {
                                    showButtons = true
                                }
                            }
                        }
                    )

                    // Duration selector
                    if showDurationPicker {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("\(selectedMinutes) minutes okay?")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.contentSecondary)

                            HStack(spacing: VSpacing.sm) {
                                ForEach(durationOptions, id: \.self) { minutes in
                                    durationChip(minutes)
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: 6)))
                    }

                    // Action buttons
                    if showButtons {
                        VStack(spacing: VSpacing.md) {
                            OnboardingButton(
                                title: "Start observing",
                                style: .primary,
                                fadeIn: true,
                                fadeDelay: 0.1
                            ) {
                                state.observationDurationMinutes = selectedMinutes
                                onStartObserving()
                            }

                            OnboardingButton(
                                title: "Skip for now",
                                style: .tertiary,
                                fadeIn: true,
                                fadeDelay: 0.3
                            ) {
                                onSkip()
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: 8)))
                    }
                }
            }
            .frame(maxWidth: 420)
        }
    }

    private func durationChip(_ minutes: Int) -> some View {
        Button {
            withAnimation(VAnimation.fast) {
                selectedMinutes = minutes
            }
        } label: {
            Text("\(minutes) min")
                .font(VFont.captionMedium)
                .foregroundColor(
                    minutes == selectedMinutes
                        ? VColor.contentDefault
                        : VColor.contentSecondary
                )
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(
                            minutes == selectedMinutes
                                ? VColor.primaryBase.opacity(0.3)
                                : VColor.surfaceBase
                        )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(
                            minutes == selectedMinutes
                                ? VColor.primaryBase.opacity(0.6)
                                : VColor.borderBase.opacity(0.5),
                            lineWidth: 1
                        )
                )
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    ZStack {
        MeadowBackground()
        ObservationModeView(
            state: {
                let s = OnboardingState()
                s.currentStep = 4
                s.assistantName = "Assistant"
                s.firstTaskCandidate = "organizing my project files"
                return s
            }(),
            onStartObserving: {},
            onSkip: {}
        )
    }
    .frame(width: 1366, height: 849)
}
