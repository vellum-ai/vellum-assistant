import VellumAssistantShared
import SwiftUI

@MainActor
struct NamingStepView: View {
    @Bindable var state: OnboardingState

    @FocusState private var nameFieldFocused: Bool
    @State private var showInput = false

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            VStack(spacing: VSpacing.md) {
                Text("Every creature needs a name.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.contentDefault)

                Text("What should this one be called?")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.contentSecondary)
            }
            .opacity(showInput ? 1 : 0)

            TextField("Name your agent\u{2026}", text: $state.assistantName)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(VColor.contentDefault)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
                .padding(.vertical, VSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceBase.opacity(0.5))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
                        )
                )
                .frame(maxWidth: 260)
                .focused($nameFieldFocused)
                .opacity(showInput ? 1 : 0)
                .onSubmit {
                    confirmName()
                }

            OnboardingButton(
                title: "Continue",
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
        VColor.surfaceOverlay
        NamingStepView(state: {
            let s = OnboardingState()
            s.currentStep = 1
            return s
        }())
    }
    .frame(width: 520, height: 400)
}
