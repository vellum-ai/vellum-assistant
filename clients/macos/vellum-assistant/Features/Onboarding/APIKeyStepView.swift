import VellumAssistantShared
import SwiftUI

enum HostingMode: String, CaseIterable {
    case vellum
    case local
    case docker
    case aws
    case customHardware
    case gcp

    var displayName: String {
        switch self {
        case .vellum: return "Vellum"
        case .local: return "Local"
        case .docker: return "Docker"
        case .aws: return "AWS"
        case .customHardware: return "Custom"
        case .gcp: return "GCP"
        }
    }

    var detail: String {
        switch self {
        case .vellum: return "Hosted and managed by Vellum"
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
    var isAuthenticated: Bool = false
    var onHatchManaged: (() -> Void)?

    @State private var apiKey: String = ""
    @State private var hasExistingKey = false
    @State private var isEditing = false
    @State private var showTitle = false
    @State private var showContent = false
    @State var hostingMode: HostingMode = .local
    @FocusState private var keyFieldFocused: Bool

    @State var gcpServiceAccountFileName: String = ""
    @State var qrCodeImageFileName: String = ""
    @FocusState var arnFieldFocused: Bool
    @FocusState var projectIdFieldFocused: Bool

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user_hosted_enabled")
    }

    private var managedSignInEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("managed_sign_in_enabled")
    }

    private var showHostingSelector: Bool {
        managedSignInEnabled || userHostedEnabled
    }

    private var availableHostingModes: [HostingMode] {
        var modes: [HostingMode] = []
        if managedSignInEnabled && isAuthenticated {
            modes.append(.vellum)
        }
        modes.append(.local)
        if userHostedEnabled {
            modes.append(contentsOf: [.gcp, .aws, .docker, .customHardware])
        }
        return modes
    }

    private var showApiKeyField: Bool {
        if managedSignInEnabled {
            return !isAuthenticated && hostingMode != .vellum
        }
        return true
    }

    private var showInlineCloudFields: Bool {
        hostingMode == .gcp || hostingMode == .aws || hostingMode == .customHardware
    }

    var body: some View {
        Text(showHostingSelector ? "Setup" : "Add your API key")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text(showHostingSelector
             ? "Choose how to run your assistant."
             : "Enter your Anthropic API key to get started.")
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                if showHostingSelector {
                    hostingModeSelector
                }

                if showApiKeyField {
                    apiKeyField
                }

                if showInlineCloudFields {
                    inlineCloudCredentialFields
                }

                hatchOrContinueButton

                footerLinks
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            // Clear any previously stored API key for authenticated users in
            // the managed sign-in flow so the assistant falls back to the
            // platform-provisioned token.
            if managedSignInEnabled && isAuthenticated {
                APIKeyManager.deleteKey(for: "anthropic")
            }

            if let existingKey = APIKeyManager.getKey(for: "anthropic") {
                apiKey = existingKey
                hasExistingKey = true
            }
            if showHostingSelector, let saved = loadHostingModeFromDefaults(),
               availableHostingModes.contains(saved) {
                hostingMode = saved
            }
            if managedSignInEnabled && isAuthenticated {
                hostingMode = .vellum
            }
            if !state.gcpServiceAccountKey.isEmpty {
                gcpServiceAccountFileName = "service-account-key.json"
            }
            if !state.customQRCodeImageData.isEmpty {
                qrCodeImageFileName = "qr-code.png"
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            if showApiKeyField {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    keyFieldFocused = true
                }
            }
        }

        Spacer()

        if !managedSignInEnabled {
            OnboardingFooter(currentStep: state.currentStep, totalSteps: 3)
                .padding(.bottom, VSpacing.lg)
        }
    }

    // MARK: - Hosting Mode Selector

    private var hostingModeSelector: some View {
        VStack(spacing: VSpacing.sm) {
            ForEach(availableHostingModes, id: \.rawValue) { mode in
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
                        .foregroundColor(VColor.contentDefault)
                    Text(mode.detail)
                        .font(.system(size: 12))
                        .foregroundColor(VColor.contentSecondary)
                }
                Spacer()
                Circle()
                    .fill(isSelected ? VColor.primaryBase : Color.clear)
                    .overlay(
                        Circle().stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1.5)
                    )
                    .overlay(
                        isSelected
                            ? Circle().fill(VColor.auxWhite).frame(width: 6, height: 6)
                            : nil
                    )
                    .frame(width: 18, height: 18)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isSelected ? VColor.primaryBase.opacity(0.5) : VColor.borderBase, lineWidth: 1)
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
                        if managedSignInEnabled {
                            guard !hatchButtonDisabled else { return }
                            saveAndHatch()
                        } else {
                            guard !primaryButtonDisabled else { return }
                            saveAndContinue()
                        }
                    }
            }
        }
    }

    // MARK: - Primary Button

    private var hatchOrContinueButton: some View {
        Group {
            if managedSignInEnabled {
                OnboardingButton(
                    title: "Hatch",
                    style: .primary,
                    disabled: hatchButtonDisabled
                ) {
                    saveAndHatch()
                }
            } else {
                OnboardingButton(
                    title: "Continue",
                    style: .primary,
                    disabled: primaryButtonDisabled
                ) {
                    saveAndContinue()
                }
            }
        }
    }

    // MARK: - Footer Links

    private var showBackButton: Bool {
        if managedSignInEnabled && isAuthenticated {
            return false
        }
        return true
    }

    private var footerLinks: some View {
        HStack(spacing: VSpacing.lg) {
            if showApiKeyField {
                Link(destination: URL(string: "https://console.anthropic.com/settings/keys")!) {
                    Text("Get an API key")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.primaryBase)
                }
                .pointerCursor()
            }

            if showBackButton {
                Button(action: { goBack() }) {
                    Text("Back")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.top, VSpacing.xs)
    }

    // MARK: - Helpers

    private var primaryButtonDisabled: Bool {
        if apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        switch hostingMode {
        case .gcp:
            return state.gcpProjectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || state.gcpServiceAccountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .aws:
            return state.awsRoleArn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .customHardware:
            return state.customQRCodeImageData.isEmpty
        default:
            return false
        }
    }

    private var hatchButtonDisabled: Bool {
        if hostingMode == .vellum {
            return false
        }
        if showApiKeyField && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        switch hostingMode {
        case .gcp:
            return state.gcpProjectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || state.gcpServiceAccountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .aws:
            return state.awsRoleArn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .customHardware:
            return state.customQRCodeImageData.isEmpty
        default:
            return false
        }
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

    private func saveAndHatch() {
        state.cloudProvider = hostingMode.rawValue

        if hostingMode == .vellum {
            onHatchManaged?()
            return
        }

        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            APIKeyManager.setKey(trimmed, for: "anthropic")
            APIKeyManager.syncKeyToDaemon(provider: "anthropic", value: trimmed)
        }

        saveModelToConfig("claude-opus-4-6")
        state.isHatching = true
    }

    private func saveAndContinue() {
        if showHostingSelector {
            state.cloudProvider = hostingMode.rawValue
        } else {
            state.cloudProvider = "local"
        }

        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "anthropic")
        APIKeyManager.syncKeyToDaemon(provider: "anthropic", value: trimmed)

        saveModelToConfig("claude-opus-4-6")
        state.advance()
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
