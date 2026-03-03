import SwiftUI
import VellumAssistantShared

/// Displays always-allowed devices in a collapsible section of the Connect tab.
/// Each row shows device name + last paired time + a Remove button.
/// Clear All button at bottom. Empty state: "No approved devices."
@MainActor
struct ApprovedDevicesSection: View {
    @ObservedObject var store: SettingsStore
    @State private var isExpanded: Bool = false

    var body: some View {
        VDisclosureSection(
            title: "Approved Devices",
            icon: "person.badge.shield.checkmark",
            subtitle: !isExpanded && !store.approvedDevices.isEmpty
                ? "\(store.approvedDevices.count) device\(store.approvedDevices.count == 1 ? "" : "s")"
                : nil,
            isExpanded: $isExpanded
        ) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Devices granted \"Always Allow\" pair automatically without prompting.")
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

                    Divider().background(VColor.surfaceBorder)

                    Button("Clear All") {
                        store.clearAllApprovedDevices()
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .buttonStyle(.borderless)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            store.refreshApprovedDevices()
        }
    }

    private func formattedDate(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
