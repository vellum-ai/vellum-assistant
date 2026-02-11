import SwiftUI

struct NamingStepView: View {
    @Bindable var state: OnboardingState

    @FocusState private var nameFieldFocused: Bool
    @State private var showInput = false

    var body: some View {
        VStack(spacing: VellumSpacing.xxl) {
            ReactionBubble(text: "Oh\u{2026} I\u{2019}m here! Who are you?")

            VStack(spacing: VellumSpacing.md) {
                Text("Every creature needs a name.")
                    .font(VellumFont.onboardingTitle)
                    .foregroundColor(VellumTheme.textPrimary)

                Text("What should this one be called?")
                    .font(VellumFont.onboardingSubtitle)
                    .foregroundColor(VellumTheme.textSecondary)
            }
            .opacity(showInput ? 1 : 0)

            TextField("Name your agent\u{2026}", text: $state.assistantName)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(VellumTheme.textPrimary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
                .padding(.vertical, VellumSpacing.lg)
                .background(
                    Capsule()
                        .fill(VellumTheme.surface.opacity(0.5))
                        .overlay(
                            Capsule()
                                .stroke(VellumTheme.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                )
                .frame(maxWidth: 280)
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
            state.orbMood = .breathing
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
        OnboardingBackground()
        NamingStepView(state: {
            let s = OnboardingState()
            s.currentStep = 1
            return s
        }())
    }
    .frame(width: 600, height: 500)
}
