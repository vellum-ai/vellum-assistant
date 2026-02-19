#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

enum ConnectionMode: String, CaseIterable {
    case standalone = "Standalone"
    case connected = "Connected to Mac"
}

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.connectionMode) private var connectionMode: String = ConnectionMode.standalone.rawValue
    @AppStorage(UserDefaultsKeys.daemonTLSEnabled) private var tlsEnabled: Bool = false
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"
    @State private var apiKey: String = ""
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var sessionToken: String = ""
    @State private var showingAPIKeyAlert = false
    @State private var apiKeyAlertMessage = ""
    @State private var apiKeyAlertTitle = ""
    @State private var showingDaemonAlert = false
    @State private var daemonAlertMessage = ""

    // Integrations state
    @State private var integrations: [IPCIntegrationListResponseIntegration] = []
    @State private var connectingIntegrationId: String?

    // Trust rules state
    @State private var trustRules: [TrustRuleItem] = []
    @State private var showingAddRule = false
    @State private var editingRule: TrustRuleItem?

    // Scheduled tasks state
    @State private var schedules: [ScheduleItem] = []
    @State private var schedulesLoading = false

    // Reminders state
    @State private var reminders: [ReminderItem] = []
    @State private var remindersLoading = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection Mode") {
                    Picker("Mode", selection: $connectionMode) {
                        ForEach(ConnectionMode.allCases, id: \.rawValue) { mode in
                            Text(mode.rawValue).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: connectionMode) { _, newMode in
                        switchClient(to: newMode)
                    }
                }

                if connectionMode == ConnectionMode.standalone.rawValue {
                    Section("Anthropic API Key") {
                        SecureField("Anthropic API Key", text: $apiKey)
                            .textContentType(.password)
                            .autocapitalization(.none)

                        Button("Save") {
                            let success = APIKeyManager.shared.setAPIKey(apiKey)
                            if success {
                                apiKeyAlertTitle = "Success"
                                apiKeyAlertMessage = "API Key saved securely"
                            } else {
                                apiKeyAlertTitle = "Error"
                                apiKeyAlertMessage = "Failed to save API Key to Keychain"
                            }
                            showingAPIKeyAlert = true
                        }
                        .disabled(apiKey.isEmpty)
                        Text("Your API key is stored locally and never sent to Vellum servers.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .alert(apiKeyAlertTitle, isPresented: $showingAPIKeyAlert) {
                        Button("OK") {}
                    } message: {
                        Text(apiKeyAlertMessage)
                    }
                } else {
                    Section("Mac Daemon") {
                        HStack {
                            Text("Hostname")
                            Spacer()
                            TextField("localhost", text: $daemonHostname)
                                .multilineTextAlignment(.trailing)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        HStack {
                            Text("Port")
                            Spacer()
                            TextField("8765", text: $daemonPort)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numberPad)
                        }
                        HStack {
                            Text("Session Token")
                            Spacer()
                            SecureField("From ~/.vellum/session-token", text: $sessionToken)
                                .multilineTextAlignment(.trailing)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        Text("Copy this from ~/.vellum/session-token on your Mac, or from Mac app → Settings.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Toggle("Use TLS", isOn: $tlsEnabled)

                        Button("Update") {
                            guard let port = Int(daemonPort), port > 0, port <= 65535 else {
                                daemonAlertMessage = "Port must be a valid number between 1 and 65535"
                                showingDaemonAlert = true
                                return
                            }
                            UserDefaults.standard.set(daemonHostname, forKey: UserDefaultsKeys.daemonHostname)
                            UserDefaults.standard.set(port, forKey: UserDefaultsKeys.daemonPort)
                            if sessionToken.isEmpty {
                                _ = APIKeyManager.shared.deleteAPIKey(provider: "daemon-token")
                                // Also clear legacy UserDefaults key so migration can't resurrect it
                                UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.legacyDaemonToken)
                            } else {
                                _ = APIKeyManager.shared.setAPIKey(sessionToken, provider: "daemon-token")
                            }
                            daemonAlertMessage = "Daemon connection settings updated"
                            showingDaemonAlert = true
                        }
                        .disabled(daemonHostname.isEmpty || daemonPort.isEmpty)
                    }
                    .alert("Daemon Settings", isPresented: $showingDaemonAlert) {
                        Button("OK") {}
                    } message: {
                        Text(daemonAlertMessage)
                    }

                    // Integrations section (Connected mode only)
                    Section("Integrations") {
                        if integrations.isEmpty {
                            Text("No integrations available")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        } else {
                            ForEach(integrations, id: \.id) { integration in
                                HStack {
                                    Text(integrationIcon(integration.id))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(integrationDisplayName(integration.id))
                                            .font(.body)
                                        if let account = integration.accountInfo {
                                            Text(account)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if connectingIntegrationId == integration.id {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else if integration.connected {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(VColor.success)
                                        Button("Disconnect") {
                                            disconnectIntegration(integration.id)
                                        }
                                        .font(.caption)
                                        .foregroundColor(VColor.error)
                                    } else {
                                        Button("Connect") {
                                            connectIntegration(integration.id)
                                        }
                                        .font(.caption)
                                    }
                                }
                            }
                        }
                    }

                    // Trust Rules section (Connected mode only)
                    Section("Trust Rules") {
                        if trustRules.isEmpty {
                            Text("No trust rules configured")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        } else {
                            ForEach(trustRules, id: \.id) { rule in
                                trustRuleRow(rule)
                            }
                            .onDelete { indexSet in
                                let rulesToDelete = indexSet.map { trustRules[$0] }
                                for rule in rulesToDelete {
                                    deleteRule(rule)
                                }
                            }
                        }

                        Button {
                            showingAddRule = true
                        } label: {
                            Label("Add Rule", systemImage: "plus")
                        }
                    }
                    .sheet(isPresented: $showingAddRule) {
                        TrustRuleFormView(daemon: clientProvider.client as? DaemonClient) { _ in
                            loadTrustRules()
                        }
                    }
                    .sheet(item: $editingRule) { rule in
                        TrustRuleFormView(daemon: clientProvider.client as? DaemonClient, existing: rule) { _ in
                            loadTrustRules()
                        }
                    }

                    // Scheduled Tasks section (Connected mode only)
                    Section("Scheduled Tasks") {
                        if schedulesLoading {
                            HStack {
                                Spacer()
                                ProgressView()
                                Spacer()
                            }
                        } else if schedules.isEmpty {
                            Text("No scheduled tasks")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        } else {
                            ForEach(schedules, id: \.id) { schedule in
                                scheduleRow(schedule)
                            }
                            .onDelete { indexSet in
                                for index in indexSet {
                                    deleteSchedule(schedules[index].id)
                                }
                            }
                        }
                    }

                    // Reminders section (Connected mode only)
                    Section("Reminders") {
                        if remindersLoading {
                            HStack {
                                Spacer()
                                ProgressView()
                                Spacer()
                            }
                        } else if reminders.isEmpty {
                            Text("No active reminders")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        } else {
                            ForEach(reminders, id: \.id) { reminder in
                                reminderRow(reminder)
                            }
                            .onDelete { indexSet in
                                for index in indexSet {
                                    cancelReminder(reminders[index].id)
                                }
                            }
                        }
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $appearanceMode) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Permissions") {
                    PermissionRowView(permission: .microphone)
                    PermissionRowView(permission: .speechRecognition)
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                }
            }
            .navigationTitle("Settings")
        }
        .onAppear {
            loadSettings()
        }
        .onDisappear {
            // Clean up daemon callbacks to prevent stale closures on the shared singleton
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onIntegrationListResponse = nil
                daemon.onIntegrationConnectResult = nil
                daemon.onTrustRulesListResponse = nil
                daemon.onSchedulesListResponse = nil
                daemon.onRemindersListResponse = nil
            }
        }
    }

    private func switchClient(to mode: String) {
        clientProvider.client.disconnect()
        let newClient: any DaemonClientProtocol
        if mode == ConnectionMode.connected.rawValue {
            newClient = DaemonClient(config: .fromUserDefaults())
        } else {
            newClient = DirectClaudeClient()
        }
        clientProvider.client = newClient
        Task {
            try? await clientProvider.client.connect()
            // Reload Connected-mode data after establishing connection
            if mode == ConnectionMode.connected.rawValue {
                loadIntegrations()
                loadTrustRules()
                loadSchedules()
                loadReminders()
            }
        }
    }

    private func loadSettings() {
        apiKey = APIKeyManager.shared.getAPIKey() ?? ""
        daemonHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? "localhost"
        let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        daemonPort = portValue > 0 ? String(portValue) : "8765"
        sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""

        // Load Connected mode data
        if connectionMode == ConnectionMode.connected.rawValue {
            loadIntegrations()
            loadTrustRules()
            loadSchedules()
            loadReminders()
        }
    }

    // MARK: - Integrations

    private func integrationIcon(_ id: String) -> String {
        switch id {
        case "gmail": return "📧"
        default: return "🔗"
        }
    }

    private func integrationDisplayName(_ id: String) -> String {
        switch id {
        case "gmail": return "Gmail"
        default: return id.capitalized
        }
    }

    private func loadIntegrations() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        daemon.onIntegrationListResponse = { response in
            integrations = response.integrations
        }
        try? daemon.sendIntegrationList()
    }

    private func connectIntegration(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        connectingIntegrationId = id
        daemon.onIntegrationConnectResult = { result in
            connectingIntegrationId = nil
            if result.success {
                loadIntegrations()
            }
        }
        do {
            try daemon.sendIntegrationConnect(integrationId: id)
        } catch {
            connectingIntegrationId = nil
        }
    }

    private func disconnectIntegration(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendIntegrationDisconnect(integrationId: id)
        // Refresh after a brief delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            loadIntegrations()
        }
    }

    // MARK: - Trust Rules

    @ViewBuilder
    private func trustRuleRow(_ rule: TrustRuleItem) -> some View {
        let isDefault = rule.priority >= 1000 || rule.id.hasPrefix("default:")
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(rule.tool)
                        .font(.body)
                    decisionBadge(rule.decision)
                }
                Text(rule.pattern)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(rule.scope == "" || rule.scope == "*" ? "everywhere" : rule.scope)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if !isDefault {
                Button {
                    editingRule = rule
                } label: {
                    Image(systemName: "pencil")
                        .foregroundColor(VColor.textSecondary)
                }
            }
        }
        .opacity(isDefault ? 0.6 : 1.0)
    }

    @ViewBuilder
    private func decisionBadge(_ decision: String) -> some View {
        let (color, label): (Color, String) = {
            switch decision {
            case "allow": return (VColor.success, "Allow")
            case "deny": return (VColor.error, "Deny")
            default: return (VColor.warning, "Ask")
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    private func loadTrustRules() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        daemon.onTrustRulesListResponse = { rules in
            trustRules = rules
        }
        try? daemon.send(TrustRulesListMessage())
    }

    private func deleteRule(_ rule: TrustRuleItem) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.send(RemoveTrustRuleMessage(id: rule.id))
        // Refresh from daemon instead of optimistic removal,
        // in case the delete was rejected (e.g. default/immutable rules)
        loadTrustRules()
    }

    // MARK: - Scheduled Tasks

    @ViewBuilder
    private func scheduleRow(_ schedule: ScheduleItem) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(schedule.name)
                    .font(.body)
                Text(schedule.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 4) {
                    Text(schedule.cronExpression)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if schedule.enabled, schedule.nextRunAt > 0, let nextRun = formatTimestamp(schedule.nextRunAt) {
                        Text("Next: \(nextRun)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { schedule.enabled },
                set: { newValue in toggleSchedule(schedule.id, enabled: newValue) }
            ))
            .labelsHidden()
        }
    }

    private func loadSchedules() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        schedulesLoading = true
        daemon.onSchedulesListResponse = { items in
            schedules = items
            schedulesLoading = false
        }
        do {
            try daemon.sendListSchedules()
        } catch {
            schedulesLoading = false
        }
    }

    private func toggleSchedule(_ id: String, enabled: Bool) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendToggleSchedule(id: id, enabled: enabled)
        // Update local state immediately
        if let idx = schedules.firstIndex(where: { $0.id == id }) {
            // Refresh from daemon to get updated state
            loadSchedules()
        }
    }

    private func deleteSchedule(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendRemoveSchedule(id: id)
        schedules.removeAll { $0.id == id }
    }

    // MARK: - Reminders

    @ViewBuilder
    private func reminderRow(_ reminder: ReminderItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(reminder.label)
                .font(.body)
            Text(reminder.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 8) {
                statusBadge(reminder.status)
                if let fireTime = formatTimestamp(reminder.fireAt) {
                    Text(fireTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        let (color, label): (Color, String) = {
            switch status {
            case "pending": return (VColor.warning, "Pending")
            case "fired": return (VColor.success, "Fired")
            case "cancelled": return (VColor.textMuted, "Cancelled")
            default: return (VColor.textSecondary, status.capitalized)
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    private func loadReminders() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        remindersLoading = true
        daemon.onRemindersListResponse = { items in
            reminders = items
            remindersLoading = false
        }
        do {
            try daemon.sendListReminders()
        } catch {
            remindersLoading = false
        }
    }

    private func cancelReminder(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendCancelReminder(id: id)
        reminders.removeAll { $0.id == id }
    }

    // MARK: - Formatting Helpers

    private func formatTimestamp(_ ms: Int) -> String? {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Trust Rule Form

private struct TrustRuleFormView: View {
    let daemon: DaemonClient?
    var existing: TrustRuleItem?
    let onSave: (Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var tool: String = "bash"
    @State private var pattern: String = ""
    @State private var isEverywhere: Bool = true
    @State private var scope: String = ""
    @State private var decision: String = "allow"

    private let toolOptions = ["bash", "file_read", "file_write", "file_edit", "web_fetch", "skill_load"]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Tool", selection: $tool) {
                    ForEach(toolOptions, id: \.self) { t in
                        Text(t).tag(t)
                    }
                }

                TextField("Pattern (e.g. git *)", text: $pattern)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                Toggle("Apply everywhere", isOn: $isEverywhere)

                if !isEverywhere {
                    TextField("Scope (directory path)", text: $scope)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Picker("Decision", selection: $decision) {
                    Text("Allow").tag("allow")
                    Text("Ask").tag("ask")
                    Text("Deny").tag("deny")
                }
                .pickerStyle(.segmented)
            }
            .navigationTitle(existing == nil ? "Add Rule" : "Edit Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveRule()
                        dismiss()
                    }
                    .disabled(pattern.isEmpty)
                }
            }
            .onAppear {
                if let rule = existing {
                    tool = rule.tool
                    pattern = rule.pattern
                    decision = rule.decision
                    isEverywhere = rule.scope == "" || rule.scope == "*"
                    scope = isEverywhere ? "" : rule.scope
                }
            }
        }
    }

    private func saveRule() {
        let finalScope = isEverywhere ? "*" : scope
        if let rule = existing {
            try? daemon?.send(UpdateTrustRuleMessage(
                id: rule.id,
                tool: tool,
                pattern: pattern,
                scope: finalScope,
                decision: decision
            ))
        } else {
            try? daemon?.send(AddTrustRuleMessage(
                toolName: tool,
                pattern: pattern,
                scope: finalScope,
                decision: decision
            ))
        }
        onSave(true)
    }
}

struct PermissionRowView: View {
    let permission: PermissionManager.Permission
    @State private var status: PermissionStatus = .notDetermined
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        HStack {
            Text(permissionName)
            Spacer()
            statusIcon
            if status == .notDetermined {
                Button("Grant") {
                    Task {
                        let granted = await PermissionManager.shared.request(permission)
                        status = granted ? .granted : .denied
                    }
                }
            } else if status == .denied {
                Button("Open Settings") {
                    if let settingsUrl = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(settingsUrl)
                    }
                }
            }
        }
        .onAppear {
            status = PermissionManager.shared.status(for: permission)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Refresh status when returning from iOS Settings
            if newPhase == .active {
                status = PermissionManager.shared.status(for: permission)
            }
        }
    }

    private var permissionName: String {
        switch permission {
        case .microphone: return "Microphone"
        case .speechRecognition: return "Speech Recognition"
        }
    }

    private var statusIcon: some View {
        Image(systemName: statusIconName)
            .foregroundColor(statusColor)
    }

    private var statusIconName: String {
        switch status {
        case .granted: return "checkmark.circle.fill"
        case .denied: return "xmark.circle.fill"
        case .notDetermined: return "questionmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch status {
        case .granted: return VColor.success
        case .denied: return VColor.error
        case .notDetermined: return VColor.textMuted
        }
    }
}

extension Bundle {
    var appVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

#Preview {
    SettingsView()
        .environmentObject(ClientProvider(client: DirectClaudeClient()))
}
#endif
