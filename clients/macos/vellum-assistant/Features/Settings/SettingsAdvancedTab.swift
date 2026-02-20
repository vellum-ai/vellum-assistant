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

    @State private var sessionToken: String = ""
    @State private var tokenCopied: Bool = false
    @State private var showingRetireConfirmation: Bool = false
    @State private var isRetiring: Bool = false
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    #if DEBUG
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            computerUsageSection
            privateThreadSection
            archivedThreadsSection
            iosDeviceSection
            switchAssistantSection
            retireAssistantSection

            #if DEBUG
            developerSection
            #endif
        }
        .onAppear {
            let tokenPath = NSHomeDirectory() + "/.vellum/session-token"
            sessionToken = (try? String(contentsOfFile: tokenPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
        }
        .alert("Retire Assistant", isPresented: $showingRetireConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Retire", role: .destructive) {
                isRetiring = true
                Task {
                    await (NSApp.delegate as? AppDelegate)?.performRetireAsync()
                    isRetiring = false
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

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Session Token")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text("Paste this into the Vellum iOS app to connect it to this Mac.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                HStack(spacing: VSpacing.sm) {
                    if sessionToken.isEmpty {
                        Text("Token not found")
                            .font(VFont.mono)
                            .foregroundColor(VColor.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text(String(sessionToken.prefix(16)) + "...")
                            .font(VFont.mono)
                            .foregroundColor(VColor.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(tokenCopied ? "Copied!" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(sessionToken, forType: .string)
                        tokenCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            tokenCopied = false
                        }
                    }
                    .disabled(sessionToken.isEmpty)
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
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
        (NSApp.delegate as? AppDelegate)?.performSwitchAssistant(to: assistant)
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
                    VButton(label: "View...", style: .ghost) {
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
