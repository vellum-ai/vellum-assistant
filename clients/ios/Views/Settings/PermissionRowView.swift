#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

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
#endif
