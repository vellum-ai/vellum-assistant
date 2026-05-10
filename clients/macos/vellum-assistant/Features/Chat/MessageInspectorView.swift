import SwiftUI
import VellumAssistantShared

struct MessageInspectorView: View {
    let messageId: String
    let onBack: () -> Void

    private let llmContextClient: any LLMContextClientProtocol
    private let callRailWidth: CGFloat = 260

    @State private var viewState = MessageInspectorViewState()
    @State private var payloadModels: [String: MessageInspectorPayloadModel] = [:]
    @State private var payloadLoadingIDs: Set<String> = []
    @State private var payloadFailedIDs: Set<String> = []

    init(
        messageId: String,
        onBack: @escaping () -> Void,
        llmContextClient: any LLMContextClientProtocol = LLMContextClient()
    ) {
        self.messageId = messageId
        self.onBack = onBack
        self.llmContextClient = llmContextClient
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
        .task(id: messageId) {
            await reloadContext(resetSelection: true)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            Button(action: onBack) {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.chevronLeft, size: 12)
                    Text("Back")
                        .font(VFont.bodyMediumDefault)
                }
                .foregroundStyle(VColor.contentDefault)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(VColor.surfaceOverlay)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to conversation")

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("LLM Context Inspector")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Text("Select a call to inspect overview details, prompt sections, response sections, or raw payloads.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: VSpacing.xxs) {
                switch viewState.loadState {
                case .loaded, .empty:
                    let count = viewState.logs.count
                    Text(count == 1 ? "1 LLM call" : "\(count) LLM calls")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                case .loading, .failed:
                    EmptyView()
                }

                Text(messageId)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.surfaceBase)
    }

    @ViewBuilder
    private var content: some View {
        switch viewState.loadState {
        case .loading:
            loadingState
        case .empty:
            emptyState
        case .failed:
            failedState
        case .loaded:
            loadedState
        }
    }

    private var loadingState: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VSkeletonBone(width: 110, height: 12)
                ForEach(0..<5, id: \.self) { _ in
                    skeletonCallRow
                }
                Spacer()
            }
            .padding(VSpacing.lg)
            .frame(width: callRailWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)

            Divider()

            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VSkeletonBone(width: 180, height: 18)
                    VSkeletonBone(width: 260, height: 12)
                    VSkeletonBone(width: 160, height: 12)
                }

                HStack(spacing: VSpacing.sm) {
                    ForEach(0..<5, id: \.self) { _ in
                        VSkeletonBone(width: 88, height: 32, radius: VRadius.md)
                    }
                    Spacer()
                }

                skeletonPayloadColumn

                Spacer()
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var emptyState: some View {
        VEmptyState(
            title: emptyStateTitle,
            subtitle: emptyStateSubtitle,
            icon: VIcon.messagesSquare.rawValue
        )
    }

    private var emptyStateTitle: String {
        switch viewState.conversationKind {
        case .backgroundMemoryConsolidation:
            return "Background memory run"
        case .background:
            return "Background conversation"
        case .scheduled:
            return "Scheduled conversation"
        case .user, nil:
            return "No LLM calls yet"
        }
    }

    private var emptyStateSubtitle: String {
        "This message does not have any recorded LLM context to inspect."
    }

    private var failedState: some View {
        VEmptyState(
            title: "Couldn't load LLM context",
            subtitle: "The inspector request failed before any call data could be shown.",
            icon: VIcon.triangleAlert.rawValue,
            actionLabel: "Retry",
            actionIcon: VIcon.refreshCw.rawValue
        ) {
            Task {
                await reloadContext(resetSelection: false)
            }
        }
    }

    private var loadedState: some View {
        HStack(spacing: 0) {
            callRail
            Divider()
            detailPane
        }
    }

    private var callRail: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(viewState.logs.enumerated()), id: \.element.id) { index, entry in
                    callRow(entry: entry, index: index)
                }
            }
            .padding(VSpacing.md)
        }
        .frame(width: callRailWidth, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private func callRow(entry: LLMRequestLogEntry, index: Int) -> some View {
        let isSelected = viewState.selectedLogID == entry.id

        return Button {
            viewState.selectLog(id: entry.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
                    Text(callTitle(for: entry, index: index))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)

                    Spacer(minLength: VSpacing.sm)

                    if index == viewState.logs.count - 1 {
                        Text("Latest")
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }

                Text(callSubtitle(for: entry))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(2)

                HStack(spacing: VSpacing.xs) {
                    if let provider = entry.summary?.provider {
                        callMetadataChip(provider)
                    }

                    if let model = entry.summary?.model {
                        callMetadataChip(model)
                    }

                    Spacer()

                    Text(formattedTimestamp(entry.createdAt))
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .padding(VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? VColor.surfaceActive : VColor.surfaceOverlay.opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.borderActive : VColor.borderBase, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var detailPane: some View {
        Group {
            if let selectedLog = viewState.selectedLog {
                VStack(spacing: 0) {
                    detailHeader(for: selectedLog)
                    Divider()
                    detailTabBar
                    Divider()
                    detailTabContent(for: selectedLog)
                }
            } else {
                VEmptyState(
                    title: "Select an LLM call",
                    subtitle: "Choose a call from the rail to inspect its context.",
                    icon: VIcon.panelLeft.rawValue
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private func detailHeader(for entry: LLMRequestLogEntry) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(callTitle(for: entry, index: selectedCallIndex(for: entry)))
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDefault)

            Text(detailSubtitle(for: entry))
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            if let summary = entry.summary {
                HStack(spacing: VSpacing.xs) {
                    if let status = summary.status {
                        detailMetadataChip(status)
                    }
                    if let provider = summary.provider {
                        detailMetadataChip(provider)
                    }
                    if let model = summary.model {
                        detailMetadataChip(model)
                    }
                    if let durationMs = summary.durationMs {
                        detailMetadataChip("\(durationMs) ms")
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var detailTabBar: some View {
        VTabs(
            items: MessageInspectorDetailTab.allCases.map { (label: $0.label, tag: $0) },
            selection: Binding(
                get: { viewState.selectedDetailTab },
                set: { viewState.selectDetailTab($0) }
            )
        )
    }

    @ViewBuilder
    private func detailTabContent(for entry: LLMRequestLogEntry) -> some View {
        switch viewState.selectedDetailTab {
        case .overview:
            MessageInspectorOverviewTab(entry: entry)
        case .memory:
            if let activation = viewState.memoryV2Activation {
                MessageInspectorMemoryV2Tab(activation: activation)
            } else {
                MessageInspectorMemoryTab(memoryRecall: viewState.memoryRecall)
            }
        case .prompt:
            MessageInspectorPromptTab(entry: entry)
        case .response:
            MessageInspectorResponseTab(entry: entry)
        case .raw:
            rawPayloadTab(for: entry)
        }
    }

    @ViewBuilder
    private func rawPayloadTab(for entry: LLMRequestLogEntry) -> some View {
        Group {
            if payloadLoadingIDs.contains(entry.id) {
                VStack {
                    ProgressView()
                        .padding(.top, VSpacing.xl)
                    Text("Loading raw payloads…")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .padding(.top, VSpacing.sm)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if payloadFailedIDs.contains(entry.id) {
                VEmptyState(
                    title: "Couldn't load raw payloads",
                    subtitle: "The payload request failed. Try again.",
                    icon: VIcon.triangleAlert.rawValue,
                    actionLabel: "Retry",
                    actionIcon: VIcon.refreshCw.rawValue
                ) {
                    Task { await loadPayloadIfNeeded(for: entry) }
                }
            } else {
                VStack(spacing: 0) {
                    HStack {
                        VSegmentControl(
                            items: RawPayloadPane.allCases.map { (label: $0.label, tag: $0) },
                            selection: rawPaneBinding
                        )
                        .fixedSize()

                        Spacer()
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)

                    MessageInspectorPayloadView(
                        title: viewState.selectedRawPane.label,
                        model: payloadBinding(
                            for: payloadKey(for: entry.id, kind: viewState.selectedRawPane.rawValue)
                        )
                    )
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.lg)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(VColor.surfaceBase)
            }
        }
        .task(id: entry.id) {
            await loadPayloadIfNeeded(for: entry)
        }
    }

    private var rawPaneBinding: Binding<RawPayloadPane> {
        Binding(
            get: { viewState.selectedRawPane },
            set: { viewState.selectRawPane($0) }
        )
    }

    private func payloadBinding(for key: String) -> Binding<MessageInspectorPayloadModel> {
        Binding(
            get: {
                payloadModels[key] ?? MessageInspectorPayloadModel(source: "")
            },
            set: { newValue in
                payloadModels[key] = newValue
            }
        )
    }

    @MainActor
    private func reloadContext(resetSelection: Bool) async {
        let requestToken = viewState.beginLoading(resetSelection: resetSelection)
        payloadModels = [:]
        payloadLoadingIDs = []
        payloadFailedIDs = []

        do {
            let result = try await llmContextClient.fetchContextResult(messageId: messageId)
            try Task.checkCancellation()
            guard viewState.isActiveLoad(requestToken) else { return }

            // If an older daemon still includes inline payloads, populate eagerly.
            if case let .loaded(response) = result {
                for entry in response.logs {
                    if let req = entry.requestPayload, req.value != nil {
                        payloadModels[payloadKey(for: entry.id, kind: "request")] =
                            MessageInspectorPayloadModel(payload: req)
                    }
                    if let res = entry.responsePayload, res.value != nil {
                        payloadModels[payloadKey(for: entry.id, kind: "response")] =
                            MessageInspectorPayloadModel(payload: res)
                    }
                }
            }

            viewState.finishLoading(with: result, requestToken: requestToken)
        } catch is CancellationError {
            guard viewState.isActiveLoad(requestToken) else { return }
        } catch {
            guard viewState.isActiveLoad(requestToken) else { return }
            viewState.finishLoading(with: .failed, requestToken: requestToken)
        }
    }

    @MainActor
    private func loadPayloadIfNeeded(for entry: LLMRequestLogEntry) async {
        let reqKey = payloadKey(for: entry.id, kind: "request")
        let resKey = payloadKey(for: entry.id, kind: "response")

        // Already loaded or in flight.
        if payloadModels[reqKey] != nil || payloadLoadingIDs.contains(entry.id) {
            return
        }

        payloadLoadingIDs.insert(entry.id)
        payloadFailedIDs.remove(entry.id)

        guard let payload = await llmContextClient.fetchLogPayload(logId: entry.id) else {
            payloadLoadingIDs.remove(entry.id)
            if !Task.isCancelled {
                payloadFailedIDs.insert(entry.id)
            }
            return
        }

        payloadModels[reqKey] = MessageInspectorPayloadModel(payload: payload.requestPayload)
        payloadModels[resKey] = MessageInspectorPayloadModel(payload: payload.responsePayload)
        payloadLoadingIDs.remove(entry.id)
    }

    private func payloadKey(for entryID: String, kind: String) -> String {
        "\(entryID)-\(kind)"
    }

    private func callTitle(for entry: LLMRequestLogEntry, index: Int) -> String {
        if let title = entry.summary?.title, !title.isEmpty {
            return title
        }

        return "LLM Call \(index + 1)"
    }

    private func callSubtitle(for entry: LLMRequestLogEntry) -> String {
        if let subtitle = entry.summary?.subtitle, !subtitle.isEmpty {
            return subtitle
        }

        if let summaryText = entry.summary?.summaryText, !summaryText.isEmpty {
            return summaryText
        }

        return "Recorded at \(formattedTimestamp(entry.createdAt))"
    }

    private func detailSubtitle(for entry: LLMRequestLogEntry) -> String {
        let timestamp = formattedDateTime(entry.createdAt)

        if let subtitle = entry.summary?.subtitle, !subtitle.isEmpty {
            return "\(subtitle) • \(timestamp)"
        }

        return timestamp
    }

    private func selectedCallIndex(for entry: LLMRequestLogEntry) -> Int {
        viewState.logs.firstIndex(where: { $0.id == entry.id }) ?? 0
    }

    private func callMetadataChip(_ label: String) -> some View {
        Text(label)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, 3)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private func detailMetadataChip(_ label: String) -> some View {
        Text(label)
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private var skeletonCallRow: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            VSkeletonBone(width: 130, height: 14)
            VSkeletonBone(width: 180, height: 12)
            HStack {
                VSkeletonBone(width: 56, height: 18, radius: VRadius.sm)
                Spacer()
                VSkeletonBone(width: 54, height: 10)
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceOverlay.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private var skeletonPayloadColumn: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                VSkeletonBone(width: 90, height: 12)
                Spacer()
                VSkeletonBone(width: 70, height: 12)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                VSkeletonBone(height: 12)
                    .frame(maxWidth: .infinity)
                VSkeletonBone(height: 12)
                    .frame(maxWidth: .infinity)
                VSkeletonBone(height: 12)
                    .frame(maxWidth: 220)
            }
            .frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)
            .padding(VSpacing.sm)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(VColor.surfaceOverlay.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private static let timeOnlyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .none
        f.timeStyle = .medium
        return f
    }()

    private static let dateTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .medium
        f.timeStyle = .medium
        return f
    }()

    private func formattedTimestamp(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000.0)
        Self.timeOnlyFormatter.timeZone = ChatTimestampTimeZone.resolve()
        return Self.timeOnlyFormatter.string(from: date)
    }

    private func formattedDateTime(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000.0)
        Self.dateTimeFormatter.timeZone = ChatTimestampTimeZone.resolve()
        return Self.dateTimeFormatter.string(from: date)
    }
}

enum MessageInspectorLoadState: Equatable {
    case loading
    case empty
    case failed
    case loaded
}

enum RawPayloadPane: String, CaseIterable {
    case request
    case response

    var label: String {
        switch self {
        case .request: return "Request"
        case .response: return "Response"
        }
    }
}

enum MessageInspectorDetailTab: String, CaseIterable {
    case overview
    case memory
    case prompt
    case response
    case raw

    var label: String {
        switch self {
        case .overview:
            return "Overview"
        case .memory:
            return "Memory"
        case .prompt:
            return "Prompt"
        case .response:
            return "Response"
        case .raw:
            return "Raw"
        }
    }

}

struct MessageInspectorViewState {
    private(set) var loadState: MessageInspectorLoadState = .loading
    private(set) var logs: [LLMRequestLogEntry] = []
    private(set) var memoryRecall: MemoryRecallData?
    private(set) var memoryV2Activation: MemoryV2ActivationData?
    private(set) var conversationKind: ConversationKind?
    private(set) var selectedLogID: String?
    private(set) var selectedDetailTab: MessageInspectorDetailTab = .overview
    private(set) var selectedRawPane: RawPayloadPane = .response
    private(set) var activeLoadToken: UUID?

    var selectedLog: LLMRequestLogEntry? {
        guard let selectedLogID else { return nil }
        return logs.first(where: { $0.id == selectedLogID })
    }

    mutating func beginLoading(resetSelection: Bool) -> UUID {
        let requestToken = UUID()
        activeLoadToken = requestToken
        loadState = .loading
        logs = []

        if resetSelection {
            selectedLogID = nil
            selectedDetailTab = .overview
        }

        return requestToken
    }

    func isActiveLoad(_ requestToken: UUID) -> Bool {
        activeLoadToken == requestToken
    }

    mutating func finishLoading(with result: LLMContextFetchResult, requestToken: UUID) {
        guard activeLoadToken == requestToken else { return }
        activeLoadToken = nil

        switch result {
        case .loaded(let response):
            let orderedLogs = Self.ordered(response.logs)
            logs = orderedLogs
            memoryRecall = response.memoryRecall
            memoryV2Activation = response.memoryV2Activation
            conversationKind = response.conversationKind

            guard !orderedLogs.isEmpty else {
                loadState = .empty
                selectedLogID = nil
                return
            }

            loadState = .loaded

            if selectedLogID == nil
               || !orderedLogs.contains(where: { $0.id == selectedLogID }) {
                selectedLogID = orderedLogs.last?.id
            }
        case .failed:
            logs = []
            memoryRecall = nil
            memoryV2Activation = nil
            conversationKind = nil
            loadState = .failed
            selectedLogID = nil
        }
    }

    mutating func selectLog(id: String) {
        guard logs.contains(where: { $0.id == id }) else { return }
        selectedLogID = id
    }

    mutating func selectDetailTab(_ tab: MessageInspectorDetailTab) {
        selectedDetailTab = tab
    }

    mutating func selectRawPane(_ pane: RawPayloadPane) {
        selectedRawPane = pane
    }

    static func ordered(_ logs: [LLMRequestLogEntry]) -> [LLMRequestLogEntry] {
        logs.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt < rhs.createdAt
            }

            return lhs.id < rhs.id
        }
    }
}
