import SwiftUI
import VellumAssistantShared

/// Card for the speech-to-text service with Managed/Your Own mode toggle.
///
/// Managed mode is disabled (not yet available) — the card always shows the
/// "Your Own" provider configuration. Extracted from `VoiceSettingsView` to
/// live alongside other service cards on the Models & Services page.
@MainActor
struct STTServiceCard: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("sttProvider") private var sttProviderRaw: String = ""

    // Draft state — only persisted on Save.
    @State private var draftSTTProvider: String = ""
    @State private var sttApiKeyText: String = ""
    @State private var initialSTTProvider: String = ""
    @State private var sttProviderHasKey: Bool = false
    @State private var sttSaving: Bool = false
    @State private var sttSaveError: String? = nil
    @State private var sttRegistry = loadSTTProviderRegistry()

    private var selectedSTTProvider: STTProviderCatalogEntry? {
        sttRegistry.provider(withId: draftSTTProvider) ?? sttRegistry.providers.first
    }

    private var sttHasChanges: Bool {
        let providerChanged = draftSTTProvider != initialSTTProvider
        let hasNewKey = !sttApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return providerChanged || hasNewKey
    }

    private var sttResetAllowed: Bool {
        sttProviderHasKey && SettingsStore.sttKeyIsExclusive(for: draftSTTProvider)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Speech-to-Text")
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text("Choose an STT provider for audio transcription.")
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
                        selection: $draftSTTProvider,
                        options: sttRegistry.providers.map { entry in
                            (label: entry.displayName, value: entry.id)
                        }
                    )
                }

                // API key field
                sttApiKeyField

                // Credentials guide
                sttCredentialsGuideView

                // Save + Reset actions
                ServiceCardActions(
                    hasChanges: sttHasChanges,
                    isSaving: sttSaving,
                    onSave: { saveSTT() },
                    savingLabel: "Saving...",
                    onReset: { resetSTTKey() },
                    showReset: sttResetAllowed
                )

                if let sttSaveError {
                    VNotification(sttSaveError, tone: .negative)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(radius: VRadius.xl)
        .task {
            await refreshSTTProviderRegistry()
            sttRegistry = loadSTTProviderRegistry()
            // Pull the current api_key inventory so `sttKeyExists` reports
            // correctly. `.onAppear` runs before this `.task` body resolves,
            // so we re-evaluate after the refresh lands. If the bulk refresh
            // fails on first load (cache empty), fall back to a per-provider
            // check so we don't show "not configured" when a key is actually
            // present.
            let refreshed = await store.refreshProviderKeys()
            if refreshed || !store.providerKeys.isEmpty {
                sttProviderHasKey = sttKeyExists(for: draftSTTProvider)
            } else {
                sttProviderHasKey = await store.hasSTTKey(sttProviderId: draftSTTProvider)
            }
        }
        .onAppear {
            draftSTTProvider = sttProviderRaw
            initialSTTProvider = sttProviderRaw
            sttProviderHasKey = sttKeyExists(for: draftSTTProvider)
        }
        .onChange(of: draftSTTProvider) { _, _ in
            sttApiKeyText = ""
            sttSaveError = nil
            sttProviderHasKey = sttKeyExists(for: draftSTTProvider)
        }
    }

    // MARK: - API Key Field

    private var sttApiKeyField: some View {
        APIKeyTextField(
            label: "\(selectedSTTProvider?.displayName ?? "Provider") API Key",
            hasKey: sttProviderHasKey,
            text: $sttApiKeyText
        )
        .disabled(sttSaving)
    }

    // MARK: - Credentials Guide

    @ViewBuilder
    private var sttCredentialsGuideView: some View {
        if let guide = selectedSTTProvider?.credentialsGuide,
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

    // MARK: - Helpers

    private func sttKeyExists(for sttProviderId: String) -> Bool {
        let keyProvider = SettingsStore.sttApiKeyProviderName(for: sttProviderId)
        return store.providerKeys.contains(keyProvider)
    }

    private func resetSTTKey() {
        store.clearSTTKey(sttProviderId: draftSTTProvider)
        sttProviderHasKey = false
        sttApiKeyText = ""
    }

    // MARK: - Save

    private func saveSTT() {
        sttSaving = true
        sttSaveError = nil

        if draftSTTProvider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let resolved = selectedSTTProvider?.id {
            draftSTTProvider = resolved
        }

        let providerToSave = draftSTTProvider
        let providerChanged = providerToSave != sttProviderRaw
        let trimmedKey = sttApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            var providerSaveSucceeded = true
            var keySaveSucceeded = true

            if providerChanged {
                providerSaveSucceeded = await store.setSTTProvider(providerToSave).value
                if providerSaveSucceeded {
                    sttProviderRaw = providerToSave
                } else {
                    sttSaveError = "Could not save speech-to-text provider selection. Please try again."
                }
            }

            if !trimmedKey.isEmpty {
                let keyResult = await store.saveSTTKeyResult(
                    trimmedKey,
                    sttProviderId: providerToSave
                )
                keySaveSucceeded = keyResult.success
                if keyResult.success {
                    sttApiKeyText = ""
                    sttProviderHasKey = true
                } else {
                    sttSaveError = keyResult.error
                        ?? "Could not save speech-to-text API key. Please try again."
                }
            }

            if providerSaveSucceeded {
                initialSTTProvider = providerToSave
            }

            if providerSaveSucceeded && keySaveSucceeded {
                sttSaveError = nil
            } else if !providerSaveSucceeded && !keySaveSucceeded {
                sttSaveError = "Could not save speech-to-text settings. Please try again."
            }

            sttSaving = false
        }
    }
}
