import Foundation
import VellumAssistantShared

/// Extracts surface_id and title from a document_create tool call result.
/// Pulled out of ChatBubble so the logic is testable.
enum DocumentResultParser {

    struct Result {
        let surfaceId: String?
        let title: String
    }

    static func parse(from toolCall: ToolCallData) -> Result {
        if let result = toolCall.result,
           let data = result.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let surfaceId = json["surface_id"] as? String
            let title = json["title"] as? String ?? titleFromSummary(toolCall.inputSummary)
            return Result(surfaceId: surfaceId, title: title)
        }
        return Result(surfaceId: nil, title: titleFromSummary(toolCall.inputSummary))
    }

    static func titleFromSummary(_ summary: String) -> String {
        if let colonIndex = summary.firstIndex(of: ":") {
            let afterColon = summary[summary.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
            if !afterColon.isEmpty {
                return String(afterColon)
            }
        }
        return "Untitled Document"
    }
}
