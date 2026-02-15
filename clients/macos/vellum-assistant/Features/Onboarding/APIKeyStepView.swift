import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var apiKey: String = ""
    @State private var showContent = false
    @State private var alreadyConfigured = false
    @FocusState private var keyFieldFocused: Bool

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            VStack(spacing: VSpacing.md) {
                Text("Connect to Claude")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Enter your Anthropic API key to get started.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }
            .opacity(showContent ? 1 : 0)

            if alreadyConfigured {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("API key already configured")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textSecondary)
                }
                .opacity(showContent ? 1 : 0)

                OnboardingButton(title: "Continue", style: .primary) {
                    state.advance()
                }
                .opacity(showContent ? 1 : 0)
            } else {
                SecureField("sk-ant-\u{2026}", text: $apiKey)
                    .textFieldStyle(.plain)
                    .font(.system(size: 18, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surface.opacity(0.5))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                            )
                    )
                    .frame(maxWidth: 360)
                    .focused($keyFieldFocused)
                    .opacity(showContent ? 1 : 0)
                    .onSubmit {
                        saveAndContinue()
                    }

                OnboardingButton(
                    title: "Save & Continue",
                    style: .primary,
                    disabled: apiKey.trimmingCharacters(in: .whitespaces).isEmpty
                ) {
                    saveAndContinue()
                }
                .opacity(showContent ? 1 : 0)

                Link(destination: URL(string: "https://console.anthropic.com/settings/keys")!) {
                    Text("Get your API key at console.anthropic.com")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .opacity(showContent ? 1 : 0)

                OnboardingButton(title: "Skip", style: .ghost) {
                    state.advance()
                }
                .opacity(showContent ? 1 : 0)
            }
        }
        .onAppear {
            if APIKeyManager.getKey() != nil {
                alreadyConfigured = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showContent = true
                }
                if !alreadyConfigured {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        keyFieldFocused = true
                    }
                }
            }
        }
    }

    private func saveAndContinue() {
        let trimmed = apiKey.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed)
        state.advance()
    }
}

#Preview {
    ZStack {
        VColor.background
        APIKeyStepView(state: {
            let s = OnboardingState()
            s.currentStep = 2
            return s
        }())
    }
    .frame(width: 520, height: 400)
}
