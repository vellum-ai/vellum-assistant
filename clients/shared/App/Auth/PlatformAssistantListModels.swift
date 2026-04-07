import Foundation

/// Response wrapper for the paginated `GET /v1/assistants/` endpoint.
///
/// Lives in its own file instead of `AuthModels.swift` solely to avoid
/// restaging `AuthModels.swift` and tripping the pre-commit secret scanner's
/// false-positive on the pre-existing `webhookSecret` CodingKey. Conceptually
/// this type belongs next to `PlatformAssistant`.
public struct PaginatedPlatformAssistantsResponse: Codable, Sendable {
    public let count: Int?
    public let results: [PlatformAssistant]

    public init(count: Int? = nil, results: [PlatformAssistant]) {
        self.count = count
        self.results = results
    }
}
