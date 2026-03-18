import VellumAssistantShared
import SwiftUI

@MainActor
struct CapabilitiesBriefingView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void

    @State private var firstParagraphDone = false
    @State private var showSecondParagraph = false
    @State private var showButtons = false
    @State private var showCapabilitiesModal = false

    private let firstText = "Okay, I think I\u{2019}ve got a good sense of where to start. Before we dive in \u{2014} quick road trip safety briefing."
    private let secondText = "For now, think of it like you\u{2019}re driving and I\u{2019}m the passenger. I can navigate, handle stuff on my phone, keep us on track \u{2014} but you\u{2019}re steering."

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.xxxl) {
            // Creature on the left, small like in interview step
            CreatureView(visible: true, animated: false)
                .scaleEffect(0.5)
                .frame(width: 200, height: 200)

            OnboardingPanel {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Framing text
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        TypewriterText(
                            fullText: firstText,
                            speed: 0.03,
                            font: VFont.body,
                            onComplete: {
                                firstParagraphDone = true
                                withAnimation(.easeOut(duration: 0.4)) {
                                    showSecondParagraph = true
                                }
                            }
                        )

                        if showSecondParagraph {
                            TypewriterText(
                                fullText: secondText,
                                speed: 0.03,
                                font: VFont.body,
                                onComplete: {
                                    withAnimation(.easeOut(duration: 0.5)) {
                                        showButtons = true
                                    }
                                }
                            )
                            .transition(.opacity.combined(with: .offset(y: 6)))
                        }
                    }

                    // Action buttons
                    if showButtons {
                        VStack(spacing: VSpacing.md) {
                            OnboardingButton(
                                title: "Got it, let\u{2019}s go",
                                style: .primary,
                                fadeIn: true,
                                fadeDelay: 0.1
                            ) {
                                state.capabilitiesBriefingShown = true
                                onComplete()
                            }

                            OnboardingButton(
                                title: "See what I can do",
                                style: .tertiary,
                                fadeIn: true,
                                fadeDelay: 0.3
                            ) {
                                showCapabilitiesModal = true
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: 8)))
                    }
                }
            }
            .frame(maxWidth: 420)
        }
        .sheet(isPresented: $showCapabilitiesModal) {
            CapabilitiesModalView()
        }
    }
}
