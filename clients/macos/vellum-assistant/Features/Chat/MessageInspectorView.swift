import SwiftUI
import VellumAssistantShared

/// Displays the raw LLM request/response payloads for a given message.
///
/// Shows a skeleton placeholder while fetching, an empty-state message when no
/// logs are available, and collapsible sections for each LLM call with
/// side-by-side request and response payloads.
struct MessageInspectorView: View {
    let messageId: String
    let onBack: () -> Void

    private let llmContextClient: any LLMContextClientProtocol = LLMContextClient()
    private let payloadViewportHeight: CGFloat = 560
    private let payloadSectionChromeHeight: CGFloat = 44

    @State private var response: LLMContextResponse?
    @State private var isLoading = true
    @State private var expandedLogIds: Set<String> = []
    @State private var payloadModels: [String: MessageInspectorPayloadModel] = [:]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
        .task(id: messageId) {
            isLoading = true
            response = nil
            payloadModels = [:]
            expandedLogIds = []

            let result = await llmContextClient.fetchContext(messageId: messageId)
            response = result
            // Prepare payload view state outside the render path.
            if let logs = result?.logs {
                var nextPayloadModels: [String: MessageInspectorPayloadModel] = [:]
                for entry in logs {
                    nextPayloadModels["\(entry.id)-request"] = MessageInspectorPayloadModel(
                        payload: entry.requestPayload
                    )
                    nextPayloadModels["\(entry.id)-response"] = MessageInspectorPayloadModel(
                        payload: entry.responsePayload
                    )
                }
                payloadModels = nextPayloadModels
                // Auto-expand all entries on load
                expandedLogIds = Set(logs.map(\.id))
            }
            isLoading = false
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            Button(action: onBack) {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.chevronLeft, size: 12)
                    Text("Back")
                        .font(VFont.bodyMedium)
                }
                .foregroundColor(VColor.contentDefault)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(VColor.surfaceOverlay)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to conversation")

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("LLM Context Inspector")
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)

                Text("Request on the left, response on the right.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: VSpacing.xxs) {
                if !isLoading, let logCount = response?.logs.count {
                    Text(logCount == 1 ? "1 LLM call" : "\(logCount) LLM calls")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }

                Text(messageId)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.contentTertiary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.surfaceBase)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if isLoading {
            loadingState
        } else if let logs = response?.logs, !logs.isEmpty {
            populatedState(logs: logs)
        } else {
            emptyState
        }
    }

    /// Skeleton placeholder that mirrors the populated layout (collapsible log
    /// entry cards) so the transition to real content feels seamless.
    private var loadingState: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: VSpacing.sm) {
                        VSkeletonBone(width: 10, height: 10, radius: 2)
                        VSkeletonBone(width: 120, height: 14)
                        Spacer()
                        VSkeletonBone(width: 70, height: 12)
                    }
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(VColor.surfaceOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                    HStack(alignment: .top, spacing: VSpacing.lg) {
                        skeletonColumn
                        skeletonColumn
                    }
                    .padding(VSpacing.md)
                    .background(VColor.surfaceOverlay.opacity(0.5))
                    .clipShape(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 0,
                            bottomLeadingRadius: VRadius.md,
                            bottomTrailingRadius: VRadius.md,
                            topTrailingRadius: 0
                        )
                    )
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyState: some View {
        VStack {
            Spacer()
            Text("No LLM context available for this message.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func populatedState(logs: [LLMRequestLogEntry]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                ForEach(Array(logs.enumerated()), id: \.element.id) { index, entry in
                    logEntrySection(entry: entry, index: index, total: logs.count)
                }
            }
            .padding(VSpacing.lg)
        }
    }

    // MARK: - Log Entry Section

    private func logEntrySection(entry: LLMRequestLogEntry, index: Int, total: Int) -> some View {
        let isExpanded = expandedLogIds.contains(entry.id)

        return VStack(alignment: .leading, spacing: 0) {
            // Collapsible header
            Button(action: {
                withAnimation(VAnimation.fast) {
                    if isExpanded {
                        expandedLogIds.remove(entry.id)
                    } else {
                        expandedLogIds.insert(entry.id)
                    }
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(isExpanded ? .chevronUp : .chevronDown, size: 10)
                        .foregroundColor(VColor.contentTertiary)

                    Text("LLM Call \(index + 1) of \(total)")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)

                    Spacer()

                    Text(formattedTimestamp(entry.createdAt))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(VColor.surfaceOverlay)
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: VRadius.md,
                    bottomLeadingRadius: isExpanded ? 0 : VRadius.md,
                    bottomTrailingRadius: isExpanded ? 0 : VRadius.md,
                    topTrailingRadius: VRadius.md
                )
            )

            if isExpanded {
                HStack(alignment: .top, spacing: VSpacing.lg) {
                    payloadSection(
                        title: "Request",
                        key: "\(entry.id)-request"
                    )

                    payloadSection(
                        title: "Response",
                        key: "\(entry.id)-response"
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(
                    minHeight: payloadViewportHeight + payloadSectionChromeHeight,
                    alignment: .topLeading
                )
                .padding(VSpacing.md)
                .background(VColor.surfaceOverlay.opacity(0.5))
                .clipShape(
                    UnevenRoundedRectangle(
                        topLeadingRadius: 0,
                        bottomLeadingRadius: VRadius.md,
                        bottomTrailingRadius: VRadius.md,
                        topTrailingRadius: 0
                    )
                )
            }
        }
    }

    // MARK: - Payload Section

    private func payloadSection(title: String, key: String) -> some View {
        MessageInspectorPayloadView(
            title: title,
            model: payloadBinding(for: key),
            viewportHeight: payloadViewportHeight
        )
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - Helpers

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

    private var skeletonColumn: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                VSkeletonBone(width: 80, height: 12)
                Spacer()
                VSkeletonBone(width: 90, height: 12)
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
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func formattedTimestamp(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
