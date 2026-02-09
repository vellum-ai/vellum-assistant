import SwiftUI

struct IntegrationPickerStepView: View {
    @Bindable var state: OnboardingState

    @State private var showCards = false
    @State private var showConfirm = false
    @State private var recipeRunning = false

    private let integrations = Integration.allCases

    var body: some View {
        VStack(spacing: 24) {
            if recipeRunning {
                recipeProgressView
            } else {
                pickerView
            }
        }
    }

    // MARK: - Picker

    private var pickerView: some View {
        VStack(spacing: 24) {
            ReactionBubble(
                text: "Where do you spend most of your time?"
            )

            // Integration grid — 3 top, 2 bottom
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    ForEach(integrations.prefix(3)) { integration in
                        integrationCard(integration)
                    }
                }
                HStack(spacing: 10) {
                    ForEach(integrations.suffix(2)) { integration in
                        integrationCard(integration)
                    }
                }
            }
            .opacity(showCards ? 1 : 0)
            .offset(y: showCards ? 0 : 12)

            if let selected = state.selectedIntegration {
                VStack(spacing: 12) {
                    if selected.recipeName != nil {
                        Text("I'll set up \(state.assistantName.isEmpty ? "your assistant" : state.assistantName) on \(selected.rawValue).")
                            .font(.system(size: 13))
                            .foregroundColor(.white.opacity(0.6))
                            .multilineTextAlignment(.center)

                        OnboardingButton(title: "Yes, take it from here", style: .primary) {
                            startRecipe(for: selected)
                        }
                    } else {
                        Text("\(selected.rawValue) setup coming soon!")
                            .font(.system(size: 13))
                            .foregroundColor(.white.opacity(0.5))
                    }

                    OnboardingButton(title: "Skip for now", style: .ghost) {
                        state.advance()
                    }
                }
                .transition(.opacity)
            } else {
                OnboardingButton(title: "Skip", style: .ghost) {
                    state.advance()
                }
                .opacity(showCards ? 1 : 0)
            }
        }
        .animation(.easeOut(duration: 0.3), value: state.selectedIntegration)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showCards = true
                }
            }
        }
    }

    // MARK: - Recipe Progress

    private var recipeProgressView: some View {
        VStack(spacing: 24) {
            if case .running(let step, let total, let description) = state.recipeState {
                ReactionBubble(
                    text: "Setting up \(state.selectedIntegration?.rawValue ?? "integration")... watch me work!"
                )

                VStack(spacing: 16) {
                    ProgressView(value: Double(step), total: Double(total))
                        .tint(Color(hex: 0xD4A843))
                        .frame(maxWidth: 280)

                    Text("Step \(step)/\(total): \(description)")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }
                .padding(24)
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Color.white.opacity(0.05))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16)
                                .stroke(Color(hex: 0xD4A843).opacity(0.3), lineWidth: 1)
                        )
                )
            } else if case .completed(let integration) = state.recipeState {
                ReactionBubble(
                    text: "\(state.assistantName.isEmpty ? "I'm" : state.assistantName + " is") set up on \(integration.rawValue)!"
                )

                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                    Text("Connected!")
                        .foregroundColor(.green)
                        .font(.system(size: 15, weight: .medium))
                }
                .transition(.scale.combined(with: .opacity))
            } else if case .failed(let reason) = state.recipeState {
                ReactionBubble(
                    text: "Hmm, something went wrong. We can try again later."
                )

                Text(reason)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.4))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                OnboardingButton(title: "Continue anyway", style: .ghost) {
                    state.recipeState = .idle
                    state.advance()
                }
            }
        }
        .animation(.easeOut(duration: 0.5), value: state.recipeState)
    }

    // MARK: - Integration Card

    private func integrationCard(_ integration: Integration) -> some View {
        let isSelected = state.selectedIntegration == integration
        let isAvailable = integration.recipeName != nil

        return Button {
            state.selectedIntegration = (state.selectedIntegration == integration) ? nil : integration
        } label: {
            VStack(spacing: 8) {
                Image(systemName: integration.icon)
                    .font(.system(size: 20))
                    .foregroundColor(isSelected ? Color(hex: 0x0E0E11) : .white.opacity(isAvailable ? 0.8 : 0.4))

                Text(integration.rawValue)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isSelected ? Color(hex: 0x0E0E11) : .white.opacity(isAvailable ? 0.7 : 0.35))
            }
            .frame(width: 100, height: 72)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(isSelected ? Color(hex: 0xD4A843) : Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        isSelected ? Color.clear : Color.white.opacity(isAvailable ? 0.15 : 0.06),
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Recipe Execution

    private func startRecipe(for integration: Integration) {
        guard let recipeName = integration.recipeName else { return }
        recipeRunning = true
        state.orbMood = .listening
        state.recipeState = .running(step: 0, total: 1, description: "Preparing...")

        Task {
            let executor = RecipeExecutor()
            let context = RecipeContext(
                assistantName: state.assistantName,
                homepageURL: "https://vellum.ai"
            )

            let result = await executor.execute(recipeName: recipeName, context: context) { progress in
                state.recipeState = .running(
                    step: progress.currentStep,
                    total: progress.totalSteps,
                    description: progress.description
                )
            }

            if result.success {
                state.recipeState = .completed(integration: integration)
                state.orbMood = .celebrating
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    state.orbMood = .breathing
                    state.advance()
                }
            } else {
                state.recipeState = .failed(reason: result.error ?? "Unknown error")
                state.orbMood = .breathing
            }
        }
    }
}

#Preview {
    ZStack {
        OnboardingBackground()
        VStack {
            SoulOrbView(mood: .breathing)
                .padding(.bottom, 20)
            IntegrationPickerStepView(state: {
                let s = OnboardingState()
                s.assistantName = "Alex"
                s.currentStep = 5
                return s
            }())
        }
    }
    .frame(width: 600, height: 500)
}
