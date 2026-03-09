import VellumAssistantShared
import SwiftUI

@MainActor
struct ModelSelectionStepView: View {
    @Bindable var state: OnboardingState

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user_hosted_enabled")
    }

    @State private var showTitle = false
    @State private var showContent = false

    private static let models: [(id: String, name: String, detail: String)] = [
        ("claude-opus-4-6", "Opus 4.6", "Most capable"),
        ("claude-opus-4-6-fast", "Opus 4.6 Fast", "Fastest Opus"),
        ("claude-sonnet-4-6", "Sonnet 4.6", "Balanced"),
        ("claude-haiku-4-5-20251001", "Haiku 4.5", "Fastest"),
    ]

    var body: some View {
        // Title
        Text("Choose your model")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .textSelection(.enabled)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("Pick the model that powers your assistant.")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .textSelection(.enabled)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        Spacer()

        // Content
        VStack(spacing: VSpacing.md) {
            // Model selection cards
            VStack(spacing: VSpacing.sm) {
                ForEach(Self.models, id: \.id) { model in
                    modelCard(id: model.id, name: model.name, detail: model.detail)
                }
            }

            // Primary button
            Button(action: { saveModelAndContinue() }) {
                Text("Select model")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(adaptiveColor(
                                light: Stone._900,
                                dark: Forest._600
                            ))
                    )
            }
            .buttonStyle(.plain)
            .pointerCursor()

            Button(action: { goBack() }) {
                Text("Back")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .padding(.top, VSpacing.xs)

            OnboardingFooter(currentStep: state.currentStep, totalSteps: userHostedEnabled ? 4 : 3)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Model Card

    private func modelCard(id: String, name: String, detail: String) -> some View {
        let isSelected = state.selectedModel == id
        return Button(action: { state.selectedModel = id }) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(VColor.textPrimary)
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textSecondary)
                }
                Spacer()
                Circle()
                    .fill(isSelected ? Forest._600 : Color.clear)
                    .overlay(
                        Circle().stroke(isSelected ? Forest._600 : VColor.surfaceBorder, lineWidth: 1.5)
                    )
                    .overlay(
                        isSelected
                            ? Circle().fill(Color.white).frame(width: 6, height: 6)
                            : nil
                    )
                    .frame(width: 18, height: 18)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? Forest._600.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isSelected ? Forest._600.opacity(0.5) : VColor.surfaceBorder, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Helpers

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            if userHostedEnabled && state.cloudProvider == "local" {
                state.currentStep = 1
            } else {
                state.currentStep -= 1
            }
        }
    }

    private func saveModelAndContinue() {
        state.advance()
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            Image("VellyLogo")
                .resizable()
                .interpolation(.none)
                .aspectRatio(contentMode: .fit)
                .frame(width: 128, height: 128)
                .padding(.bottom, VSpacing.xxl)
            ModelSelectionStepView(state: {
                let s = OnboardingState()
                s.currentStep = 3
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}
