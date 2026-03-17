import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyEntryStepView: View {
    @Bindable var state: OnboardingState

    @State private var apiKey: String = ""
    @State private var hasExistingKey = false
    @State private var isEditing = false
    @State private var showTitle = false
    @State private var showContent = false
    @FocusState private var keyFieldFocused: Bool

    var body: some View {
        Text("Add your API key")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Vellum needs an Anthropic API key to work.\nEnter yours to connect.")
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                apiKeyField

                OnboardingButton(
                    title: "Continue",
                    style: .primary,
                    disabled: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    saveAndHatch()
                }

                OnboardingButton(title: "Get an API key", style: .ghostPrimary) {
                    NSWorkspace.shared.open(URL(string: "https://console.anthropic.com/settings/keys")!)
                }

                OnboardingButton(title: "Back", style: .ghost) {
                    goBack()
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if let existingKey = APIKeyManager.getKey(for: "anthropic") {
                apiKey = existingKey
                hasExistingKey = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                keyFieldFocused = true
            }
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        Group {
            if hasExistingKey && !isEditing {
                Text(maskedKey)
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .onTapGesture {
                        isEditing = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            keyFieldFocused = true
                        }
                    }
            } else {
                SecureField("sk-ant-\u{2026}", text: $apiKey)
                    .textFieldStyle(.plain)
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .focused($keyFieldFocused)
                    .onSubmit {
                        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        saveAndHatch()
                    }
            }
        }
    }

    // MARK: - Helpers

    private var maskedKey: String {
        guard apiKey.count > 7 else { return String(repeating: "\u{2022}", count: apiKey.count) }
        let prefix = String(apiKey.prefix(4))
        let suffix = String(apiKey.suffix(3))
        let dots = String(repeating: "\u{2022}", count: min(apiKey.count - 7, 20))
        return prefix + dots + suffix
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }

    private func saveAndHatch() {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "anthropic")
        APIKeyManager.syncKeyToDaemon(provider: "anthropic", value: trimmed)

        // Set service modes to "your-own" for any services that don't already
        // have a mode configured (first-time BYOK onboarding).
        WorkspaceConfigIO.initializeServiceDefaults(defaultMode: "your-own")

        saveModelToConfig("claude-opus-4-6")
        state.advance()
    }

    private func saveModelToConfig(_ model: String) {
        let existingConfig = WorkspaceConfigIO.read()
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var inference = services["inference"] as? [String: Any] ?? [:]
        inference["model"] = model
        services["inference"] = inference
        try? WorkspaceConfigIO.merge(["services": services])
    }
}
