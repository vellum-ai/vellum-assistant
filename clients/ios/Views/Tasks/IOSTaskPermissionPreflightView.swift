#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A sheet that shows required permissions before running a task on iOS.
/// Adapted from macOS TaskPermissionPreflightView for mobile — uses
/// NavigationStack for consistent header and standard iOS toggle UX.
struct IOSTaskPermissionPreflightView: View {
    let itemTitle: String
    let state: IOSPreflightState
    let onApprove: ([String]) -> Void
    let onDismiss: () -> Void

    @State private var approvedTools: Set<String> = []
    @State private var didInitApproved = false

    var body: some View {
        NavigationStack {
            contentBody
                .navigationTitle("Permission Preflight")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Cancel", action: onDismiss)
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        if case .loaded(let permissions) = state, !permissions.isEmpty {
                            Button("Approve & Run") {
                                onApprove(Array(approvedTools))
                            }
                            .disabled(approvedTools.isEmpty)
                            .fontWeight(.semibold)
                        }
                    }
                }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch state {
        case .loading:
            VStack(spacing: VSpacing.md) {
                Spacer()
                ProgressView()
                Text("Checking required permissions…")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error(let message):
            VStack(spacing: VSpacing.lg) {
                Spacer()
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 40))
                    .foregroundColor(VColor.warning)
                Text(message)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .loaded(let permissions):
            if permissions.isEmpty {
                VStack(spacing: VSpacing.lg) {
                    Spacer()
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 48))
                        .foregroundColor(VColor.success)
                    Text("No Permissions Required")
                        .font(VFont.title)
                        .foregroundColor(VColor.textPrimary)
                    Text("This task can run without additional approvals.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, VSpacing.xl)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                permissionsList(permissions)
            }
        }
    }

    // MARK: - Permissions List

    private func permissionsList(_ permissions: [IPCWorkItemPreflightResponsePermission]) -> some View {
        List {
            Section {
                Text("Task: \(itemTitle)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .listRowBackground(Color.clear)
            } header: {
                Text("This task requires the following permissions:")
            }

            Section {
                ForEach(permissions, id: \.tool) { permission in
                    permissionRow(permission)
                }
                .onAppear {
                    if !didInitApproved {
                        approvedTools = Set(permissions.map(\.tool))
                        didInitApproved = true
                    }
                }
            } footer: {
                Text("\(approvedTools.count) of \(permissions.count) approved")
                    .font(VFont.caption)
            }
        }
    }

    private func permissionRow(_ permission: IPCWorkItemPreflightResponsePermission) -> some View {
        let isApproved = approvedTools.contains(permission.tool)
        return HStack(spacing: VSpacing.sm) {
            Button {
                if isApproved {
                    approvedTools.remove(permission.tool)
                } else {
                    approvedTools.insert(permission.tool)
                }
            } label: {
                Image(systemName: isApproved ? "checkmark.square.fill" : "square")
                    .font(.system(size: 20))
                    .foregroundColor(isApproved ? VColor.accent : VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isApproved ? "Approved" : "Not approved")

            VStack(alignment: .leading, spacing: 2) {
                Text(permission.tool)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Text(permission.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            Spacer()

            riskBadge(for: permission.riskLevel)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isApproved {
                approvedTools.remove(permission.tool)
            } else {
                approvedTools.insert(permission.tool)
            }
        }
    }

    private func riskBadge(for level: String) -> some View {
        let color: Color = {
            switch level.lowercased() {
            case "low": return VColor.success
            case "medium": return VColor.warning
            case "high": return VColor.error
            default: return VColor.textMuted
            }
        }()
        return Text(level.capitalized)
            .font(VFont.small)
            .foregroundColor(color)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}

#endif
