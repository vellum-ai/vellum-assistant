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
    @State private var showCharacters = false
    @FocusState private var keyFieldFocused: Bool

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Provider Catalog

    private var providerCatalog: [LLMProviderEntry] {
        LLMProviderRegistry.providers
    }

    // MARK: - Provider Helpers

    private var currentProviderEntry: LLMProviderEntry? {
        providerCatalog.first { $0.id == state.selectedProvider }
    }

    private var providerDisplayName: String {
        currentProviderEntry?.displayName ?? state.selectedProvider
    }

    private var providerRequiresKey: Bool {
        currentProviderEntry?.setupMode != .keyless
    }

    // MARK: - Body

    var body: some View {
        Text("Connect a Model Provider")
            .font(VFont.titleLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Enter an API key to connect your model provider.")
            .font(VFont.bodyMediumLighter)
            .multilineTextAlignment(.center)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: 0) {
            VStack(spacing: VSpacing.lg) {
                providerPicker

                if providerRequiresKey {
                    apiKeyField
                }

                if providerRequiresKey,
                   let apiKeyUrl = currentProviderEntry?.credentialsGuide?.url,
                   let url = URL(string: apiKeyUrl) {
                    HStack(spacing: VSpacing.sm) {
                        Text("Don't have it?")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        Text("Get an API key here")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .underline()
                            .accessibilityAddTraits(.isLink)
                            .onTapGesture {
                                NSWorkspace.shared.open(url)
                            }
                            .pointerCursor()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            VStack(spacing: VSpacing.sm) {
                VButton(label: "Continue", style: .primary, isFullWidth: true, isDisabled: providerRequiresKey && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    saveAndHatch()
                }

                VButton(label: "Back", style: .outlined, isFullWidth: true) {
                    goBack()
                }
            }
            .padding(.top, VSpacing.xxl)
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if let existingKey = APIKeyManager.getKey(for: state.selectedProvider) {
                apiKey = existingKey
                hasExistingKey = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard !Task.isCancelled else { return }
                keyFieldFocused = true
            }
        }
        .onChange(of: state.selectedProvider) { _, newProvider in
            if let entry = providerCatalog.first(where: { $0.id == newProvider }) {
                state.selectedModel = entry.defaultModel
            }
            if let existingKey = APIKeyManager.getKey(for: newProvider) {
                apiKey = existingKey
                hasExistingKey = true
                isEditing = false
            } else {
                apiKey = ""
                hasExistingKey = false
                isEditing = false
            }
        }

        Spacer()

        if let characters = Self.welcomeCharacters {
            Image(nsImage: characters)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(UnevenRoundedRectangle(
                    topLeadingRadius: 0,
                    bottomLeadingRadius: VRadius.window,
                    bottomTrailingRadius: VRadius.window,
                    topTrailingRadius: 0
                ))
                .opacity(showCharacters ? 1 : 0)
                .offset(y: showCharacters ? 0 : 30)
                .animation(.easeOut(duration: 0.6).delay(0.5), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
        }
    }

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $state.selectedProvider,
                options: providerCatalog.map { entry in
                    (label: entry.displayName, value: entry.id)
                }
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        Group {
            if hasExistingKey && !isEditing {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("\(providerDisplayName) API Key")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(maskedKey)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .frame(height: 32)
                        .vInputChrome()
                        .onTapGesture {
                            isEditing = true
                            Task { @MainActor in
                                try? await Task.sleep(nanoseconds: 100_000_000)
                                guard !Task.isCancelled else { return }
                                keyFieldFocused = true
                            }
                        }
                }
            } else {
                VTextField(
                    "\(providerDisplayName) API Key",
                    placeholder: currentProviderEntry?.apiKeyPlaceholder ?? "Enter your API key",
                    text: $apiKey,
                    isSecure: true,
                    onSubmit: {
                        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        saveAndHatch()
                    },
                    isFocused: $keyFieldFocused
                )
            }
        }
        .frame(maxWidth: .infinity)
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
        guard !providerRequiresKey || !trimmed.isEmpty else { return }
        if providerRequiresKey {
            APIKeyManager.setKey(trimmed, for: state.selectedProvider)
            let provider = state.selectedProvider
            Task { await APIKeyManager.setKey(trimmed, for: provider) }
        }
        state.advance()
    }
}
