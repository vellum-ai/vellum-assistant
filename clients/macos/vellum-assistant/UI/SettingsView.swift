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
    var ambientAgent: AmbientAgent?

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
                        ambientAgent?.isEnabled = newValue
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
                            ambientAgent?.captureIntervalSeconds = newValue
                        }

                    HStack {
                        Text("Knowledge entries")
                        Spacer()
                        Text("\(ambientAgent?.knowledge.entries.count ?? 0)")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }

                    Button("Clear Knowledge") {
                        ambientAgent?.knowledge.clearAll()
                    }
                    .tint(.red)
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
        .frame(width: 450, height: 520)
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
