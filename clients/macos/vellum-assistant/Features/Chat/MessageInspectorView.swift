import SwiftUI
import VellumAssistantShared

/// Displays the raw LLM request/response payloads for a given message.
///
/// Shows a skeleton placeholder while fetching, an empty-state message when no
/// logs are available, and collapsible sections for each LLM call with
/// pretty-printed JSON and copy-to-clipboard buttons.
struct MessageInspectorView: View {
    let messageId: String

    private let llmContextClient: any LLMContextClientProtocol = LLMContextClient()

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
        .frame(minWidth: 600, idealWidth: 800, minHeight: 400, idealHeight: 600)
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
        HStack {
            Text("LLM Context Inspector")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)
            Spacer()
            Text(messageId.prefix(12) + "...")
                .font(VFont.mono)
                .foregroundColor(VColor.contentTertiary)
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
                    // Simulated header row
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

                    // Simulated JSON content area
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        VSkeletonBone(height: 12)
                            .frame(maxWidth: .infinity)
                        VSkeletonBone(height: 12)
                            .frame(maxWidth: .infinity * 0.85)
                        VSkeletonBone(width: 200, height: 12)
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
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    jsonSection(
                        title: "Request",
                        formattedText: formattedJSON["\(entry.id)-request"] ?? ""
                    )
                    jsonSection(
                        title: "Response",
                        formattedText: formattedJSON["\(entry.id)-response"] ?? ""
                    )
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

    // MARK: - JSON Section

    private func jsonSection(title: String, formattedText: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text(title)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)

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
            }

            ScrollView([.horizontal, .vertical]) {
                Text(formattedText)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 300)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
        }
    }

    // MARK: - Helpers

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
