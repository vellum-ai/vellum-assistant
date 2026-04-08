import SwiftUI
import VellumAssistantShared

/// Lists `AssistantSystemEvent` records for the connected managed assistant by
/// calling the platform's `GET /v1/assistants/{id}/system-events/` endpoint.
///
/// Mirrors the system events panel on the vellum-assistant-platform settings
/// page so users can inspect lifecycle, upgrade, rollback, crash, and profiler
/// events without leaving the desktop app.
@MainActor
struct SystemEventLogSection: View {
    let assistant: LockfileAssistant

    private static let pageLimit = 50

    @State private var events: [AssistantSystemEvent] = []
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var hasMore = true
    @State private var nextOffset = 0
    @State private var expandedEventIds: Set<String> = []
    @State private var lastRefreshedAt: Date?
    @State private var hasLoadedOnce = false

    var body: some View {
        SettingsCard(
            title: "System Event Log",
            subtitle: "Lifecycle, upgrade, and crash events recorded for this assistant on the Vellum platform."
        ) {
            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Refresh",
                    icon: VIcon.refreshCw.rawValue,
                    style: .outlined,
                    size: .compact,
                    isDisabled: isLoading
                ) {
                    Task { await refresh() }
                }

                Spacer()

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            if let loadError {
                VInlineMessage("Couldn't load system events: \(loadError)", tone: .error)
            }

            if let lastRefreshedAt {
                Text(statusLine(refreshedAt: lastRefreshedAt))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            content
        }
        .task {
            guard !hasLoadedOnce else { return }
            await refresh()
        }
    }

    @ViewBuilder
    private var content: some View {
        if events.isEmpty {
            if hasLoadedOnce && !isLoading {
                emptyState
            } else {
                placeholderState
            }
        } else {
            eventList
            if hasMore {
                VButton(
                    label: isLoading ? "Loading..." : "Load older events",
                    style: .outlined,
                    size: .compact,
                    isDisabled: isLoading
                ) {
                    Task { await loadMore() }
                }
            }
        }
    }

    @ViewBuilder
    private var placeholderState: some View {
        VStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.small)
                .progressViewStyle(.circular)
            Text("Loading system events...")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: VSpacing.sm) {
            Text("No system events recorded for this assistant yet.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var eventList: some View {
        VStack(spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                eventRow(event)
                if index < events.count - 1 {
                    SettingsDivider()
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func eventRow(_ event: AssistantSystemEvent) -> some View {
        let isExpanded = expandedEventIds.contains(event.id)
        let detailsJSON = event.prettyDetailsJSON
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                VTag(event.type.displayName, color: event.type.color)
                VBadge(label: event.eventStatus.displayName, tone: event.eventStatus.tone, emphasis: .subtle)
                Spacer()
                Text(event.formattedOccurredAt)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                if detailsJSON != nil {
                    Button {
                        if isExpanded {
                            expandedEventIds.remove(event.id)
                        } else {
                            expandedEventIds.insert(event.id)
                        }
                    } label: {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isExpanded ? "Hide event details" : "Show event details")
                }
            }

            Text(event.displayText)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

            if isExpanded, let detailsJSON {
                VCodeView(text: detailsJSON)
                    .frame(maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
        }
        .padding(VSpacing.md)
    }

    private func statusLine(refreshedAt: Date) -> String {
        let suffix = hasMore ? "+" : ""
        let countLabel = events.count == 1 ? "1 event" : "\(events.count)\(suffix) events"
        let refreshed = refreshedAt.formatted(date: .omitted, time: .standard)
        return "\(countLabel) loaded • Refreshed \(refreshed)"
    }

    // MARK: - Loading

    private func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        do {
            let page = try await fetchPage(offset: 0)
            events = page.results
            nextOffset = page.results.count
            hasMore = page.next != nil
            expandedEventIds = []
            lastRefreshedAt = Date()
            hasLoadedOnce = true
        } catch {
            loadError = friendlyMessage(for: error)
            hasLoadedOnce = true
        }
    }

    private func loadMore() async {
        guard !isLoading, hasMore else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let page = try await fetchPage(offset: nextOffset)
            events.append(contentsOf: page.results)
            nextOffset += page.results.count
            hasMore = page.next != nil
        } catch {
            loadError = friendlyMessage(for: error)
        }
    }

    private func fetchPage(offset: Int) async throws -> PaginatedAssistantSystemEvents {
        let path = "assistants/\(assistant.assistantId)/system-events"
        let params: [String: String] = [
            "limit": String(Self.pageLimit),
            "offset": String(offset),
        ]
        let (decoded, response): (PaginatedAssistantSystemEvents?, GatewayHTTPClient.Response) =
            try await GatewayHTTPClient.get(
                path: path,
                params: params,
                configure: { decoder in
                    decoder.dateDecodingStrategy = AssistantSystemEvent.dateDecodingStrategy
                }
            )
        guard response.isSuccess else {
            throw SystemEventLogError.httpFailure(status: response.statusCode)
        }
        guard let decoded else {
            throw SystemEventLogError.decodingFailure
        }
        return decoded
    }

    private func friendlyMessage(for error: Error) -> String {
        if let clientError = error as? GatewayHTTPClient.ClientError {
            return clientError.localizedDescription
        }
        if let logError = error as? SystemEventLogError {
            return logError.message
        }
        return error.localizedDescription
    }
}

// MARK: - Errors

private enum SystemEventLogError: Error {
    case httpFailure(status: Int)
    case decodingFailure

    var message: String {
        switch self {
        case let .httpFailure(status):
            return "Server returned HTTP \(status)"
        case .decodingFailure:
            return "Could not parse the system events response"
        }
    }
}

// MARK: - API Models

/// Paginated response wrapper for `GET /v1/assistants/{id}/system-events/`.
///
/// Matches Django's `PaginatedAssistantSystemEventList` (LimitOffsetPagination).
struct PaginatedAssistantSystemEvents: Decodable {
    let count: Int
    let next: String?
    let previous: String?
    let results: [AssistantSystemEvent]
}

/// One row in the system events table. Matches the platform's
/// `AssistantSystemEventSerializer`.
struct AssistantSystemEvent: Decodable, Identifiable {
    let id: String
    let type: SystemEventType
    let eventStatus: SystemEventStatus
    let source: String
    let reason: String
    let displayText: String
    let details: AnyCodable?
    let occurredAt: Date

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case eventStatus = "event_status"
        case source
        case reason
        case displayText = "display_text"
        case details
        case occurredAt = "occurred_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        let rawType = try container.decode(String.self, forKey: .type)
        type = SystemEventType(rawValue: rawType) ?? .other
        let rawStatus = try container.decode(String.self, forKey: .eventStatus)
        eventStatus = SystemEventStatus(rawValue: rawStatus) ?? .other
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? ""
        reason = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
        displayText = try container.decodeIfPresent(String.self, forKey: .displayText) ?? ""
        details = try container.decodeIfPresent(AnyCodable.self, forKey: .details)
        occurredAt = try container.decode(Date.self, forKey: .occurredAt)
    }

    /// Pretty-printed JSON of the `details` field for the expandable row body.
    /// Returns nil for empty objects so the disclosure chevron can be hidden.
    var prettyDetailsJSON: String? {
        guard let value = details?.value else { return nil }
        if let dict = value as? [String: Any], dict.isEmpty { return nil }
        if let array = value as? [Any], array.isEmpty { return nil }
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        guard let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.prettyPrinted, .sortedKeys]
        ) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    var formattedOccurredAt: String {
        occurredAt.formatted(date: .abbreviated, time: .standard)
    }

    /// JSONDecoder strategy for the platform's ISO8601 timestamps. The Django
    /// serializer emits values like `2024-01-15T10:30:45.123456Z` so we accept
    /// both fractional and integer-second forms.
    static let dateDecodingStrategy: JSONDecoder.DateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Invalid ISO8601 timestamp: \(raw)"
        )
    }
}

// MARK: - Event Type / Status Enums

/// Mirrors the platform's `SystemEventType` text choices. `other` is the
/// safe fallback for new server-side values the client doesn't recognise yet.
enum SystemEventType: String, Decodable {
    case lifecycle
    case upgrade
    case rollback
    case crash
    case idleSleep = "idle_sleep"
    case wake
    case profiler
    case other

    var displayName: String {
        switch self {
        case .lifecycle: return "Lifecycle"
        case .upgrade: return "Upgrade"
        case .rollback: return "Rollback"
        case .crash: return "Crash"
        case .idleSleep: return "Idle Sleep"
        case .wake: return "Wake"
        case .profiler: return "Profiler"
        case .other: return "Other"
        }
    }

    /// Tag color for the type pill. Uses design system tokens (raw SwiftUI
    /// `Color` literals are blocked by the design token guard). The palette is
    /// narrower than the platform UI's Tailwind colors but still gives crash /
    /// rollback / upgrade visual prominence.
    var color: Color {
        switch self {
        case .lifecycle: return VColor.primaryBase
        case .upgrade: return VColor.systemPositiveStrong
        case .rollback: return VColor.systemMidStrong
        case .crash: return VColor.systemNegativeStrong
        case .idleSleep: return VColor.contentTertiary
        case .wake: return VColor.systemPositiveStrong
        case .profiler: return VColor.primaryBase
        case .other: return VColor.contentTertiary
        }
    }
}

/// Mirrors the platform's `SystemEventStatus` text choices.
enum SystemEventStatus: String, Decodable {
    case started
    case succeeded
    case failed
    case inProgress = "in_progress"
    case other

    var displayName: String {
        switch self {
        case .started: return "Started"
        case .succeeded: return "Succeeded"
        case .failed: return "Failed"
        case .inProgress: return "In Progress"
        case .other: return "Unknown"
        }
    }

    /// Semantic tone for the status badge.
    var tone: VBadge.Tone {
        switch self {
        case .started: return .neutral
        case .succeeded: return .positive
        case .failed: return .danger
        case .inProgress: return .warning
        case .other: return .neutral
        }
    }
}
