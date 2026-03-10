import SwiftUI
import VellumAssistantShared

/// A sheet that shows required tool permissions before running a task.
/// The user can toggle individual permissions on/off before approving.
struct TaskPreflightView: View {
    let itemTitle: String
    let state: TaskPreflightState
    let onApprove: ([String]) -> Void
    let onDismiss: () -> Void

    @State private var approvedTools: Set<String> = []
    @State private var didInitApproved = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            contentBody
        }
        .frame(width: 420, height: 400)
        .background(VColor.background)
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("Permission Preflight")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
            Spacer()
            Button("Cancel", action: onDismiss)
                .buttonStyle(.plain)
                .foregroundColor(VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch state {
        case .loading:
            VStack(spacing: VSpacing.md) {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Checking required permissions…")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error(let message):
            VStack(spacing: VSpacing.lg) {
                Spacer()
                VIconView(.triangleAlert, size: 40)
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
                noPermissionsNeeded
            } else {
                permissionsListView(permissions)
            }
        }
    }

    private var noPermissionsNeeded: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            VIconView(.shieldCheck, size: 48)
                .foregroundColor(VColor.success)
            Text("No Permissions Required")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
            Text("This task can run without additional approvals.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Permissions List

    private func permissionsListView(_ permissions: [IPCWorkItemPreflightResponsePermission]) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Task: \(itemTitle)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .padding(.bottom, VSpacing.xs)

                    Text("This task requires the following permissions:")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textMuted)
                        .padding(.bottom, VSpacing.sm)

                    ForEach(permissions, id: \.tool) { permission in
                        permissionRow(permission)
                    }
                    .onAppear {
                        if !didInitApproved {
                            approvedTools = Set(permissions.map(\.tool))
                            didInitApproved = true
                        }
                    }

                    Text("\(approvedTools.count) of \(permissions.count) approved")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .padding(.top, VSpacing.sm)
                }
                .padding(VSpacing.lg)
            }

            Divider()
            approveFooter(permissions: permissions)
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
                VIconView(isApproved ? .listChecks : .square, size: 16)
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
        .padding(.vertical, VSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(permission.tool), \(permission.description), risk: \(permission.riskLevel), \(isApproved ? "approved" : "not approved")")
        .accessibilityHint("Double-tap to \(isApproved ? "revoke" : "approve") this permission")
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

    // MARK: - Approve Footer

    private func approveFooter(permissions: [IPCWorkItemPreflightResponsePermission]) -> some View {
        HStack {
            Spacer()
            Button {
                onApprove(Array(approvedTools))
            } label: {
                Text("Approve & Run")
                    .font(VFont.captionMedium)
                    .foregroundColor(.white)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                    .background(approvedTools.isEmpty ? VColor.accent.opacity(0.4) : VColor.accent)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
            .buttonStyle(.plain)
            .disabled(approvedTools.isEmpty)
            .accessibilityLabel("Approve and run")
            .accessibilityHint(approvedTools.isEmpty ? "Select at least one permission first" : "Runs the task with \(approvedTools.count) approved permissions")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }
}
