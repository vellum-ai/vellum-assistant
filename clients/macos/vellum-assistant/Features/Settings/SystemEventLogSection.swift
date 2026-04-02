import SwiftUI
import VellumAssistantShared

@MainActor
struct SystemEventLogSection: View {
    private static let maximumEntryCount = UnifiedLogReader.defaultMaximumEntryCount
    private static let lookbackWindow = UnifiedLogReader.defaultLookback

    @State private var entries: [UnifiedLogEntry] = []
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var lastRefreshedAt: Date?
    @State private var logText: String = ""

    private var statusText: String {
        let entryCountLabel = entries.count == 1 ? "1 entry" : "\(entries.count) entries"
        if let lastRefreshedAt {
            return "\(entryCountLabel) loaded • Refreshed \(lastRefreshedAt.formatted(date: .omitted, time: .standard))"
        }
        return isLoading ? "Loading system events..." : "Not loaded yet"
    }

    var body: some View {
        SettingsCard(
            title: "System Event Log",
            subtitle: "Recent unified log entries emitted by this running macOS app process."
        ) {
            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Refresh",
                    icon: VIcon.refreshCw.rawValue,
                    style: .outlined,
                    size: .compact,
                    isDisabled: isLoading
                ) {
                    Task { await refreshEntries() }
                }

                if !logText.isEmpty {
                    VCopyButton(
                        text: logText,
                        size: .compact,
                        accessibilityHint: "Copy system event log"
                    )
                }

                Spacer()

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            VInlineMessage(
                "Shows the last \(Self.maximumEntryCount) log entries from the past 24 hours for the current app process. Use Cmd+F inside the viewer to search.",
                tone: .info
            )

            if let loadError {
                VInlineMessage("Couldn't load the system event log: \(loadError)", tone: .error)
            }

            Text(statusText)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            if logText.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                    }

                    Text(isLoading ? "Loading system events..." : "No system events found.")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 180)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceBase)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderDisabled, lineWidth: 1)
                )
            } else {
                VCodeView(text: logText)
                    .frame(minHeight: 220, maxHeight: 360)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderDisabled, lineWidth: 1)
                    )
            }
        }
        .task {
            guard entries.isEmpty, !isLoading else { return }
            await refreshEntries()
        }
    }

    private func refreshEntries() async {
        guard !isLoading else { return }

        isLoading = true
        loadError = nil

        let startDate = Date().addingTimeInterval(-Self.lookbackWindow)
        let maximumEntryCount = Self.maximumEntryCount

        do {
            let loadedEntries = try await Task.detached(priority: .utility) {
                try UnifiedLogReader.readRecentEntries(
                    since: startDate,
                    maximumEntryCount: maximumEntryCount
                )
            }.value
            entries = loadedEntries
            logText = loadedEntries.map(\.formattedLine).joined(separator: "\n")
            lastRefreshedAt = Date()
        } catch {
            loadError = error.localizedDescription
        }

        isLoading = false
    }
}
