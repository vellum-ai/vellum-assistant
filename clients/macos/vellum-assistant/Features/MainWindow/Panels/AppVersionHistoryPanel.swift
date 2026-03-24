import SwiftUI
import VellumAssistantShared

/// Panel showing the version history of an app, with diff viewing and restore.
struct AppVersionHistoryPanel: View {
    let connectionManager: GatewayConnectionManager
    let appId: String
    let appName: String
    let onClose: () -> Void

    @State private var versions: [AppHistoryResponseVersion] = []
    @State private var isLoading = true
    @State private var selectedVersion: AppHistoryResponseVersion?
    @State private var diffText: String?
    @State private var isDiffLoading = false
    @State private var restoreConfirmVersion: AppHistoryResponseVersion?
    @State private var isRestoring = false
    @State private var restoreError: String?
    @State private var pendingDiffCommitHash: String?
    @State private var fetchHistoryId: UUID?
    @State private var historyTimeoutTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                VButton(label: "Back", icon: "chevron.left", style: .outlined) {
                    onClose()
                }
                .controlSize(.small)

                Spacer()

                Text("Version History")
                    .font(VFont.bodyMediumDefault)
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                // Invisible spacer to balance the back button
                Color.clear.frame(width: 60, height: 1)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            Divider()
                .foregroundColor(VColor.borderBase)

            if isLoading {
                Spacer()
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading history...")
                        .font(VFont.bodyMediumLighter)
                        .foregroundColor(VColor.contentSecondary)
                    Spacer()
                }
                Spacer()
            } else if versions.isEmpty {
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: VSpacing.sm) {
                        VIconView(.clock, size: 32)
                            .foregroundColor(VColor.contentTertiary)
                        Text("No version history")
                            .font(VFont.bodyMediumLighter)
                            .foregroundColor(VColor.contentSecondary)
                        Text("Changes will appear here after you edit the app.")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    Spacer()
                }
                Spacer()
            } else {
                // Version list + optional diff detail
                HSplitView {
                    versionList
                        .frame(minWidth: 280, idealWidth: 320)

                    if let selected = selectedVersion {
                        diffDetailView(for: selected)
                            .frame(minWidth: 300)
                    }
                }
            }
        }
        .background(VColor.surfaceOverlay)
        .onAppear { fetchHistory() }
        .onDisappear { historyTimeoutTask?.cancel() }
        .alert("Restore Version?", isPresented: .init(
            get: { restoreConfirmVersion != nil },
            set: { if !$0 { restoreConfirmVersion = nil } }
        )) {
            Button("Cancel", role: .cancel) {
                restoreConfirmVersion = nil
            }
            Button("Restore", role: .destructive) {
                if let version = restoreConfirmVersion {
                    restoreVersion(version)
                }
            }
        } message: {
            if let version = restoreConfirmVersion {
                Text("This will restore \"\(appName)\" to version \(String(version.commitHash.prefix(7))). A new version will be created with the restored content.")
            }
        }
    }

    // MARK: - Version List

    private var versionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(versions.enumerated()), id: \.element.commitHash) { index, version in
                    versionRow(version, isFirst: index == 0)
                }
            }
            .padding(.vertical, VSpacing.sm)
        }
    }

    private func versionRow(_ version: AppHistoryResponseVersion, isFirst: Bool) -> some View {
        let isSelected = selectedVersion?.commitHash == version.commitHash
        return Button(action: {
            if selectedVersion?.commitHash == version.commitHash {
                selectedVersion = nil
                diffText = nil
            } else {
                selectVersion(version)
            }
        }) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                // Timeline dot
                Circle()
                    .fill(isFirst ? VColor.primaryBase : VColor.contentTertiary.opacity(0.5))
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 2) {
                    Text(version.message)
                        .font(VFont.bodyMediumLighter)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(2)

                    HStack(spacing: VSpacing.sm) {
                        Text(String(version.commitHash.prefix(7)))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(VColor.contentTertiary)

                        Text(relativeTime(from: version.timestamp))
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }

                Spacer()

                if !isFirst {
                    Button(action: {
                        restoreConfirmVersion = version
                    }) {
                        VIconView(.rotateCcw, size: 12)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                    .help("Restore to this version")
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Diff Detail

    @ViewBuilder
    private func diffDetailView(for version: AppHistoryResponseVersion) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Diff header
            HStack {
                Text("Changes in ")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentSecondary)
                + Text(String(version.commitHash.prefix(7)))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                if !isRestoring && version.commitHash != versions.first?.commitHash {
                    VButton(label: "Restore", icon: "arrow.counterclockwise", style: .outlined) {
                        restoreConfirmVersion = version
                    }
                    .controlSize(.small)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            Divider()

            if isDiffLoading {
                Spacer()
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                Spacer()
            } else if let diff = diffText, !diff.isEmpty {
                ScrollView(.vertical) {
                    ScrollView(.horizontal) {
                        Text(diff)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(VColor.contentDefault)
                            .textSelection(.enabled)
                            .padding(VSpacing.md)
                    }
                }
            } else {
                Spacer()
                HStack {
                    Spacer()
                    Text("No changes in this version")
                        .font(VFont.bodyMediumLighter)
                        .foregroundColor(VColor.contentSecondary)
                    Spacer()
                }
                Spacer()
            }

            if let error = restoreError {
                HStack {
                    VIconView(.triangleAlert, size: 14)
                        .foregroundColor(VColor.systemNegativeStrong)
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
            }
        }
        .background(VColor.surfaceBase)
    }

    // MARK: - Data Fetching

    private func fetchHistory() {
        let currentId = UUID()
        fetchHistoryId = currentId
        isLoading = true
        Task { @MainActor in
            let response = await AppsClient().fetchAppHistory(appId: appId)
            guard fetchHistoryId == currentId else { return }
            if let response {
                versions = response.versions
            }
            isLoading = false
        }
    }

    private func selectVersion(_ version: AppHistoryResponseVersion) {
        selectedVersion = version
        isDiffLoading = true
        diffText = nil
        pendingDiffCommitHash = version.commitHash

        // Find the previous version to diff against
        guard let index = versions.firstIndex(where: { $0.commitHash == version.commitHash }),
              index + 1 < versions.count else {
            // First version — no previous to diff against
            isDiffLoading = false
            diffText = ""
            return
        }
        let previousVersion = versions[index + 1]

        let expectedHash = version.commitHash
        Task { @MainActor in
            let response = await AppsClient().fetchAppDiff(appId: appId, fromCommit: previousVersion.commitHash, toCommit: version.commitHash)
            guard pendingDiffCommitHash == expectedHash else { return }
            diffText = response?.diff ?? ""
            isDiffLoading = false
        }
    }

    private func restoreVersion(_ version: AppHistoryResponseVersion) {
        isRestoring = true
        restoreError = nil
        restoreConfirmVersion = nil

        Task { @MainActor in
            let response = await AppsClient().restoreApp(appId: appId, commitHash: version.commitHash)
            isRestoring = false
            if let response, response.success {
                // Refresh history to show the new restore commit
                fetchHistory()
                selectedVersion = nil
                diffText = nil
            } else {
                restoreError = response?.error ?? "Restore failed"
            }
        }
    }

    // MARK: - Helpers

    private func relativeTime(from timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
