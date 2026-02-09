import SwiftUI

struct SettingsView: View {
    @State private var apiKeyText = ""
    @State private var hasKey = APIKeyManager.getKey() != nil
    @AppStorage("maxStepsPerSession") private var maxSteps: Double = 50
    @State private var accessibilityGranted = false
    @State private var screenRecordingGranted = false
    @State private var ambientEnabled = UserDefaults.standard.bool(forKey: "ambientAgentEnabled")
    @State private var ambientInterval: Double = {
        let val = UserDefaults.standard.double(forKey: "ambientCaptureInterval")
        return val == 0 ? 30 : val
    }()
    var ambientAgent: AmbientAgent

    // Re-check permissions every 2 seconds while the window is open
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
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

            Section("Computer Use") {
                HStack {
                    Text("Max steps per session")
                    Spacer()
                    Text("\(Int(maxSteps))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $maxSteps, in: 10...100, step: 10)
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
                            Task {
                                let status = await PermissionManager.screenRecordingStatus()
                                screenRecordingGranted = status == .granted
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 450, height: 550)
        .onAppear {
            checkPermissions()
        }
        .onReceive(permissionTimer) { _ in
            checkPermissions()
        }
    }

    private func checkPermissions() {
        accessibilityGranted = PermissionManager.accessibilityStatus() == .granted
        Task {
            let status = await PermissionManager.screenRecordingStatus()
            screenRecordingGranted = status == .granted
        }
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
