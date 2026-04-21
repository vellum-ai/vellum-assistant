import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantPickerView")

/// Shown when the returning-user router decides `.showAssistantPicker` —
/// the user has multiple assistants (or one with the multi-assistant flag)
/// and must explicitly choose which to connect.
@MainActor
struct AssistantPickerView: View {
    let assistants: [AssistantPickerItem]
    let onConnect: (String) -> Void
    let onSignOut: () -> Void

    @State private var connectingId: String?

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    var body: some View {
        VStack(spacing: 0) {
            Spacer().frame(height: 60)

            if let nsImage = Self.appIcon {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .padding(.bottom, VSpacing.lg)
            }

            Text("Choose an Assistant")
                .font(VFont.displayLarge)
                .foregroundStyle(VColor.contentDefault)
                .padding(.bottom, VSpacing.xs)

            Text("Select which assistant to connect to.")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.bottom, VSpacing.xl)

            VStack(spacing: VSpacing.sm) {
                ForEach(assistants, id: \.id) { item in
                    assistantRow(item)
                }
            }
            .frame(maxWidth: 320)

            Spacer()

            VButton(label: "Not you? Sign out", style: .ghost) {
                onSignOut()
            }
            .padding(.bottom, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                colors: [VColor.surfaceBase, VColor.surfaceOverlay],
                center: .center,
                startRadius: 0,
                endRadius: 500
            )
            .ignoresSafeArea()
        )
    }

    @ViewBuilder
    private func assistantRow(_ item: AssistantPickerItem) -> some View {
        HStack(spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.displayName)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            Spacer()
            if connectingId == item.id {
                ProgressView()
                    .controlSize(.small)
                    .progressViewStyle(.circular)
            } else {
                VButton(label: "Connect", style: .secondary) {
                    connectingId = item.id
                    onConnect(item.id)
                }
                .disabled(connectingId != nil)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }
}

/// Presentation model for a single row in the assistant picker.
struct AssistantPickerItem: Identifiable {
    let id: String
    let displayName: String
    let subtitle: String?
    let isManaged: Bool

    static func from(lockfile: LockfileAssistant) -> AssistantPickerItem {
        let name = AssistantDisplayName.resolve(
            IdentityInfo.cached(for: lockfile.assistantId)?.name,
            lockfile.assistantId
        )
        let subtitle = lockfile.isManaged ? "Managed" : "Local"
        return AssistantPickerItem(
            id: lockfile.assistantId,
            displayName: name,
            subtitle: subtitle,
            isManaged: lockfile.isManaged
        )
    }

    static func from(platform: PlatformAssistant) -> AssistantPickerItem {
        let name = AssistantDisplayName.resolve(platform.name, platform.id)
        return AssistantPickerItem(
            id: platform.id,
            displayName: name,
            subtitle: "Managed",
            isManaged: true
        )
    }
}
