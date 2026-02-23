import Foundation
import SwiftUI
import VellumAssistantShared

/// Advanced settings tab — computer usage limits, private threads,
/// archived threads, iOS device pairing, and developer tools.
@MainActor
struct SettingsAdvancedTab: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject var threadManager: ThreadManager
    var onClose: () -> Void
    var daemonClient: DaemonClient?
    var onNavigateToConnect: (() -> Void)?

    @State private var iosPairingEnabled: Bool = false
    @State private var showingPairingWarning: Bool = false
    @State private var showingRetireConfirmation: Bool = false
    @State private var isRetiring: Bool = false
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var identity: IdentityInfo?
    @State private var remoteIdentity: RemoteIdentityInfo?
    @State private var flagStates: [(flag: FeatureFlag, enabled: Bool)] = []
    @AppStorage("iosPairingUseOverride") private var iosPairingUseOverride: Bool = false
    @AppStorage("iosPairingGatewayOverride") private var iosPairingGatewayOverride: String = ""
    @AppStorage("iosPairingTokenOverride") private var iosPairingTokenOverride: String = ""

    #if DEBUG
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            assistantInfoSection
            computerUsageSection
            privateThreadSection
            archivedThreadsSection
            iosDeviceSection
            switchAssistantSection
            retireAssistantSection
            hatchNewAssistantSection
            featureFlagSection

            #if DEBUG
            developerSection
            #endif
        }
        .onAppear {
            let flagPath = NSHomeDirectory() + "/.vellum/ios-pairing-enabled"
            iosPairingEnabled = FileManager.default.fileExists(atPath: flagPath)
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            identity = IdentityInfo.load()
            flagStates = FeatureFlag.allCases.map { flag in
                (flag: flag, enabled: FeatureFlagManager.shared.isEnabled(flag))
            }

            if identity == nil, let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }), assistant.isRemote {
                Task {
                    remoteIdentity = await daemonClient?.fetchRemoteIdentity()
                }
            }
        }
        .alert("Retire Assistant", isPresented: $showingRetireConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Retire", role: .destructive) {
                isRetiring = true
                Task {
                    let completed = await AppDelegate.shared?.performRetireAsync() ?? false
                    if !completed {
                        isRetiring = false
                    }
                }
            }
        } message: {
            if lockfileAssistants.count > 1 {
                Text("This will stop the current assistant and switch to another. The retired assistant's lockfile entry will be removed.")
            } else {
                Text("This will stop the assistant daemon, remove local data, and return to initial setup. This action cannot be undone.")
            }
        }
        .sheet(isPresented: $isRetiring) {
            VStack(spacing: VSpacing.lg) {
                ProgressView()
                    .controlSize(.regular)
                    .progressViewStyle(.circular)
                Text("Retiring assistant...")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text("Stopping the daemon and removing local data.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            .padding(VSpacing.xxl)
            .frame(minWidth: 260)
            .interactiveDismissDisabled()
        }
        #if DEBUG
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            daemonClient?.onEnvVarsResponse = nil
        }
        #endif
    }

    // MARK: - Assistant Info

    private var assistantInfoSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Assistant Info")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) {
                infoRow(label: "Assistant ID", value: assistant.assistantId, mono: true)

                let home = assistant.home
                homeRow(home: home)
            }

            // Process status (child view observes @Published changes)
            if let daemonClient {
                DaemonStatusRows(daemonClient: daemonClient)
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func infoRow(label: String, value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            Text(value)
                .font(mono ? VFont.mono : VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)

            Spacer()
        }
    }

    @ViewBuilder
    private func homeRow(home: AssistantHome) -> some View {
        HStack(alignment: .top) {
            Text("Home")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(home.displayLabel)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                ForEach(Array(home.displayDetails.enumerated()), id: \.offset) { _, detail in
                    HStack(spacing: VSpacing.xs) {
                        Text(detail.label + ":")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        Text(detail.value)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Spacer()
        }
    }

    // MARK: - Computer Usage

    private var computerUsageSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Computer Usage")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                Text("Max Steps per Session")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Image(systemName: "info.circle")
                    .font(.system(size: 12))
                    .foregroundColor(VColor.textMuted)
                Spacer()
                Text("\(Int(store.maxSteps))")
                    .font(VFont.mono)
                    .foregroundColor(VColor.textSecondary)
            }

            VSlider(value: $store.maxSteps, range: 1...100, step: 10, showTickMarks: true)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Private Thread

    private var privateThreadSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Private Thread")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("New Private Thread")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Private threads have isolated memory — facts learned in private threads stay private and won't appear in other conversations.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VButton(label: "New Private Thread", style: .primary) {
                    threadManager.createPrivateThread()
                    onClose()
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Archived Threads

    @ViewBuilder
    private var archivedThreadsSection: some View {
        if !threadManager.archivedThreads.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Archived Threads")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                ForEach(threadManager.archivedThreads) { thread in
                    HStack {
                        Text(thread.title)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .lineLimit(1)
                        Spacer()
                        Button(action: { threadManager.unarchiveThread(id: thread.id) }) {
                            Text("Unarchive")
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Unarchive \(thread.title)")
                    }
                    .padding(.vertical, VSpacing.xs)
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    // MARK: - iOS Device

    private var iosDeviceSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("iOS Device")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Pairing toggle
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable iOS Pairing")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                    Text("Allow iPhone connections over your local network (TLS encrypted).")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
                Spacer()
                Toggle("", isOn: $iosPairingEnabled)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .onChange(of: iosPairingEnabled) { _, enabled in
                        if enabled {
                            if !UserDefaults.standard.bool(forKey: "ios_pairing_warning_shown") {
                                showingPairingWarning = true
                            } else {
                                setIOSPairingEnabled(true)
                            }
                        } else {
                            setIOSPairingEnabled(false)
                        }
                    }
            }

            // Global Gateway & Token readout
            if iosPairingEnabled {
                iosGlobalConfigCard
                iosOverrideSection
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .alert("Enable iOS Pairing", isPresented: $showingPairingWarning) {
            Button("Cancel", role: .cancel) {
                iosPairingEnabled = false
            }
            Button("Enable") {
                UserDefaults.standard.set(true, forKey: "ios_pairing_warning_shown")
                setIOSPairingEnabled(true)
            }
        } message: {
            Text("Your assistant will be reachable on your local network. Only devices with the session token can connect. TLS encryption is always enabled.")
        }
    }

    /// Card showing the resolved gateway URL and masked bearer token for iOS pairing.
    private var iosGlobalConfigCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Using Global Gateway & Token")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .textCase(.uppercase)

            HStack(alignment: .top) {
                Text("Gateway URL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 90, alignment: .leading)
                Text(store.resolvedIosGatewayUrl.isEmpty ? "Not configured" : store.resolvedIosGatewayUrl)
                    .font(VFont.mono)
                    .foregroundColor(store.resolvedIosGatewayUrl.isEmpty ? VColor.textMuted : VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }

            HStack(alignment: .top) {
                Text("Bearer Token")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 90, alignment: .leading)
                Text(store.resolvedIosBearerToken.isEmpty
                     ? "Not configured"
                     : String(repeating: "\u{2022}", count: 8))
                    .font(VFont.mono)
                    .foregroundColor(store.resolvedIosBearerToken.isEmpty ? VColor.textMuted : VColor.textPrimary)
                Spacer()
            }

            Button("Manage in Connect tab") {
                onNavigateToConnect?()
            }
            .font(VFont.caption)
            .foregroundColor(VColor.accent)
        }
        .padding(VSpacing.md)
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder.opacity(0.3), lineWidth: 1)
        )
    }

    /// Collapsed override section for per-integration iOS gateway/token customization.
    private var iosOverrideSection: some View {
        DisclosureGroup("Override") {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Toggle("Use custom gateway for iOS", isOn: $iosPairingUseOverride)
                    .toggleStyle(.switch)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)

                if iosPairingUseOverride {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Gateway URL Override")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        TextField("https://custom-gateway.example.com", text: $iosPairingGatewayOverride)
                            .textFieldStyle(VInputStyle())
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Token Override")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        SecureField("Custom bearer token", text: $iosPairingTokenOverride)
                            .textFieldStyle(VInputStyle())
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                }
            }
            .padding(.top, VSpacing.sm)
        }
        .font(VFont.caption)
        .foregroundColor(VColor.textSecondary)
    }

    private func setIOSPairingEnabled(_ enabled: Bool) {
        let flagPath = NSHomeDirectory() + "/.vellum/ios-pairing-enabled"
        if enabled {
            FileManager.default.createFile(atPath: flagPath, contents: nil)
        } else {
            try? FileManager.default.removeItem(atPath: flagPath)
        }
    }


    // MARK: - Switch Assistant

    @ViewBuilder
    private var switchAssistantSection: some View {
        if lockfileAssistants.count > 1 {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Switch Assistant")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                ForEach(lockfileAssistants, id: \.assistantId) { assistant in
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: assistant.assistantId == selectedAssistantId
                              ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(assistant.assistantId == selectedAssistantId
                                             ? VColor.accent : VColor.textMuted)
                            .font(.system(size: 16))

                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(assistant.assistantId)
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text(assistant.home.displayLabel)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }

                        Spacer()

                        if assistant.assistantId != selectedAssistantId {
                            VButton(label: "Switch", style: .primary) {
                                switchToAssistant(assistant)
                            }
                        } else {
                            Text("Active")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    private func switchToAssistant(_ assistant: LockfileAssistant) {
        AppDelegate.shared?.performSwitchAssistant(to: assistant)
        onClose()
    }

    // MARK: - Retire Assistant

    private var retireAssistantSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Retire Assistant")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Retire this assistant")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    if lockfileAssistants.count > 1 {
                        Text("Stops the current assistant and switches to another.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    } else {
                        Text("Stops the daemon, removes local data, and returns to initial setup.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                }
                Spacer()
                VButton(label: "Retire...", style: .danger) {
                    showingRetireConfirmation = true
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Hatch New Assistant

    @ViewBuilder
    private var hatchNewAssistantSection: some View {
        if FeatureFlagManager.shared.isEnabled(.hatchNewAssistantEnabled) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Hatch New Assistant")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Hatch a new assistant")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("Starts the initial setup flow to create a new assistant.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VButton(label: "Hatch...", style: .primary) {
                        AppDelegate.shared?.replayOnboarding()
                        onClose()
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    // MARK: - Feature Flags

    @ViewBuilder
    private var featureFlagSection: some View {
        if FeatureFlagManager.shared.isEnabled(.featureFlagEditorEnabled) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Feature Flags")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                ForEach(Array(flagStates.enumerated()), id: \.element.flag) { index, entry in
                    Toggle(entry.flag.displayName, isOn: Binding(
                        get: { flagStates[index].enabled },
                        set: { newValue in
                            flagStates[index].enabled = newValue
                            FeatureFlagManager.shared.setOverride(entry.flag, enabled: newValue)
                        }
                    ))
                    .toggleStyle(.switch)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    // MARK: - Developer (Debug Only)

    #if DEBUG
    @ViewBuilder
    private var developerSection: some View {
        if daemonClient != nil {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Developer")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Environment Variables")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("View env vars for both the app and daemon processes")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VButton(label: "View...", style: .tertiary) {
                        appEnvVars = ProcessInfo.processInfo.environment
                            .sorted(by: { $0.key < $1.key })
                            .map { ($0.key, $0.value) }
                        daemonEnvVars = []
                        daemonClient?.onEnvVarsResponse = { response in
                            Task { @MainActor in
                                self.daemonEnvVars = response.vars
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                            }
                        }
                        try? daemonClient?.sendEnvVarsRequest()
                        showingEnvVars = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }
    #endif
}

// MARK: - Daemon Status Rows

/// Extracted child view so SwiftUI observes `DaemonClient`'s `@Published`
/// properties and re-renders when connection or memory status changes.
private struct DaemonStatusRows: View {
    @ObservedObject var daemonClient: DaemonClient

    var body: some View {
        statusRow(
            label: "Daemon",
            isHealthy: daemonClient.isConnected,
            detail: daemonClient.isConnected
                ? "Connected" + (daemonClient.daemonVersion.map { " (v\($0))" } ?? "")
                : "Disconnected"
        )

        if let memoryStatus = daemonClient.latestMemoryStatus {
            statusRow(
                label: "Memory",
                isHealthy: memoryStatus.enabled && !memoryStatus.degraded,
                detail: !memoryStatus.enabled ? "Disabled"
                    : memoryStatus.degraded ? "Degraded\(memoryStatus.reason.map { " — \($0)" } ?? "")"
                    : "Healthy"
            )
        }
    }

    private func statusRow(label: String, isHealthy: Bool, detail: String) -> some View {
        HStack(alignment: .center) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            Circle()
                .fill(isHealthy ? VColor.success : VColor.error)
                .frame(width: 8, height: 8)

            Text(detail)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()
        }
    }
}
