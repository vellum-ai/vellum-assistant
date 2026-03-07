import SwiftUI
import VellumAssistantShared

struct HeartbeatRunsView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var runs: [IPCHeartbeatRunsListResponseRun] = []
    @State private var expandedRunId: String?
    @State private var previousRunsListCallback: ((IPCHeartbeatRunsListResponse) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Heartbeat Runs")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VButton(label: "Done", style: .tertiary) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            if runs.isEmpty {
                Spacer()
                VStack(spacing: VSpacing.sm) {
                    VIconView(.history, size: 32)
                        .foregroundColor(VColor.textMuted)
                    Text("No heartbeat runs yet")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(runs, id: \.id) { run in
                            VStack(alignment: .leading, spacing: 0) {
                                Button {
                                    withAnimation(VAnimation.fast) {
                                        expandedRunId = expandedRunId == run.id ? nil : run.id
                                    }
                                } label: {
                                    HStack(spacing: VSpacing.md) {
                                        resultBadge(run.result)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(run.title)
                                                .font(VFont.body)
                                                .foregroundColor(VColor.textPrimary)
                                                .lineLimit(1)
                                            Text(formatTimestamp(run.createdAt))
                                                .font(VFont.caption)
                                                .foregroundColor(VColor.textMuted)
                                        }
                                        Spacer()
                                        VIconView(expandedRunId == run.id ? .chevronDown : .chevronRight, size: 10)
                                            .foregroundColor(VColor.textMuted)
                                    }
                                    .padding(VSpacing.sm)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                if expandedRunId == run.id {
                                    Text(run.summary?.isEmpty == false ? run.summary! : "No summary available")
                                        .font(VFont.mono)
                                        .foregroundColor(VColor.textSecondary)
                                        .textSelection(.enabled)
                                        .padding(VSpacing.sm)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(VColor.surface)
                                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: VRadius.md)
                                                .stroke(VColor.surfaceBorder, lineWidth: 1)
                                        )
                                        .padding(.horizontal, VSpacing.sm)
                                        .padding(.bottom, VSpacing.sm)
                                }
                            }

                            if run.id != runs.last?.id {
                                Divider().background(VColor.surfaceBorder)
                            }
                        }
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                }
            }
        }
        .frame(width: 500, height: 450)
        .background(VColor.background)
        .onAppear { setupCallbacks(); loadRuns() }
        .onDisappear { clearCallbacks() }
    }

    // MARK: - Helpers

    private func resultBadge(_ result: String) -> some View {
        Group {
            switch result {
            case "ok":
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.success)
                    Text("OK")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.success)
                }
            case "alert":
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 14)
                        .foregroundColor(VColor.warning)
                    Text("ALERT")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.warning)
                }
            default:
                HStack(spacing: VSpacing.xs) {
                    VIconView(.info, size: 14)
                        .foregroundColor(VColor.textMuted)
                    Text("--")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .frame(width: 70, alignment: .leading)
    }

    private func formatTimestamp(_ ms: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Data Loading

    private func loadRuns() {
        try? daemonClient.sendHeartbeatRunsList(limit: 20)
    }

    private func setupCallbacks() {
        previousRunsListCallback = daemonClient.onHeartbeatRunsListResponse

        daemonClient.onHeartbeatRunsListResponse = { response in
            Task { @MainActor in
                self.runs = response.runs
            }
        }
    }

    private func clearCallbacks() {
        daemonClient.onHeartbeatRunsListResponse = previousRunsListCallback
    }
}
