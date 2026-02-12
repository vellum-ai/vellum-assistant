import SwiftUI

@MainActor
struct NamingStepView: View {
    @Bindable var state: OnboardingState

    @FocusState private var nameFieldFocused: Bool
    @State private var showInput = false

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            ReactionBubble(text: "Oh\u{2026} I\u{2019}m here! Who are you?")

            VStack(spacing: VSpacing.md) {
                Text("Every creature needs a name.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("What should this one be called?")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
            }
            .opacity(showInput ? 1 : 0)

            TextField("Name your agent\u{2026}", text: $state.assistantName)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
                .padding(.vertical, VSpacing.lg)
                .background(
                    Capsule()
                        .fill(VColor.surface.opacity(0.5))
                        .overlay(
                            Capsule()
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                )
                .frame(maxWidth: 260)
                .focused($nameFieldFocused)
                .opacity(showInput ? 1 : 0)
                .onSubmit {
                    confirmName()
                }

            OnboardingButton(
                title: "That\u{2019}s your name",
                style: .primary,
                disabled: state.assistantName.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                confirmName()
            }
            .opacity(showInput ? 1 : 0)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showInput = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    nameFieldFocused = true
                }
            }
        }
    }

    private func confirmName() {
        guard !state.assistantName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        state.advance()
    }
}

#Preview {
    ZStack {
        MeadowBackground()
        NamingStepView(state: {
            let s = OnboardingState()
            s.currentStep = 1
            return s
        }())
    }
    .frame(width: 1366, height: 849)
}
