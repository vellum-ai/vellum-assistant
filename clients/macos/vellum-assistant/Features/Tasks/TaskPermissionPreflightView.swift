import SwiftUI
import VellumAssistantShared

/// The loading/loaded/error state for the permission preflight check.
enum PreflightState {
    case loading
    case loaded([IPCWorkItemPreflightResponsePermission])
    case error(String)
}

/// A sheet that shows required permissions before running a task.
/// The user can approve or deny individual tool permissions, then
/// confirm to proceed with the run.
struct TaskPermissionPreflightView: View {
    let itemTitle: String
    let state: PreflightState
    let onApprove: ([String]) -> Void
    let onDismiss: () -> Void

    /// Tracks which tools the user has toggled on for approval.
    @State private var approvedTools: Set<String> = []
    /// Whether we have initialized the approved set from the loaded permissions.
    @State private var didInitApproved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(VColor.surfaceBorder)
            content
        }
        .frame(width: 420)
        .frame(minHeight: 280)
        .background(VColor.background)
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Permission Preflight")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text(itemTitle)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 24, height: 24)
                    .background(VColor.surfaceBorder.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            VStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Checking required permissions...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .padding(.top, VSpacing.sm)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error(let message):
            VStack(spacing: VSpacing.md) {
                Spacer()
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 24))
                    .foregroundColor(VColor.warning)
                Text(message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .padding(VSpacing.lg)

        case .loaded(let permissions):
            if permissions.isEmpty {
                VStack(spacing: VSpacing.md) {
                    Spacer()
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 24))
                        .foregroundColor(VColor.success)
                    Text("No special permissions required")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Text("This task can run without additional approvals.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .padding(VSpacing.lg)
            } else {
                permissionsList(permissions)
            }
        }
    }

    // MARK: - Permissions List

    private func permissionsList(_ permissions: [IPCWorkItemPreflightResponsePermission]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("This task requires the following permissions:")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.sm)

            ScrollView {
                VStack(spacing: VSpacing.xs) {
                    ForEach(permissions, id: \.tool) { permission in
                        permissionRow(permission)
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
            }
            .onAppear {
                // Default all tools to approved on first appearance
                if !didInitApproved {
                    approvedTools = Set(permissions.map(\.tool))
                    didInitApproved = true
                }
            }

            Divider().background(VColor.surfaceBorder)

            // Footer with Approve / Cancel buttons
            HStack {
                Text("\(approvedTools.count) of \(permissions.count) approved")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                Spacer()
                Button(action: onDismiss) {
                    Text("Cancel")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textSecondary)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
                .buttonStyle(.plain)

                Button {
                    onApprove(Array(approvedTools))
                } label: {
                    Text("Approve & Run")
                        .font(VFont.bodyMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(approvedTools.isEmpty ? VColor.accent.opacity(0.4) : VColor.accent)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
                .buttonStyle(.plain)
                .disabled(approvedTools.isEmpty)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
        }
    }

    private func permissionRow(_ permission: IPCWorkItemPreflightResponsePermission) -> some View {
        let isApproved = approvedTools.contains(permission.tool)
        return HStack(spacing: VSpacing.sm) {
            // Toggle checkbox
            Button {
                if isApproved {
                    approvedTools.remove(permission.tool)
                } else {
                    approvedTools.insert(permission.tool)
                }
            } label: {
                Image(systemName: isApproved ? "checkmark.square.fill" : "square")
                    .font(.system(size: 16))
                    .foregroundColor(isApproved ? VColor.accent : VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isApproved ? "Approved" : "Not approved")

            // Tool info
            VStack(alignment: .leading, spacing: 2) {
                Text(permission.tool)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text(permission.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            Spacer()

            // Risk level badge
            riskBadge(for: permission.riskLevel)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
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

// MARK: - Preview

#if DEBUG
struct TaskPermissionPreflightViewPreview: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            TaskPermissionPreflightView(
                itemTitle: "Run daily report",
                state: .loading,
                onApprove: { _ in },
                onDismiss: {}
            )
        }
    }
}
#endif
