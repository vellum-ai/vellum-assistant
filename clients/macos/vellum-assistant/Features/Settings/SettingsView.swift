import Combine
import SwiftUI
import VellumAssistantShared

public struct SettingsView: View {
    @ObservedObject var store: SettingsStore
    @State private var apiKeyText = ""
    @State private var braveKeyText = ""
    @State private var perplexityKeyText = ""
    @State private var imageGenKeyText = ""
    @State private var openaiKeyText = ""
    @State private var vercelKeyText = ""
    @State private var twitterClientId = ""
    @State private var twitterClientSecret = ""
    @State private var ingressUrlText = ""
    @FocusState private var isIngressUrlFocused: Bool
    @State private var accessibilityGranted = false
    @State private var screenRecordingGranted = false
    @State private var showingPrivacy = false
    @State private var showingSkills = false
    @State private var showingTrustRules = false
    @State private var newAllowlistDomain = ""
    #if DEBUG
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    #endif
    @State private var skillsViewModel: SkillsSettingsViewModel?
    @State private var activationKey: ActivationKey = {
        let stored = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        return ActivationKey(rawValue: stored) ?? .fn
    }()
    var daemonClient: DaemonClient?

    public init(store: SettingsStore, daemonClient: DaemonClient? = nil) {
        self.store = store
        self.daemonClient = daemonClient
    }

    // Re-check permissions every 2 seconds while the window is open
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    public var body: some View {
        Form {
            Section("Anthropic API Key") {
                if store.hasKey {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.system(size: 14))
                        Text(store.maskedKey)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearAPIKey()
                            apiKeyText = ""
                        }
                        .tint(.red)
                    }
                } else {
                    SecureField("Enter API key", text: $apiKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API key at console.anthropic.com")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.saveAPIKey(apiKeyText)
                            apiKeyText = ""
                        }
                        .disabled(apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            if store.hasKey {
                Section("Model") {
                    Picker("Active model", selection: $store.selectedModel) {
                        ForEach(SettingsStore.availableModels, id: \.self) { model in
                            Text(SettingsStore.modelDisplayNames[model] ?? model)
                                .tag(model)
                        }
                    }
                    .onChange(of: store.selectedModel) { _, newValue in
                        store.setModel(newValue)
                    }
                }
            }

            Section("Perplexity API Key") {
                if store.hasPerplexityKey {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.system(size: 14))
                        Text(store.maskedPerplexityKey)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearPerplexityKey()
                            perplexityKeyText = ""
                        }
                        .tint(.red)
                    }
                } else {
                    SecureField("Enter Perplexity API key", text: $perplexityKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API key at perplexity.ai/settings/api")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.savePerplexityKey(perplexityKeyText)
                            perplexityKeyText = ""
                        }
                        .disabled(perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Brave Search API Key") {
                if store.hasBraveKey {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.system(size: 14))
                        Text(store.maskedBraveKey)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearBraveKey()
                            braveKeyText = ""
                        }
                        .tint(.red)
                    }
                } else {
                    SecureField("Enter Brave Search API key", text: $braveKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API key at brave.com/search/api")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.saveBraveKey(braveKeyText)
                            braveKeyText = ""
                        }
                        .disabled(braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Image Generation") {
                if store.hasImageGenKey {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.system(size: 14))
                        Text(store.maskedImageGenKey)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearImageGenKey()
                            imageGenKeyText = ""
                        }
                        .tint(.red)
                    }

                    Picker("Model", selection: $store.selectedImageGenModel) {
                        ForEach(SettingsStore.availableImageGenModels, id: \.self) { model in
                            Text(SettingsStore.imageGenModelDisplayNames[model] ?? model)
                                .tag(model)
                        }
                    }
                    .onChange(of: store.selectedImageGenModel) { _, newValue in
                        store.setImageGenModel(newValue)
                    }
                } else {
                    SecureField("Enter Gemini API key", text: $imageGenKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API key at aistudio.google.com/apikey")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.saveImageGenKey(imageGenKeyText)
                            imageGenKeyText = ""
                        }
                        .disabled(imageGenKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("OpenAI API Key") {
                if store.hasOpenAIKey {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.system(size: 14))
                        Text(store.maskedOpenAIKey)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearOpenAIKey()
                            openaiKeyText = ""
                        }
                        .tint(.red)
                    }
                } else {
                    SecureField("Enter OpenAI API key", text: $openaiKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API key at platform.openai.com/api-keys")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.saveOpenAIKey(openaiKeyText)
                            openaiKeyText = ""
                        }
                        .disabled(openaiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Vercel API Key") {
                if store.hasVercelKey {
                    HStack {
                        Text("Token configured")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.clearVercelKey()
                            vercelKeyText = ""
                        }
                        .tint(.red)
                    }
                } else {
                    SecureField("Enter Vercel API token", text: $vercelKeyText)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Text("Get your API token at vercel.com/account/tokens")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") {
                            store.saveVercelKey(vercelKeyText)
                        }
                        .disabled(vercelKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Twitter / X") {
                Picker("Integration mode", selection: $store.twitterMode) {
                    Text("Local (BYO App)").tag("local_byo")
                    Text("Managed").tag("managed")
                }
                .pickerStyle(.segmented)
                .onChange(of: store.twitterMode) { _, newValue in
                    store.setTwitterMode(newValue)
                }

                if store.twitterMode == "managed" {
                    HStack(spacing: 6) {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.secondary)
                        Text("Managed mode is coming soon. Switch to Local (BYO App) to connect now.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if store.twitterMode == "local_byo" {
                    if !store.twitterLocalClientConfigured {
                        VStack(alignment: .leading, spacing: 6) {
                            TextField("OAuth Client ID", text: $twitterClientId)
                                .textFieldStyle(.roundedBorder)
                            SecureField("OAuth Client Secret (optional)", text: $twitterClientSecret)
                                .textFieldStyle(.roundedBorder)
                            HStack {
                                Text("Create an app at developer.x.com")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Save") {
                                    store.saveTwitterLocalClient(
                                        clientId: twitterClientId,
                                        clientSecret: twitterClientSecret.isEmpty ? nil : twitterClientSecret
                                    )
                                    twitterClientId = ""
                                    twitterClientSecret = ""
                                }
                                .disabled(twitterClientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                    } else {
                        if store.twitterConnected {
                            HStack(spacing: 6) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                    .font(.system(size: 14))
                                Text("Connected")
                                    .foregroundStyle(.secondary)
                                if let account = store.twitterAccountInfo {
                                    Text(account)
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Button("Disconnect") {
                                    store.disconnectTwitter()
                                }
                                .tint(.red)
                            }
                        } else {
                            HStack(spacing: 6) {
                                Image(systemName: "circle")
                                    .foregroundStyle(.tertiary)
                                    .font(.system(size: 14))
                                Text("App configured")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                if store.twitterAuthInProgress {
                                    ProgressView()
                                        .controlSize(.small)
                                    Text("Connecting...")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Button("Connect") {
                                        store.connectTwitter()
                                    }
                                }
                            }
                        }

                        if let error = store.twitterAuthError {
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.red)
                        }

                        HStack {
                            Spacer()
                            Button("Clear App Config") {
                                store.clearTwitterLocalClient()
                                twitterClientId = ""
                                twitterClientSecret = ""
                            }
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        }
                    }
                }
            }

            Section("Public Ingress") {
                Toggle("Enable Public Ingress", isOn: Binding(
                    get: { store.ingressEnabled },
                    set: { store.setIngressEnabled($0) }
                ))
                .disabled(store.ingressPublicBaseUrl.isEmpty && !store.ingressEnabled)

                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.system(size: 12))
                    Text("Setting a public base URL may expose this computer to the public internet. Use with caution.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                TextField("Public Ingress URL (e.g. https://abc123.ngrok-free.app)", text: $ingressUrlText)
                    .focused($isIngressUrlFocused)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Spacer()
                    Button("Save") {
                        store.saveIngressPublicBaseUrl(ingressUrlText)
                    }
                }

                Divider()

                HStack {
                    Text("Local Gateway Target")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }

                HStack(spacing: 6) {
                    Text(store.localGatewayTarget)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(store.localGatewayTarget, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Copy gateway address")
                    .help("Copy address")
                }

                Text("Point your tunnel service at this local address.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Computer Use") {
                HStack {
                    Text("Max steps per session")
                    Spacer()
                    Text("\(Int(store.maxSteps))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $store.maxSteps, in: 10...100, step: 10)
            }

            Section("Voice Activation") {
                Picker("Activation key", selection: $activationKey) {
                    ForEach(ActivationKey.allCases, id: \.self) { key in
                        Text(key.displayName).tag(key)
                    }
                }
                .onChange(of: activationKey) { _, newValue in
                    UserDefaults.standard.set(newValue.rawValue, forKey: "activationKey")
                }

                Text("Hold the activation key to start voice input. Set to Off to disable voice activation.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Notifications") {
                Toggle("Notify when tasks complete", isOn: $store.activityNotificationsEnabled)

                Text("Get notified when computer-use sessions finish so you don't need to watch progress.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Media Embeds") {
                Toggle("Auto media embeds", isOn: Binding(
                    get: { store.mediaEmbedsEnabled },
                    set: { store.setMediaEmbedsEnabled($0) }
                ))

                Text("Automatically embed images, videos, and other media shared in chat messages.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if store.mediaEmbedsEnabled {
                    Divider()

                    Text("Video Domain Allowlist")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    HStack {
                        TextField("Add domain (e.g. example.com)", text: $newAllowlistDomain)
                            .textFieldStyle(.roundedBorder)
                        Button("Add") {
                            let domain = newAllowlistDomain
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !domain.isEmpty else { return }
                            var domains = store.mediaEmbedVideoAllowlistDomains
                            domains.append(domain)
                            store.setMediaEmbedVideoAllowlistDomains(domains)
                            newAllowlistDomain = ""
                        }
                        .disabled(newAllowlistDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                        HStack {
                            Text(domain)
                                .font(.body)
                            Spacer()
                            Button {
                                var domains = store.mediaEmbedVideoAllowlistDomains
                                domains.removeAll { $0 == domain }
                                store.setMediaEmbedVideoAllowlistDomains(domains)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                        }
                    }

                    HStack {
                        Spacer()
                        Button("Reset to Defaults") {
                            store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)
                        }
                        .font(.caption)
                    }
                }
            }

            Section("Permissions") {
                HStack {
                    Image(systemName: accessibilityGranted ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(accessibilityGranted ? .green : .red)
                    Text("Accessibility")
                    Spacer()
                    if !accessibilityGranted {
                        Button("Grant") {
                            _ = PermissionManager.accessibilityStatus(prompt: true)
                            checkPermissions()
                        }
                    }
                }

                HStack {
                    Image(systemName: screenRecordingGranted ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(screenRecordingGranted ? .green : .red)
                    Text("Screen Recording")
                    Spacer()
                    if !screenRecordingGranted {
                        Button("Check") {
                            let status = PermissionManager.screenRecordingStatus()
                            screenRecordingGranted = status == .granted
                        }
                    }
                }
            }

            if let daemonClient {
                Section("Skills") {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Manage Skills")
                            Text("Enable, disable, and browse available skills")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Manage Skills...") {
                            skillsViewModel = SkillsSettingsViewModel(daemonClient: daemonClient)
                            showingSkills = true
                        }
                    }
                }

                Section("Trust Rules") {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Manage Trust Rules")
                            Text("Control which tool actions are automatically allowed or denied")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Manage Trust Rules...") {
                            daemonClient.isTrustRulesSheetOpen = true
                            showingTrustRules = true
                        }
                        .disabled(store.isAnyTrustRulesSheetOpen)
                    }
                }
            }

            Section("Privacy & Security") {
                PrivacyBullet(icon: "eye.slash", text: "AI only runs when you explicitly trigger it")
                PrivacyBullet(icon: "lock.shield", text: "API key stored in macOS Keychain")
                PrivacyBullet(icon: "xmark.shield", text: "Your data is not used to train AI models")
                PrivacyBullet(icon: "internaldrive", text: "Session logs and knowledge stored locally on your Mac")

                Button("Learn More") {
                    showingPrivacy = true
                }
                .font(.caption)
            }

            if FeatureFlagManager.shared.isEnabled(.featureFlagEditorEnabled) {
                FeatureFlagEditorSection()
            }

            #if DEBUG
            if let daemonClient {
                Section("Developer") {
                    Button("View Environment Variables") {
                        appEnvVars = ProcessInfo.processInfo.environment
                            .sorted(by: { $0.key < $1.key })
                            .map { ($0.key, $0.value) }
                        daemonEnvVars = []
                        daemonClient.onEnvVarsResponse = { response in
                            Task { @MainActor in
                                self.daemonEnvVars = response.vars
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                            }
                        }
                        try? daemonClient.sendEnvVarsRequest()
                        showingEnvVars = true
                    }
                }
            }
            #endif
        }
        .formStyle(.grouped)
        .frame(width: 450, height: 700)
        .onAppear {
            store.refreshAPIKeyState()
            store.refreshVercelKeyState()
            store.refreshTwitterStatus()
            store.refreshIngressConfig()
            ingressUrlText = store.ingressPublicBaseUrl
            checkPermissions()
        }
        .onDisappear {
            #if DEBUG
            daemonClient?.onEnvVarsResponse = nil
            #endif
        }
        .onReceive(permissionTimer) { _ in
            checkPermissions()
        }
        .onChange(of: store.ingressPublicBaseUrl) { _, newValue in
            // Only sync from store when the field is not focused, so
            // background IPC responses don't overwrite in-progress edits.
            if !isIngressUrlFocused {
                ingressUrlText = newValue
            }
        }
        .onChange(of: isIngressUrlFocused) { _, focused in
            // Re-sync when focus leaves so any updates skipped while the
            // user was editing are applied once they're done.
            if !focused {
                ingressUrlText = store.ingressPublicBaseUrl
            }
        }
        .sheet(isPresented: $showingSkills, onDismiss: {
            skillsViewModel = nil
        }) {
            if let vm = skillsViewModel {
                SkillsSettingsView(viewModel: vm)
            }
        }
        .sheet(isPresented: $showingTrustRules) {
            if let daemonClient {
                TrustRulesView(daemonClient: daemonClient)
            }
        }
        .sheet(isPresented: $showingPrivacy) {
            PrivacyDetailView()
        }
        #if DEBUG
        .sheet(isPresented: $showingEnvVars) {
            EnvVarsSheetView(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        #endif
    }

    private func checkPermissions() {
        accessibilityGranted = PermissionManager.accessibilityStatus() == .granted
        let status = PermissionManager.screenRecordingStatus()
        screenRecordingGranted = status == .granted
    }

}

// MARK: - Feature Flag Editor

private struct FeatureFlagEditorSection: View {
    @State private var flagStates: [(key: String, enabled: Bool)] = []

    var body: some View {
        Section("Feature Flags") {
            if flagStates.isEmpty {
                Text("No feature flags configured")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(flagStates.enumerated()), id: \.element.key) { index, flag in
                    Toggle(flag.key, isOn: Binding(
                        get: { flagStates[index].enabled },
                        set: { newValue in
                            flagStates[index].enabled = newValue
                            FeatureFlagManager.shared.setOverride(flag.key, enabled: newValue)
                        }
                    ))
                    .font(.body.monospaced())
                }
            }
        }
        .onAppear {
            loadFlags()
        }
    }

    private func loadFlags() {
        let all = FeatureFlagManager.shared.allFlags()
        flagStates = all
            .sorted(by: { $0.key < $1.key })
            .map { (key: $0.key, enabled: $0.value) }
    }
}

// MARK: - Knowledge Section

private struct KnowledgeSection: View {
    @ObservedObject var store: KnowledgeStore
    @State private var showingEntries = false

    var body: some View {
        HStack {
            Text("Knowledge entries")
            Spacer()
            Text("\(store.entries.count)")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }

        HStack {
            Button("View Entries") {
                showingEntries = true
            }
            .disabled(store.entries.isEmpty)

            Spacer()

            Button("Clear All") {
                store.clearAll()
            }
            .tint(.red)
            .disabled(store.entries.isEmpty)
        }
        .sheet(isPresented: $showingEntries) {
            KnowledgeEntriesView(store: store)
        }
    }
}

// MARK: - Privacy & Security

private struct PrivacyBullet: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct PrivacyDetailView: View {
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Privacy & Security")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    privacySection(
                        title: "How Velly Works",
                        items: [
                            "Velly only activates AI when you explicitly trigger a task or use voice input. It does not run in the background unless you opt in.",
                            "You are always in control. You can disable the ambient agent, revoke permissions, or clear stored data at any time from Settings.",
                        ]
                    )

                    privacySection(
                        title: "What Data Leaves Your Mac",
                        items: [
                            "When you run a task: screenshots (compressed, max 1280x720) and UI element data (window titles, button labels, text field values) are sent to the Anthropic API over HTTPS.",
                            "Voice input: speech is transcribed on-device using Apple Speech Recognition. Only the final text is sent to Anthropic as part of the task.",
                        ]
                    )

                    privacySection(
                        title: "What Stays on Your Mac",
                        items: [
                            "Session logs (task descriptions, action history, UI element data) are stored in ~/Library/Application Support/vellum-assistant/logs/.",
                            "Knowledge entries and insights from the ambient agent are stored locally as JSON files.",
                            "Your API key is stored in the macOS Keychain, encrypted and accessible only when your Mac is unlocked.",
                            "Screenshots are sent to Anthropic for inference but are never saved to disk.",
                        ]
                    )

                    privacySection(
                        title: "AI Model Usage",
                        items: [
                            "Velly uses Anthropic's Claude models (Sonnet for tasks, Haiku for ambient analysis). All requests go through Anthropic's API.",
                            "Your data is not used to train AI models. Anthropic's commercial API terms prohibit using customer inputs for model training.",
                            "A safety layer actively detects and blocks sensitive data — passwords, credit card numbers, and SSNs — before any action is executed, in addition to AI-level instructions to never type such data.",
                        ]
                    )

                    privacySection(
                        title: "Permissions",
                        items: [
                            "Accessibility: required to read UI elements (button labels, text fields) and to control your Mac (clicking, typing) during tasks.",
                            "Screen Recording: required to capture screenshots so the AI can see what's on screen.",
                            "Microphone (optional): only used for voice input. Speech recognition runs on-device via Apple's API.",
                        ]
                    )

                    privacySection(
                        title: "Security Measures",
                        items: [
                            "All API communication uses HTTPS with TLS encryption.",
                            "A safety layer verifies every AI action before execution, blocking destructive key combinations and detecting action loops.",
                            "Text input uses a temporary clipboard swap (save, paste, restore) rather than keystroke injection, preventing keylogging exposure.",
                            "You can press Escape at any time to immediately cancel a running session.",
                        ]
                    )

                    privacySection(
                        title: "Data You Can Clear",
                        items: [
                            "API key: Settings > Anthropic API Key > Clear",
                            "Knowledge entries: Settings > Ambient Agent > Clear All",
                            "Session logs: delete files in ~/Library/Application Support/vellum-assistant/logs/",
                        ]
                    )

                    Text("If you have questions or concerns, contact us at privacy@vellum.ai")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding()
            }
        }
        .frame(width: 520, height: 500)
    }

    private func privacySection(title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline)
                .fontWeight(.semibold)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: 6) {
                    Text("\u{2022}")
                        .foregroundStyle(.tertiary)
                    Text(item)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct KnowledgeEntriesView: View {
    @ObservedObject var store: KnowledgeStore
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Knowledge Entries (\(store.entries.count))")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding()

            Divider()

            if store.entries.isEmpty {
                Spacer()
                Text("No entries yet")
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                List {
                    ForEach(store.entries.reversed()) { entry in
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.observation)
                                HStack(spacing: 4) {
                                    Text(entry.sourceApp)
                                    Text("\u{00b7}")
                                    Text(entry.timestamp, style: .relative)
                                    Text("ago")
                                    Text("\u{00b7}")
                                    Text("\(Int(entry.confidence * 100))%")
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                store.removeEntry(id: entry.id)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .frame(width: 500, height: 400)
    }
}

// MARK: - Environment Variables Sheet (Debug Only)

#if DEBUG
private struct EnvVarsSheetView: View {
    let appEnvVars: [(String, String)]
    let daemonEnvVars: [(String, String)]
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Environment Variables")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    envVarsSection(title: "App Process", vars: appEnvVars)
                    envVarsSection(title: "Daemon Process", vars: daemonEnvVars)
                }
                .padding()
            }
        }
        .frame(width: 600, height: 500)
    }

    private func envVarsSection(title: String, vars: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline)
                .fontWeight(.semibold)
            if vars.isEmpty {
                Text("Loading...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(vars, id: \.0) { key, value in
                    HStack(alignment: .top, spacing: 8) {
                        Text(key)
                            .font(.caption)
                            .fontWeight(.medium)
                            .frame(width: 200, alignment: .trailing)
                        Text(value)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Spacer()
                    }
                }
            }
        }
    }
}
#endif

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView(store: SettingsStore())
    }
}
