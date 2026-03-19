import Foundation
import SwiftUI
import VellumAssistantShared

struct MessageInspectorResponseTab: View {
    let entry: LLMRequestLogEntry

    private var model: MessageInspectorResponseTabModel {
        MessageInspectorResponseTabModel(entry: entry)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if model.hasNormalizedSections {
                    responseMetadataCard(showResponseMode: true)

                    ForEach(model.sections) { section in
                        responseSectionCard(for: section)
                    }
                } else {
                    if model.stopReason != nil {
                        responseMetadataCard(showResponseMode: false)
                    }

                    fallbackCard
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private func responseMetadataCard(showResponseMode: Bool) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Response metadata")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                HStack(alignment: .top, spacing: VSpacing.xs) {
                    if showResponseMode {
                        metadataChip(model.responseModeLabel)
                    }

                    if let stopReason = model.stopReason {
                        metadataChip("Stop reason: \(stopReason)")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func responseSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        switch section.presentationKind {
        case .assistantText:
            textSectionCard(for: section)
        case .toolCall:
            toolCallSectionCard(for: section)
        case .other:
            otherSectionCard(for: section)
        }
    }

    private func textSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let body = section.bodyText, !body.isEmpty {
                    Text(body)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    Text("No assistant text was captured for this section.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
    }

    private func toolCallSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let toolName = section.toolName {
                    metadataChip("Tool: \(toolName)")
                }

                if let body = section.bodyText, !body.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Arguments preview")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)

                        Text(body)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentDefault)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("No structured arguments preview is available for this tool call.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }

                VInlineMessage(
                    "Need the full provider payload? Open the Raw tab for request and response JSON.",
                    tone: .info
                )
            }
        }
    }

    private func otherSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let body = section.bodyText, !body.isEmpty {
                    Text(body)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    Text("This normalized section does not currently map to a dedicated response card.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
    }

    private var fallbackCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(alignment: .center, spacing: VSpacing.xs) {
                    VIconView(.fileCode, size: 14)
                        .foregroundColor(VColor.contentTertiary)

                    Text("No normalized response sections")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                }

                Text(
                    model.fallbackMessage
                    ?? "This provider response has not been normalized yet. Open the Raw tab to inspect the full provider payload."
                )
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func sectionHeader(
        title: String,
        kindLabel: String,
        copyText: String
    ) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                metadataChip(kindLabel)
            }

            Spacer(minLength: VSpacing.md)

            VCopyButton(
                text: copyText,
                size: .compact,
                accessibilityHint: "Copy section content"
            )
        }
    }

    private func metadataChip(_ label: String) -> some View {
        Text(label)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}

struct MessageInspectorResponseTabModel: Equatable {
    let sections: [MessageInspectorResponseSectionModel]
    let responseModeLabel: String
    let stopReason: String?
    let fallbackMessage: String?

    init(entry: LLMRequestLogEntry) {
        let responseSections = entry.responseSections ?? []
        let toolNames = Self.extractResponseToolNames(from: entry.responsePayload)
        let stopReason = Self.extractStopReason(from: entry.responsePayload)

        sections = responseSections.enumerated().map { index, section in
            MessageInspectorResponseSectionModel(
                index: index,
                section: section,
                toolName: toolNames[safe: index]
            )
        }

        self.stopReason = stopReason
        responseModeLabel = sections.contains(where: { $0.isToolCallLike })
            ? "Tool-calling response"
            : "Text-only response"
        fallbackMessage = sections.isEmpty
            ? "This provider response has not been normalized yet. Open the Raw tab to inspect the full provider payload."
            : nil
    }

    var hasNormalizedSections: Bool {
        !sections.isEmpty
    }

    private static func extractStopReason(from payload: AnyCodable) -> String? {
        guard let root = payload.value else { return nil }

        if let records = jsonRecords(from: root) {
            if let reason = stopReason(in: records) {
                return reason
            }
        }

        return nil
    }

    private static func extractResponseToolNames(from payload: AnyCodable) -> [String] {
        guard let root = payload.value else { return [] }
        guard let records = jsonRecords(from: root) else { return [] }

        if let openAiChoices = records["choices"] as? [Any] {
            return openAiChoices.compactMap { choice in
                guard let choiceRecord = choice as? [String: Any] else { return nil }
                let message = choiceRecord["message"] as? [String: Any]
                let toolCalls = message?["tool_calls"] as? [Any]
                return toolCalls?.compactMap { toolCall in
                    guard
                        let toolCallRecord = toolCall as? [String: Any],
                        let function = toolCallRecord["function"] as? [String: Any],
                        let toolName = function["name"] as? String,
                        !toolName.isEmpty
                    else {
                        return nil
                    }
                    return toolName
                } ?? []
            }
            .flatMap { $0 }
        }

        if let content = records["content"] as? [Any] {
            return content.compactMap { block in
                guard
                    let blockRecord = block as? [String: Any],
                    let type = blockRecord["type"] as? String,
                    type == "tool_use",
                    let toolName = blockRecord["name"] as? String,
                    !toolName.isEmpty
                else {
                    return nil
                }
                return toolName
            }
        }

        if let functionCalls = records["functionCalls"] as? [Any] {
            return functionCalls.compactMap { call in
                guard
                    let callRecord = call as? [String: Any],
                    let toolName = callRecord["name"] as? String,
                    !toolName.isEmpty
                else {
                    return nil
                }
                return toolName
            }
        }

        if let candidates = records["candidates"] as? [Any] {
            return candidates.compactMap { candidate in
                guard let candidateRecord = candidate as? [String: Any] else { return nil }
                if let functionCalls = candidateRecord["functionCalls"] as? [Any] {
                    return functionCalls.compactMap { call in
                        guard
                            let callRecord = call as? [String: Any],
                            let toolName = callRecord["name"] as? String,
                            !toolName.isEmpty
                        else {
                            return nil
                        }
                        return toolName
                    }
                    .first
                }
                return nil
            }
            .compactMap { $0 }
        }

        return []
    }

    private static func stopReason(in record: [String: Any]) -> String? {
        if let finishReason = record["finishReason"] as? String, !finishReason.isEmpty {
            return finishReason
        }

        if let stopReason = record["stop_reason"] as? String, !stopReason.isEmpty {
            return stopReason
        }

        if let choices = record["choices"] as? [Any] {
            for choice in choices {
                guard let choiceRecord = choice as? [String: Any] else { continue }
                if let finishReason = choiceRecord["finish_reason"] as? String, !finishReason.isEmpty {
                    return finishReason
                }
                if let finishReason = choiceRecord["finishReason"] as? String, !finishReason.isEmpty {
                    return finishReason
                }
            }
        }

        if let candidates = record["candidates"] as? [Any] {
            for candidate in candidates {
                guard let candidateRecord = candidate as? [String: Any] else { continue }
                if let finishReason = candidateRecord["finishReason"] as? String, !finishReason.isEmpty {
                    return finishReason
                }
            }
        }

        return nil
    }

    private static func jsonRecords(from root: Any) -> [String: Any]? {
        root as? [String: Any]
    }
}

struct MessageInspectorResponseSectionModel: Identifiable, Equatable {
    enum PresentationKind: Equatable {
        case assistantText
        case toolCall
        case other
    }

    let id: Int
    let title: String
    let kindLabel: String
    let bodyText: String?
    let toolName: String?
    let copyText: String
    let presentationKind: PresentationKind
    let isToolCallLike: Bool

    init(index: Int, section: LLMContextSection, toolName: String?) {
        id = index
        self.toolName = toolName

        let rawKind = section.kind.rawValue.lowercased()
        let displayTitle = section.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackTitle = "Section \(index + 1)"
        title = displayTitle?.isEmpty == false ? displayTitle! : fallbackTitle

        switch rawKind {
        case "tool", "tool_use", "function_call":
            presentationKind = .toolCall
            isToolCallLike = true
            kindLabel = "Tool call"
            let preview = Self.previewText(for: section.content)
            bodyText = preview
            let copySource = preview ?? section.stringContent ?? title
            copyText = copySource
        case "tool_result":
            presentationKind = .other
            isToolCallLike = true
            kindLabel = "Tool result"
            let preview = Self.previewText(for: section.content)
            bodyText = preview
            copyText = preview ?? section.stringContent ?? title
        case "assistant", "message", "text", "output", "completion", "reasoning", "markdown", "code", "json":
            presentationKind = .assistantText
            isToolCallLike = false
            kindLabel = "Assistant text"
            bodyText = section.stringContent ?? Self.previewText(for: section.content)
            copyText = bodyText ?? title
        default:
            presentationKind = section.stringContent == nil ? .other : .assistantText
            isToolCallLike = false
            kindLabel = section.kind.rawValue
            bodyText = section.stringContent ?? Self.previewText(for: section.content)
            copyText = bodyText ?? title
        }
    }

    var showsRawPayloadHint: Bool {
        presentationKind == .toolCall
    }

    private static func previewText(for content: AnyCodable?) -> String? {
        guard let value = content?.value else { return nil }

        if let string = value as? String {
            return string
        }

        if let jsonValue = jsonCompatibleValue(value),
           JSONSerialization.isValidJSONObject(jsonValue),
           let data = try? JSONSerialization.data(withJSONObject: jsonValue, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }

        return String(describing: value)
    }

    private static func jsonCompatibleValue(_ value: Any?) -> Any? {
        guard let value else { return nil }

        if value is NSNull || value is String || value is Bool || value is Int || value is Double {
            return value
        }

        if let dictionary = value as? [String: Any] {
            return dictionary.mapValues { jsonCompatibleValue($0) ?? NSNull() }
        }

        if let array = value as? [Any] {
            return array.map { jsonCompatibleValue($0) ?? NSNull() }
        }

        return nil
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
