import SwiftUI

struct SettingsView: View {
    @State private var apiKeyText = ""
    @State private var hasKey = APIKeyManager.getKey() != nil
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
                    .onChange(of: maxSteps) { _, newValue in
                        UserDefaults.standard.set(newValue, forKey: "maxStepsPerSession")
                    }
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
        case .pattern: return .blue
        case .automation: return .green
        case .insight: return .orange
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
