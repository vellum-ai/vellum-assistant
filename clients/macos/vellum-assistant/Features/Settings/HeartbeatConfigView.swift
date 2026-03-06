import SwiftUI
import VellumAssistantShared

struct HeartbeatConfigView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var enabled: Bool = true
    @State private var intervalMinutes: Double = 60
    @State private var activeHoursEnabled: Bool = false
    @State private var activeHoursStart: Int = 9
    @State private var activeHoursEnd: Int = 17
    @State private var nextRunAt: Int?
    @State private var isApplyingFromServer = false
    @State private var saveErrorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Heartbeat Configuration")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VButton(label: "Done", style: .tertiary) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            if isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if let errorMessage {
                Spacer()
                VStack(spacing: VSpacing.sm) {
                    VIconView(.triangleAlert, size: 32)
                        .foregroundColor(VColor.textMuted)
                    Text("Failed to load configuration")
                        .foregroundColor(VColor.textSecondary)
                    Text(errorMessage)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    VButton(label: "Retry", style: .tertiary) { loadConfig() }
                }
                Spacer()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Enabled toggle
                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Enabled")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textPrimary)
                                Text("Run heartbeat checks on a schedule")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VToggle(isOn: $enabled)
                                .onChange(of: enabled) { _, newValue in
                                    guard !isApplyingFromServer else { return }
                                    saveConfig(enabled: newValue)
                                }
                        }

                        Divider().background(VColor.surfaceBorder)

                        // Interval picker
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Check Interval")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                            Text("How often the heartbeat runs")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)

                            Picker("", selection: $intervalMinutes) {
                                Text("15 minutes").tag(15.0)
                                Text("30 minutes").tag(30.0)
                                Text("1 hour").tag(60.0)
                                Text("2 hours").tag(120.0)
                                Text("4 hours").tag(240.0)
                                Text("8 hours").tag(480.0)
                                Text("12 hours").tag(720.0)
                                Text("24 hours").tag(1440.0)
                            }
                            .labelsHidden()
                            .fixedSize()
                            .onChange(of: intervalMinutes) { _, newValue in
                                guard !isApplyingFromServer else { return }
                                saveConfig(intervalMs: newValue * 60 * 1000)
                            }
                        }

                        Divider().background(VColor.surfaceBorder)

                        // Active hours
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            HStack {
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    Text("Active Hours")
                                        .font(VFont.body)
                                        .foregroundColor(VColor.textPrimary)
                                    Text("Only run heartbeat during these hours")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textMuted)
                                }
                                Spacer()
                                VToggle(isOn: $activeHoursEnabled)
                                    .onChange(of: activeHoursEnabled) { _, newValue in
                                        guard !isApplyingFromServer else { return }
                                        if newValue {
                                            saveConfig(activeHoursStart: Double(activeHoursStart), activeHoursEnd: Double(activeHoursEnd))
                                        } else {
                                            saveConfig(activeHoursStart: -1, activeHoursEnd: -1)
                                        }
                                    }
                            }

                            if activeHoursEnabled {
                                HStack(spacing: VSpacing.md) {
                                    Text("From")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textSecondary)
                                    Picker("", selection: $activeHoursStart) {
                                        ForEach(0..<24, id: \.self) { hour in
                                            Text(formatHour(hour)).tag(hour)
                                        }
                                    }
                                    .labelsHidden()
                                    .fixedSize()
                                    .onChange(of: activeHoursStart) { _, newValue in
                                        guard !isApplyingFromServer else { return }
                                        saveConfig(activeHoursStart: Double(newValue))
                                    }

                                    Text("to")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textSecondary)
                                    Picker("", selection: $activeHoursEnd) {
                                        ForEach(0..<24, id: \.self) { hour in
                                            Text(formatHour(hour)).tag(hour)
                                        }
                                    }
                                    .labelsHidden()
                                    .fixedSize()
                                    .onChange(of: activeHoursEnd) { _, newValue in
                                        guard !isApplyingFromServer else { return }
                                        saveConfig(activeHoursEnd: Double(newValue))
                                    }
                                }
                            }
                        }

                        Divider().background(VColor.surfaceBorder)

                        // Next run display
                        if let nextRun = nextRunAt {
                            HStack {
                                Text("Next Run")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textPrimary)
                                Spacer()
                                Text(formatTimestamp(nextRun))
                                    .font(VFont.mono)
                                    .foregroundColor(VColor.textSecondary)
                            }
                        }

                        // Inline save error
                        if let saveError = saveErrorMessage {
                            HStack(spacing: VSpacing.sm) {
                                VIconView(.triangleAlert, size: 11)
                                    .foregroundColor(VColor.error)
                                Text(saveError)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.error)
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                }
            }
        }
        .frame(width: 450, height: 400)
        .background(VColor.background)
        .onAppear {
            setupCallback()
            loadConfig()
        }
        .onDisappear {
            daemonClient.onHeartbeatConfigResponse = nil
        }
    }

    // MARK: - Helpers

    private func formatHour(_ hour: Int) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h a"
        var components = DateComponents()
        components.hour = hour
        let calendar = Calendar.current
        let date = calendar.date(from: components) ?? Date()
        return formatter.string(from: date)
    }

    private func formatTimestamp(_ ms: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Data

    private func setupCallback() {
        daemonClient.onHeartbeatConfigResponse = { response in
            Task { @MainActor in
                self.isLoading = false
                if !response.success {
                    self.errorMessage = response.error ?? "Unknown error"
                    return
                }
                self.errorMessage = nil
                self.isApplyingFromServer = true
                self.enabled = response.enabled
                self.intervalMinutes = response.intervalMs / 60.0 / 1000.0
                if let start = response.activeHoursStart, let end = response.activeHoursEnd,
                   start >= 0, end >= 0 {
                    self.activeHoursEnabled = true
                    self.activeHoursStart = Int(start)
                    self.activeHoursEnd = Int(end)
                } else {
                    self.activeHoursEnabled = false
                }
                self.nextRunAt = response.nextRunAt
                // Defer reset to the next run-loop tick so SwiftUI's onChange
                // closures fire while the flag is still true.
                DispatchQueue.main.async {
                    self.isApplyingFromServer = false
                }
            }
        }
    }

    private func loadConfig() {
        isLoading = true
        errorMessage = nil
        do {
            try daemonClient.sendHeartbeatConfigGet()
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    private func saveConfig(
        enabled: Bool? = nil,
        intervalMs: Double? = nil,
        activeHoursStart: Double? = nil,
        activeHoursEnd: Double? = nil
    ) {
        do {
            try daemonClient.sendHeartbeatConfigSet(
                enabled: enabled,
                intervalMs: intervalMs,
                activeHoursStart: activeHoursStart,
                activeHoursEnd: activeHoursEnd
            )
            // Refresh to get updated nextRunAt
            try daemonClient.sendHeartbeatConfigGet()
            saveErrorMessage = nil
        } catch {
            saveErrorMessage = "Failed to save: \(error.localizedDescription)"
        }
    }
}
