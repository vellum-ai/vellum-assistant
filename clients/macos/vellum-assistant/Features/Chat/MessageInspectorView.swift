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
    private let inspectorPaneMinHeight: CGFloat = 420
    private let inspectorPaneChromeHeight: CGFloat = 44

    @State private var response: LLMContextResponse?
    @State private var isLoading = true
    @State private var expandedLogIds: Set<String> = []
    /// Pre-formatted JSON strings keyed by "\(entryId)-request" / "\(entryId)-response".
    @State private var formattedJSON: [String: String] = [:]

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
            formattedJSON = [:]
            expandedLogIds = []

            let result = await llmContextClient.fetchContext(messageId: messageId)
            response = result
            // Pre-format JSON strings outside the render path
            if let logs = result?.logs {
                var formatted: [String: String] = [:]
                for entry in logs {
                    formatted["\(entry.id)-request"] = prettyPrintJSON(entry.requestPayload)
                    formatted["\(entry.id)-response"] = prettyPrintJSON(entry.responsePayload)
                }
                formattedJSON = formatted
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

                Text(shortMessageId)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.contentTertiary)
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
                GeometryReader { proxy in
                    // Constrain both panes to the visible row width so very wide
                    // request JSON cannot push the sibling response pane offscreen.
                    let columnWidth = max((proxy.size.width - VSpacing.lg) / 2, 0)

                    HStack(alignment: .top, spacing: VSpacing.lg) {
                        jsonSection(
                            title: "Request",
                            formattedText: formattedJSON["\(entry.id)-request"] ?? ""
                        )
                        .frame(width: columnWidth, alignment: .topLeading)

                        jsonSection(
                            title: "Response",
                            formattedText: formattedJSON["\(entry.id)-response"] ?? ""
                        )
                        .frame(width: columnWidth, alignment: .topLeading)
                    }
                    .frame(width: proxy.size.width, alignment: .leading)
                }
                .frame(
                    minHeight: inspectorPaneMinHeight + inspectorPaneChromeHeight,
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

    // MARK: - JSON Section

    private func jsonSection(title: String, formattedText: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                Button(action: {
                    copyToClipboard(formattedText)
                }) {
                    HStack(spacing: VSpacing.xxs) {
                        VIconView(.copy, size: 10)
                        Text("Copy \(title)")
                            .font(VFont.small)
                    }
                    .foregroundColor(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy \(title)")
            }

            ScrollView([.horizontal, .vertical]) {
                Text(verbatim: formattedText)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(
                maxWidth: .infinity,
                minHeight: inspectorPaneMinHeight,
                alignment: .topLeading
            )
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - Helpers

    private var shortMessageId: String {
        if messageId.count > 12 {
            return String(messageId.prefix(12)) + "..."
        }
        return messageId
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

    private func prettyPrintJSON(_ value: AnyCodable) -> String {
        guard let rawValue = value.value else { return "null" }
        guard JSONSerialization.isValidJSONObject(wrapForSerialization(rawValue)) else {
            return String(describing: rawValue)
        }
        do {
            let data = try JSONSerialization.data(
                withJSONObject: wrapForSerialization(rawValue),
                options: [.prettyPrinted, .sortedKeys]
            )
            return String(data: data, encoding: .utf8) ?? String(describing: rawValue)
        } catch {
            return String(describing: rawValue)
        }
    }

    /// Wraps AnyCodable-decoded values so JSONSerialization accepts them.
    /// AnyCodable decodes arrays as `[Any?]` and dicts as `[String: Any?]`;
    /// JSONSerialization requires non-optional element types.
    private func wrapForSerialization(_ value: Any) -> Any {
        if let dict = value as? [String: Any?] {
            return dict.reduce(into: [String: Any]()) { result, pair in
                result[pair.key] = pair.value.map { wrapForSerialization($0) } ?? NSNull()
            }
        }
        if let array = value as? [Any?] {
            return array.map { $0.map { wrapForSerialization($0) } ?? NSNull() }
        }
        return value
    }

    private func formattedTimestamp(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    private func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
