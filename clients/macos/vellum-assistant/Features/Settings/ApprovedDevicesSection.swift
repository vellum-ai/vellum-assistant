import SwiftUI
import VellumAssistantShared

/// Displays always-allowed devices in the Connect tab.
/// Each row shows device name + last paired time + a Remove button.
/// Clear All button at bottom. Empty state: "No approved devices."
@MainActor
struct ApprovedDevicesSection: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Approved Devices")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if !store.approvedDevices.isEmpty {
                    Button("Clear All") {
                        store.clearAllApprovedDevices()
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .buttonStyle(.borderless)
                }
            }

            Text("Devices that have been granted \"Always Allow\" will pair automatically without prompting.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            if store.approvedDevices.isEmpty {
                Text("No approved devices.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, VSpacing.md)
            } else {
                ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                            Text("Last paired: \(formattedDate(device.lastPairedAt))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        Button("Remove") {
                            store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                        }
                        .font(VFont.caption)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding(.vertical, VSpacing.xs)
                }
            }
        }
        .padding(VSpacing.md)
        .onAppear {
            store.refreshApprovedDevices()
        }
    }

    private func formattedDate(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
