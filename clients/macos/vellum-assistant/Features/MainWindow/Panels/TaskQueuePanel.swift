import SwiftUI
import VellumAssistantShared

struct TaskQueuePanel: View {
    @ObservedObject var daemonClient: DaemonClient
    let onClose: () -> Void

    @State private var items: [IPCWorkItemsListResponseItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        VSidePanel(title: "Task Queue", onClose: onClose) {
            if isLoading {
                VStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else if items.isEmpty {
                VEmptyState(
                    title: "No tasks",
                    subtitle: "Queued work items will appear here",
                    icon: "list.bullet.clipboard"
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: VSpacing.xs) {
                        ForEach(items, id: \.id) { item in
                            TaskQueueRow(
                                item: item,
                                onRun: { runTask(id: item.id) },
                                onComplete: { completeTask(id: item.id) }
                            )
                        }
                    }
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                }
            }
        }
        .onAppear {
            fetchWorkItems()
            listenForStatusChanges()
        }
    }

    // MARK: - Data Fetching

    private func fetchWorkItems() {
        isLoading = true
        errorMessage = nil

        daemonClient.onWorkItemsListResponse = { response in
            self.items = response.items
            self.isLoading = false
        }

        do {
            try daemonClient.sendWorkItemsList()
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func listenForStatusChanges() {
        daemonClient.onWorkItemStatusChanged = { changed in
            // Update the item in-place or re-fetch the list
            // Re-fetch the full list to pick up changes
            do {
                try daemonClient.sendWorkItemsList()
            } catch {
                // Silently ignore; the list will refresh on next status change
            }
        }
    }

    // MARK: - Actions

    private func runTask(id: String) {
        do {
            try daemonClient.sendWorkItemRunTask(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func completeTask(id: String) {
        do {
            try daemonClient.sendWorkItemComplete(id: id)
            // Optimistic removal
            items.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Task Queue Row

private struct TaskQueueRow: View {
    let item: IPCWorkItemsListResponseItem
    let onRun: () -> Void
    let onComplete: () -> Void
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                priorityIndicator
                Text(item.title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                Spacer()
                statusBadge
            }

            if let notes = item.notes, !notes.isEmpty {
                Text(notes)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineLimit(2)
            }

            // Action buttons based on status
            HStack(spacing: VSpacing.sm) {
                if item.status == "queued" {
                    Button(action: onRun) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 10))
                            Text("Run")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.accent)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.accent.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                    .buttonStyle(.plain)
                }

                if item.status == "awaiting_review" {
                    Button(action: onComplete) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10))
                            Text("Mark Reviewed")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.success)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.success.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                if let lastRunStatus = item.lastRunStatus {
                    Text("Last run: \(lastRunStatus)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .padding(VSpacing.md)
        .background(isHovered ? VColor.surface.opacity(0.8) : VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
        .onHover { hovering in
            isHovered = hovering
        }
    }

    // MARK: - Priority Indicator

    @ViewBuilder
    private var priorityIndicator: some View {
        let tier = item.priorityTier
        Circle()
            .fill(priorityColor(tier: tier))
            .frame(width: 8, height: 8)
            .accessibilityLabel("Priority \(Int(tier))")
    }

    private func priorityColor(tier: Double) -> Color {
        switch tier {
        case 0: return VColor.error      // Urgent
        case 1: return VColor.warning    // High
        case 2: return VColor.accent     // Normal
        default: return VColor.textMuted // Low
        }
    }

    // MARK: - Status Badge

    @ViewBuilder
    private var statusBadge: some View {
        let (label, color, showSpinner) = statusInfo(item.status)
        HStack(spacing: VSpacing.xs) {
            if showSpinner {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(label)
                .font(VFont.caption)
                .foregroundColor(color)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, 2)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private func statusInfo(_ status: String) -> (String, Color, Bool) {
        switch status {
        case "queued":
            return ("Queued", VColor.textSecondary, false)
        case "running":
            return ("Running", VColor.accent, true)
        case "awaiting_review":
            return ("Awaiting Review", VColor.warning, false)
        case "failed":
            return ("Failed", VColor.error, false)
        case "done":
            return ("Done", VColor.success, false)
        default:
            return (status, VColor.textMuted, false)
        }
    }
}

// MARK: - Preview

#if DEBUG
struct TaskQueuePanelPreview: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            TaskQueuePanel(
                daemonClient: DaemonClient(),
                onClose: {}
            )
            .frame(width: 400, height: 600)
        }
    }
}
#endif
