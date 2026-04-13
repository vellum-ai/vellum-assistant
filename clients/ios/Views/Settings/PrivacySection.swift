#if canImport(UIKit)
import AVFoundation
import SwiftUI
import UserNotifications
import VellumAssistantShared

/// Settings section showing system permission statuses for privacy-sensitive APIs.
struct PrivacySection: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var micStatus: PermissionStatus = .notDetermined
    @State private var speechStatus: PermissionStatus = .notDetermined
    @State private var cameraStatus: PermissionStatus = .notDetermined
    @State private var notificationStatus: PermissionStatus = .notDetermined

    var body: some View {
        Form {
            Section {
                permissionRow(name: "Microphone", status: micStatus)
                speechRecognitionRow
                permissionRow(name: "Camera", status: cameraStatus)
                permissionRow(name: "Notifications", status: notificationStatus)
            } header: {
                Text("Permissions")
            } footer: {
                Text("Tap a denied or undetermined permission to open iOS Settings where you can grant access.")
            }
        }
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { refreshAll() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active { refreshAll() }
        }
    }

    // MARK: - Speech Recognition Row

    /// Speech recognition row with conditional optional state when an LLM-based
    /// STT provider is configured. When STT is available, a denied permission is
    /// shown as a neutral "Not enabled (optional)" badge instead of the red
    /// "Denied" badge.
    @ViewBuilder
    private var speechRecognitionRow: some View {
        let sttConfigured = STTProviderRegistry.isServiceConfigured
        if sttConfigured && speechStatus == .denied {
            // Show neutral state — speech recognition is optional when STT is available
            Button {
                openSettings()
            } label: {
                HStack {
                    Text("Speech Recognition")
                        .foregroundStyle(VColor.contentDefault)
                    Spacer()
                    Text("Not enabled (optional)")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(VColor.contentTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(VColor.contentTertiary.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .accessibilityLabel("Speech Recognition, not enabled, optional")
            .accessibilityHint("Opens iOS Settings to grant access")
        } else if sttConfigured && speechStatus == .notDetermined {
            // Show neutral "not set" state with optional hint
            Button {
                openSettings()
            } label: {
                HStack {
                    Text("Speech Recognition")
                        .foregroundStyle(VColor.contentDefault)
                    Spacer()
                    Text("Not Set (optional)")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(VColor.systemMidStrong)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(VColor.systemMidStrong.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .accessibilityLabel("Speech Recognition, not set, optional")
            .accessibilityHint("Opens iOS Settings to grant access")
        } else {
            permissionRow(name: "Speech Recognition", status: speechStatus)
        }
    }

    // MARK: - Permission Row

    @ViewBuilder
    private func permissionRow(name: String, status: PermissionStatus) -> some View {
        let statusLabel: String = {
            switch status {
            case .granted: return "granted"
            case .denied: return "denied"
            case .notDetermined: return "not set"
            }
        }()
        Button {
            if status == .denied || status == .notDetermined {
                openSettings()
            }
        } label: {
            HStack {
                Text(name)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                statusBadge(status)
            }
        }
        .disabled(status == .granted)
        .accessibilityLabel("\(name), \(statusLabel)")
        .accessibilityHint(status == .granted ? "" : "Opens iOS Settings to grant access")
    }

    // MARK: - Status Badge

    @ViewBuilder
    private func statusBadge(_ status: PermissionStatus) -> some View {
        let (color, label): (Color, String) = {
            switch status {
            case .granted: return (VColor.systemPositiveStrong, "Granted")
            case .denied: return (VColor.systemNegativeStrong, "Denied")
            case .notDetermined: return (VColor.systemMidStrong, "Not Set")
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    // MARK: - Refresh

    private func refreshAll() {
        micStatus = PermissionManager.shared.status(for: .microphone)
        speechStatus = PermissionManager.shared.status(for: .speechRecognition)
        refreshCamera()
        Task { await refreshNotifications() }
    }

    private func refreshCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: cameraStatus = .granted
        case .denied, .restricted: cameraStatus = .denied
        case .notDetermined: cameraStatus = .notDetermined
        @unknown default: cameraStatus = .notDetermined
        }
    }

    @MainActor
    private func refreshNotifications() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: notificationStatus = .granted
        case .denied: notificationStatus = .denied
        case .notDetermined: notificationStatus = .notDetermined
        @unknown default: notificationStatus = .notDetermined
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
#endif
