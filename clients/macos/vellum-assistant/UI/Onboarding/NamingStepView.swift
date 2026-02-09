import SwiftUI

struct NamingStepView: View {
    @Bindable var state: OnboardingState

    @FocusState private var nameFieldFocused: Bool
    @State private var showInput = false

    var body: some View {
        VStack(spacing: 24) {
            ReactionBubble(text: "Hey! Nice to meet you.")

            Text("What should I call you?")
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.6))
                .opacity(showInput ? 1 : 0)

            TextField("Your name", text: $state.assistantName)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(
                    Capsule()
                        .fill(Color.white.opacity(0.06))
                        .overlay(
                            Capsule()
                                .stroke(Color.white.opacity(0.15), lineWidth: 1)
                        )
                )
                .frame(maxWidth: 280)
                .focused($nameFieldFocused)
                .opacity(showInput ? 1 : 0)
                .onSubmit {
                    confirmName()
                }

            OnboardingButton(
                title: "That's me",
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
        OnboardingBackground()
        NamingStepView(state: {
            let s = OnboardingState()
            s.currentStep = 1
            return s
        }())
    }
    .frame(width: 600, height: 500)
}
