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
                permissionRow(name: "Speech Recognition", status: speechStatus)
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
                    .foregroundColor(VColor.contentDefault)
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
            case .notDetermined: return (VColor.systemNegativeHover, "Not Set")
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

#Preview {
    NavigationStack {
        PrivacySection()
    }
}
#endif
