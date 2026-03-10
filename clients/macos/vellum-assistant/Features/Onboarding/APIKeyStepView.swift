import VellumAssistantShared
import SwiftUI

private enum HostingMode: String, CaseIterable {
    case local
    case docker
    case aws
    case customHardware
    case gcp

    var displayName: String {
        switch self {
        case .local: return "Local"
        case .docker: return "Docker"
        case .aws: return "AWS"
        case .customHardware: return "Custom Hardware"
        case .gcp: return "GCP"
        }
    }

    var detail: String {
        switch self {
        case .local: return "Run on your machine"
        case .docker: return "Run in a Docker container"
        case .aws: return "Host on your AWS account"
        case .customHardware: return "Run on your own hardware"
        case .gcp: return "Host on your GCP account"
        }
    }
}

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var apiKey: String = ""
    @State private var hasExistingKey = false
    @State private var isEditing = false
    @State private var showTitle = false
    @State private var showContent = false
    @State private var hostingMode: HostingMode = .local
    @FocusState private var keyFieldFocused: Bool

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user_hosted_enabled")
    }

    var body: some View {
        Text(userHostedEnabled ? "Setup" : "Add your API key")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text(userHostedEnabled
             ? "Choose how to run your assistant."
             : "Enter your Anthropic API key to get started.")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        Spacer()

        VStack(spacing: VSpacing.md) {
            if userHostedEnabled {
                hostingModeSelector
            }

            apiKeyField

            primaryButton

            footerLinks
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if let existingKey = APIKeyManager.getKey(for: "anthropic") {
                apiKey = existingKey
                hasExistingKey = true
            }
            if userHostedEnabled, let saved = loadHostingModeFromDefaults() {
                hostingMode = saved
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

        OnboardingFooter(currentStep: state.currentStep, totalSteps: userHostedEnabled ? 4 : 3)
            .padding(.bottom, VSpacing.lg)
    }

    // MARK: - Hosting Mode Selector

    private var hostingModeSelector: some View {
        VStack(spacing: VSpacing.sm) {
            ForEach(HostingMode.allCases, id: \.rawValue) { mode in
                hostingModeCard(mode: mode)
            }
        }
    }

    private func hostingModeCard(mode: HostingMode) -> some View {
        let isSelected = hostingMode == mode
        return Button(action: { hostingMode = mode }) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(mode.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(VColor.textPrimary)
                    Text(mode.detail)
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

    // MARK: - API Key Field

    private var apiKeyField: some View {
        Group {
            if hasExistingKey && !isEditing {
                Text(maskedKey)
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
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
                    .foregroundColor(VColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .focused($keyFieldFocused)
                    .onSubmit {
                        saveAndContinue()
                    }
            }
        }
    }

    // MARK: - Primary Button

    private var primaryButton: some View {
        OnboardingButton(
            title: "Continue",
            style: .primary,
            disabled: primaryButtonDisabled
        ) {
            saveAndContinue()
        }
    }

    // MARK: - Footer Links

    private var footerLinks: some View {
        HStack(spacing: VSpacing.lg) {
            Link(destination: URL(string: "https://console.anthropic.com/settings/keys")!) {
                Text("Get an API key")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.accent)
            }
            .pointerCursor()

            Button(action: { goBack() }) {
                Text("Back")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
        .padding(.top, VSpacing.xs)
    }

    // MARK: - Helpers

    private var primaryButtonDisabled: Bool {
        apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var maskedKey: String {
        guard apiKey.count > 7 else { return String(repeating: "\u{2022}", count: apiKey.count) }
        let prefix = String(apiKey.prefix(4))
        let suffix = String(apiKey.suffix(3))
        let dots = String(repeating: "\u{2022}", count: min(apiKey.count - 7, 20))
        return prefix + dots + suffix
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep = 0
        }
    }

    private func saveAndContinue() {
        if userHostedEnabled {
            state.cloudProvider = hostingMode.rawValue
        }

        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "anthropic")
        APIKeyManager.syncKeyToDaemon(provider: "anthropic", value: trimmed)

            saveModelToConfig("claude-opus-4-6")
            if userHostedEnabled && hostingMode != .local && hostingMode != .docker {
                state.advance()
            } else if userHostedEnabled {
                state.advance()
            } else {
                state.cloudProvider = "local"
                state.advance()
            }
    }

    private func saveModelToConfig(_ model: String) {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/workspace/config.json")

        let dirURL = configURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)

        do {
            let data = try Data(contentsOf: configURL)
            if var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                json["model"] = model
                let updated = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
                try updated.write(to: configURL)
            }
        } catch {
            let json: [String: Any] = ["model": model]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: .prettyPrinted) {
                try? data.write(to: configURL)
            }
        }
    }

    private func loadHostingModeFromDefaults() -> HostingMode? {
        guard let raw = UserDefaults.standard.string(forKey: "onboarding.cloudProvider"),
              let mode = HostingMode(rawValue: raw) else {
            return nil
        }
        return mode
    }
}

#Preview("Default - API Key Only") {
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
            APIKeyStepView(state: {
                let s = OnboardingState()
                s.currentStep = 2
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}

#Preview("User Hosted Enabled") {
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
            APIKeyStepView(state: {
                let s = OnboardingState()
                s.currentStep = 2
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
    .onAppear {
        MacOSClientFeatureFlagManager.shared.setOverride("user_hosted_enabled", enabled: true)
    }
}
