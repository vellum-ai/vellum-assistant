import SwiftUI

public struct SettingsView: View {
    @State private var apiKeyText = ""
    @State private var hasKey = APIKeyManager.getKey() != nil
    @State private var braveKeyText = ""
    @State private var hasBraveKey = APIKeyManager.getKey(for: "brave") != nil
    @State private var maxSteps: Double = {
        let val = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        return val == 0 ? 50 : val
    }()
    @State private var accessibilityGranted = false
    @State private var screenRecordingGranted = false
    @State private var ambientEnabled = UserDefaults.standard.bool(forKey: "ambientAgentEnabled")
    @State private var ambientInterval: Double = {
        let val = UserDefaults.standard.double(forKey: "ambientCaptureInterval")
        return val == 0 ? 30 : val
    }()
    @State private var showingPrivacy = false
    @State private var showingSkills = false
    @State private var showingTrustRules = false
    @State private var skillsViewModel: SkillsSettingsViewModel?
    @State private var activationKey: ActivationKey = {
        let stored = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        return ActivationKey(rawValue: stored) ?? .fn
    }()
    var ambientAgent: AmbientAgent
    var daemonClient: DaemonClient?

    public init(ambientAgent: AmbientAgent, daemonClient: DaemonClient? = nil) {
        self.ambientAgent = ambientAgent
        self.daemonClient = daemonClient
    }

    // Re-check permissions every 2 seconds while the window is open
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    public var body: some View {
        Form {
            Section("Anthropic API Key") {
                if hasKey {
                    HStack {
                        Text("sk-ant-...configured")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            APIKeyManager.deleteKey()
                            hasKey = false
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
                            let trimmed = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !trimmed.isEmpty else { return }
                            APIKeyManager.setKey(trimmed)
                            hasKey = true
                            apiKeyText = ""
                        }
                        .disabled(apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Brave Search API Key") {
                if hasBraveKey {
                    HStack {
                        Text("BSA...configured")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            APIKeyManager.deleteKey(for: "brave")
                            hasBraveKey = false
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
                            let trimmed = braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !trimmed.isEmpty else { return }
                            APIKeyManager.setKey(trimmed, for: "brave")
                            hasBraveKey = true
                            braveKeyText = ""
                        }
                        .disabled(braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            Section("Computer Use") {
                HStack {
                    Text("Max steps per session")
                    Spacer()
                    Text("\(Int(maxSteps))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $maxSteps, in: 10...100, step: 10)
                    .onChange(of: maxSteps) { _, newValue in
                        UserDefaults.standard.set(newValue, forKey: "maxStepsPerSession")
                    }
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

            Section("Ambient Agent") {
                Toggle("Enable ambient screen watching", isOn: $ambientEnabled)
                    .onChange(of: ambientEnabled) { _, newValue in
                        UserDefaults.standard.set(newValue, forKey: "ambientAgentEnabled")
                        ambientAgent.isEnabled = newValue
                    }

                if ambientEnabled {
                    HStack {
                        Text("Capture interval")
                        Spacer()
                        Text("\(Int(ambientInterval))s")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $ambientInterval, in: 10...120, step: 5)
                        .onChange(of: ambientInterval) { _, newValue in
                            UserDefaults.standard.set(newValue, forKey: "ambientCaptureInterval")
                            ambientAgent.captureIntervalSeconds = newValue
                        }

                    KnowledgeSection(store: ambientAgent.knowledgeStore)

                    if let insightStore = ambientAgent.insightStore {
                        InsightsSection(store: insightStore)
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
                            showingTrustRules = true
                        }
                        .disabled(showingTrustRules)
                    }
                }
            }

            Section("Privacy & Security") {
                PrivacyBullet(icon: "eye.slash", text: "AI only runs when you trigger it or enable ambient mode")
                PrivacyBullet(icon: "lock.shield", text: "API key stored in macOS Keychain")
                PrivacyBullet(icon: "xmark.shield", text: "Your data is not used to train AI models")
                PrivacyBullet(icon: "internaldrive", text: "Session logs and knowledge stored locally on your Mac")

                Button("Learn More") {
                    showingPrivacy = true
                }
                .font(.caption)
                .sheet(isPresented: $showingPrivacy) {
                    PrivacyDetailView()
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 450, height: 700)
        .onAppear {
            refreshAPIKeyState()
            checkPermissions()
        }
        .onReceive(permissionTimer) { _ in
            checkPermissions()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
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
    }

    private func checkPermissions() {
        accessibilityGranted = PermissionManager.accessibilityStatus() == .granted
        let status = PermissionManager.screenRecordingStatus()
        screenRecordingGranted = status == .granted
    }

    private func refreshAPIKeyState() {
        hasKey = APIKeyManager.getKey() != nil
        hasBraveKey = APIKeyManager.getKey(for: "brave") != nil
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

// MARK: - Insights Section

private struct InsightsSection: View {
    @ObservedObject var store: InsightStore
    @State private var showingInsights = false

    var body: some View {
        HStack {
            Text("Insights found")
            Spacer()
            Text("\(store.insightCount)")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }

        HStack {
            Button("View Insights") {
                showingInsights = true
            }
            .disabled(store.insights.isEmpty)

            Spacer()

            Button("Clear All") {
                store.clearAll()
            }
            .tint(.red)
            .disabled(store.insights.isEmpty)
        }
        .sheet(isPresented: $showingInsights) {
            InsightsListView(store: store)
        }
    }
}

private struct InsightsListView: View {
    @ObservedObject var store: InsightStore
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Knowledge Insights (\(store.insightCount))")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding()

            Divider()

            if store.insights.isEmpty {
                Spacer()
                Text("No insights yet")
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                List {
                    ForEach(store.insights.reversed()) { insight in
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(insight.title)
                                        .fontWeight(.bold)
                                    Text(insight.category.rawValue.capitalized)
                                        .font(.caption2)
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 1)
                                        .background(categoryColor(insight.category).opacity(0.2))
                                        .foregroundStyle(categoryColor(insight.category))
                                        .clipShape(Capsule())
                                }
                                Text(insight.description)
                                    .foregroundStyle(.secondary)
                                HStack(spacing: 4) {
                                    Text(insight.timestamp, style: .relative)
                                    Text("ago")
                                    Text("\u{00b7}")
                                    Text("\(Int(insight.confidence * 100))%")
                                }
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            Button {
                                store.dismissInsight(id: insight.id)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 2)
                        .opacity(insight.dismissed ? 0.5 : 1.0)
                    }
                }
            }
        }
        .frame(width: 550, height: 450)
    }

    private func categoryColor(_ category: InsightCategory) -> Color {
        switch category {
        case .pattern: return Indigo._600
        case .automation: return Emerald._600
        case .insight: return Amber._600
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
                            "Velly only activates AI when you explicitly trigger a task, use voice input, or enable the ambient agent. It does not run in the background unless you opt in.",
                            "You are always in control. You can disable the ambient agent, revoke permissions, or clear stored data at any time from Settings.",
                        ]
                    )

                    privacySection(
                        title: "What Data Leaves Your Mac",
                        items: [
                            "When you run a task: screenshots (compressed, max 1280x720) and UI element data (window titles, button labels, text field values) are sent to the Anthropic API over HTTPS.",
                            "When ambient mode is on: extracted on-screen text (via on-device OCR) and the active app name are sent to Anthropic for analysis. If sync is enabled, ambient observations and insights are also sent to the Velly backend.",
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
                            "Insights: Settings > Ambient Agent > Clear All",
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

#Preview {
    SettingsView(ambientAgent: AmbientAgent())
}
