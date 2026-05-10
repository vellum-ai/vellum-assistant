import SwiftUI
import VellumAssistantShared

/// Card for the text-to-speech service with Managed/Your Own mode toggle.
///
/// Managed mode is disabled (not yet available) — the card always shows the
/// "Your Own" provider configuration. Extracted from `VoiceSettingsView` to
/// live alongside other service cards on the Models & Services page.
@MainActor
struct TTSServiceCard: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("ttsProvider") private var ttsProviderRaw: String = "elevenlabs"

    // Draft state (mirrors Inference card pattern) — only persisted on Save.
    @State private var draftTTSProvider: String = "elevenlabs"
    @State private var ttsApiKeyText: String = ""
    @State private var ttsVoiceIdText: String = ""
    @State private var initialVoiceId: String = ""
    @State private var initialTTSProvider: String = "elevenlabs"
    @State private var ttsProviderHasKey: Bool = false
    @State private var ttsSaving: Bool = false
    @State private var ttsSaveError: String? = nil
    @State private var testPlayer = TTSTestPlayer()

    private let ttsRegistry = loadTTSProviderRegistry()

    private var selectedTTSProvider: TTSProviderCatalogEntry? {
        ttsRegistry.provider(withId: draftTTSProvider) ?? ttsRegistry.providers.first
    }

    private var ttsProviderUsesSharedKey: Bool {
        SettingsStore.ttsKeyIsShared(for: draftTTSProvider)
    }

    private var ttsHasChanges: Bool {
        let providerChanged = draftTTSProvider != initialTTSProvider
        let hasNewKey = !ttsApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let voiceIdChanged = ttsVoiceIdText.trimmingCharacters(in: .whitespacesAndNewlines) != initialVoiceId
        return providerChanged || hasNewKey || voiceIdChanged
    }

    private var ttsResetAllowed: Bool {
        ttsProviderHasKey && SettingsStore.ttsKeyIsExclusive(for: draftTTSProvider)
    }

    private var ttsTestPhrase: String {
        let name = AssistantDisplayName.resolve(
            IdentityInfo.loadFromDiskCache()?.name,
            fallback: "your assistant"
        )
        return "Hey! It's \(name). How does this sound?"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Text-to-Speech")
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text("Choose a TTS provider for voice conversations and read-aloud.")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                Spacer()
                DisabledManagedSegmentControl(
                    tooltip: "Managed mode is not provided at this time."
                )
            }

            Rectangle()
                .fill(VColor.surfaceBase)
                .frame(height: 1)

            // "Your Own" content
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Provider dropdown
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Provider")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a provider\u{2026}",
                        selection: $draftTTSProvider,
                        options: ttsRegistry.providers.map { entry in
                            (label: entry.displayName, value: entry.id)
                        }
                    )
                }

                // Shared-key note
                ttsSharedKeyNote

                // API key field
                ttsApiKeyField

                // Voice ID field (provider-specific)
                ttsVoiceIdField

                // Credentials guide
                ttsCredentialsGuideView

                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: testPlayer.isLoading ? "Testing\u{2026}" : "Test",
                        style: .outlined,
                        isDisabled: testPlayer.isLoading
                    ) {
                        Task { await testPlayer.playTest(text: ttsTestPhrase) }
                    }

                    ServiceCardActions(
                        hasChanges: ttsHasChanges,
                        isSaving: ttsSaving,
                        onSave: { saveTTS() },
                        savingLabel: "Saving...",
                        onReset: {
                            store.clearTTSKey(ttsProviderId: draftTTSProvider)
                            ttsProviderHasKey = false
                            ttsApiKeyText = ""
                        },
                        showReset: ttsResetAllowed
                    )
                }

                if let testError = testPlayer.error {
                    VNotification(testError, tone: .negative)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(radius: VRadius.xl)
        .onDisappear {
            testPlayer.stop()
        }
        .task {
            // Pull the current api_key inventory so the api-key branch of
            // `ttsCredentialExists` reports correctly. Re-evaluate
            // `ttsProviderHasKey` after refresh lands since `.onAppear` runs
            // first with whatever snapshot the store happens to hold. The
            // credential-mode branch reads keychain directly so it doesn't
            // need the providerKeys cache, but the cache fallback below still
            // helps the api-key branch on first-load transport failure.
            let refreshed = await store.refreshProviderKeys()
            if !refreshed && store.providerKeys.isEmpty {
                // Per-provider fallback only matters for api-key mode; the
                // credential-mode branch of `ttsCredentialExists` reads
                // keychain so it's already correct without a refresh.
                let entry = loadTTSProviderRegistry().provider(withId: draftTTSProvider)
                if case .apiKey = entry?.credentialMode {
                    let keyProvider = entry?.apiKeyProviderName ?? draftTTSProvider
                    if await APIKeyManager.hasKey(for: keyProvider) {
                        store.insertProviderKey(keyProvider)
                    }
                }
            }
            ttsProviderHasKey = store.ttsCredentialExists(for: draftTTSProvider)
        }
        .onAppear {
            draftTTSProvider = ttsProviderRaw
            initialTTSProvider = ttsProviderRaw
            ttsProviderHasKey = store.ttsCredentialExists(for: ttsProviderRaw)
            let voiceId = storedVoiceId(for: ttsProviderRaw)
            ttsVoiceIdText = voiceId
            initialVoiceId = voiceId
        }
        .onChange(of: draftTTSProvider) { _, _ in
            ttsApiKeyText = ""
            ttsSaveError = nil
            ttsProviderHasKey = store.ttsCredentialExists(for: draftTTSProvider)
            let voiceId = storedVoiceId(for: draftTTSProvider)
            ttsVoiceIdText = voiceId
            initialVoiceId = voiceId
        }
    }

    // MARK: - Shared Key Note

    @ViewBuilder
    private var ttsSharedKeyNote: some View {
        if ttsProviderUsesSharedKey {
            HStack(alignment: .top, spacing: VSpacing.xs) {
                VIconView(.info, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
                Text("This API key is shared with \(selectedTTSProvider?.displayName ?? "the provider") speech-to-text.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineSpacing(1)
            }
        }
    }

    // MARK: - API Key Field

    private var ttsApiKeyField: some View {
        APIKeyTextField(
            label: "\(selectedTTSProvider?.displayName ?? "Provider") API Key",
            hasKey: ttsProviderHasKey,
            text: $ttsApiKeyText,
            errorMessage: ttsSaveError
        )
        .disabled(ttsSaving)
    }

    // MARK: - Voice ID Field

    @ViewBuilder
    private var ttsVoiceIdField: some View {
        if selectedTTSProvider?.supportsVoiceSelection == true {
            VTextField(
                "Voice ID",
                placeholder: "\(selectedTTSProvider?.displayName ?? "Provider") Voice ID (optional)",
                text: $ttsVoiceIdText
            )
        }
    }

    // MARK: - Credentials Guide

    @ViewBuilder
    private var ttsCredentialsGuideView: some View {
        if let guide = selectedTTSProvider?.credentialsGuide,
           let attributed = try? AttributedString(
               markdown: "\(guide.description) [\(guide.linkLabel)](\(guide.url))"
           ) {
            Text(attributed)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .tint(VColor.primaryBase)
                .lineSpacing(1)
                .environment(\.openURL, OpenURLAction { url in
                    NSWorkspace.shared.open(url)
                    return .handled
                })
        }
    }

    // MARK: - Save

    private func saveTTS() {
        ttsSaving = true
        ttsSaveError = nil

        if draftTTSProvider != ttsProviderRaw {
            store.setTTSProvider(draftTTSProvider)
            ttsProviderRaw = draftTTSProvider
        }

        let trimmedVoiceId = ttsVoiceIdText.trimmingCharacters(in: .whitespacesAndNewlines)
        switch draftTTSProvider {
        case "elevenlabs":
            store.setElevenLabsVoiceId(trimmedVoiceId)
        case "fish-audio":
            store.setFishAudioReferenceId(trimmedVoiceId)
        default:
            break
        }

        let trimmedKey = ttsApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty {
            ttsApiKeyText = ""
            ttsProviderHasKey = true
            store.saveTTSKey(trimmedKey, ttsProviderId: draftTTSProvider)
        }

        ttsSaving = false
        initialTTSProvider = draftTTSProvider
        initialVoiceId = trimmedVoiceId
    }

    private func storedVoiceId(for provider: String) -> String {
        switch provider {
        case "elevenlabs":
            return store.elevenLabsVoiceId
        case "fish-audio":
            return store.fishAudioReferenceId
        default:
            return ""
        }
    }
}
