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
    let onConnect: (String) -> Bool
    let onSignOut: () -> Void

    @State private var connectingId: String?

    private static let appIcon: NSImage = {
        NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    }()

    var body: some View {
        VStack(spacing: 0) {
            Spacer().frame(height: 60)

            Image(nsImage: Self.appIcon)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .padding(.bottom, VSpacing.lg)

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
                VButton(label: "Connect", style: .outlined) {
                    connectingId = item.id
                    if !onConnect(item.id) {
                        connectingId = nil
                    }
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

    /// Build a picker item from a lockfile entry. When the platform was
    /// consulted, pass the matching `PlatformAssistant.name` so we have
    /// a real display name instead of a raw UUID.
    @MainActor
    static func from(lockfile: LockfileAssistant, platformName: String? = nil) -> AssistantPickerItem {
        let name = AssistantDisplayName.resolve(
            platformName,
            IdentityInfo.cached(for: lockfile.assistantId)?.name
        )
        let subtitle = lockfile.isManaged ? "Managed" : "Local"
        return AssistantPickerItem(
            id: lockfile.assistantId,
            displayName: name,
            subtitle: subtitle,
            isManaged: lockfile.isManaged
        )
    }

    @MainActor
    static func from(platform: PlatformAssistant) -> AssistantPickerItem {
        let name = AssistantDisplayName.resolve(platform.name)
        return AssistantPickerItem(
            id: platform.id,
            displayName: name,
            subtitle: "Managed",
            isManaged: true
        )
    }

    /// Build picker items from the router landscape. Platform results are
    /// authoritative for managed assistants when available, but local lockfile
    /// entries must remain visible so a user who signs in after hatching
    /// locally can choose either assistant.
    @MainActor
    static func from(landscape: ReturningUserRouter.AssistantLandscape) -> [AssistantPickerItem] {
        let platformById = Dictionary(
            landscape.platformAssistants.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        let lockfileItems = landscape.currentEnvironmentLockfileAssistants
            .map { entry in
                AssistantPickerItem.from(
                    lockfile: entry,
                    platformName: platformById[entry.assistantId]?.name
                )
            }

        let lockfileIds = Set(landscape.currentEnvironmentLockfileAssistants.map(\.assistantId))
        let platformItems = landscape.platformAssistants
            .filter { !lockfileIds.contains($0.id) }
            .map(AssistantPickerItem.from(platform:))

        return lockfileItems + platformItems
    }
}

enum AssistantPickerSelectionResolver {
    /// Resolves a selected picker row to a lockfile entry. Platform-only rows
    /// are materialized locally first so the normal assistant switch/connect
    /// path can load transport configuration from the lockfile.
    @MainActor
    static func resolveLockfileAssistant(
        assistantId: String,
        platformAssistants: [String: PlatformAssistant],
        lockfilePath: String? = nil,
        runtimeURL: String = VellumEnvironment.resolvedPlatformURL
    ) -> LockfileAssistant? {
        if let existing = LockfileAssistant.loadByName(
            assistantId,
            lockfilePath: lockfilePath
        ), existing.isCurrentEnvironment {
            return existing
        }

        guard let platformAssistant = platformAssistants[assistantId] else {
            return nil
        }

        let persisted = LockfileAssistant.ensureManagedEntry(
            assistantId: platformAssistant.id,
            runtimeUrl: runtimeURL,
            hatchedAt: platformAssistant.created_at ?? Date().iso8601String,
            lockfilePath: lockfilePath
        )
        guard persisted else { return nil }

        if let name = platformAssistant.name {
            IdentityInfo.seedCache(name: name, forAssistantId: platformAssistant.id)
        }

        return LockfileAssistant.loadByName(platformAssistant.id, lockfilePath: lockfilePath)
    }
}
