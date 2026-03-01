import Foundation

// MARK: - Request Types

struct MessagesRequest: Encodable {
    let model: String
    let max_tokens: Int
    let system: String
    let tools: [ToolDefinition]
    let messages: [Message]
}

struct ToolDefinition: Encodable {
    let name: String
    let description: String
    let input_schema: JSONValue
}

struct Message: Encodable {
    let role: String
    let content: [ContentBlock]
}

enum ContentBlock: Encodable {
    case text(String)
    case toolUse(id: String, name: String, input: [String: JSONValue])
    case toolResult(toolUseId: String, content: [ToolResultContent], isError: Bool)

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text):
            try container.encode(TextBlock(type: "text", text: text))
        case .toolUse(let id, let name, let input):
            try container.encode(ToolUseBlock(type: "tool_use", id: id, name: name, input: input))
        case .toolResult(let toolUseId, let content, let isError):
            try container.encode(ToolResultBlock(type: "tool_result", tool_use_id: toolUseId, content: content, is_error: isError))
        }
    }
}

struct TextBlock: Encodable {
    let type: String
    let text: String
}

struct ToolUseBlock: Encodable {
    let type: String
    let id: String
    let name: String
    let input: [String: JSONValue]
}

struct ToolResultBlock: Encodable {
    let type: String
    let tool_use_id: String
    let content: [ToolResultContent]
    let is_error: Bool
}

enum ToolResultContent: Encodable {
    case text(String)
    case image(source: ImageSource)

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text):
            try container.encode(["type": "text", "text": text])
        case .image(let source):
            try container.encode(ImageContentBlock(type: "image", source: source))
        }
    }
}

struct ImageContentBlock: Encodable {
    let type: String
    let source: ImageSource
}

struct ImageSource: Encodable {
    let type: String
    let media_type: String
    let data: String
}

// MARK: - Response Types

struct MessagesResponse: Decodable {
    let id: String
    let content: [ResponseContentBlock]
    let stop_reason: String?
    let usage: Usage?
}

struct Usage: Decodable {
    let input_tokens: Int?
    let output_tokens: Int?
}

enum ResponseContentBlock: Decodable {
    case text(id: String?, text: String)
    case toolUse(id: String, name: String, input: [String: JSONValue])

    enum CodingKeys: String, CodingKey {
        case type, id, text, name, input
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "text":
            let id = try container.decodeIfPresent(String.self, forKey: .id)
            let text = try container.decode(String.self, forKey: .text)
            self = .text(id: id, text: text)
        case "tool_use":
            let id = try container.decode(String.self, forKey: .id)
            let name = try container.decode(String.self, forKey: .name)
            let input = try container.decode([String: JSONValue].self, forKey: .input)
            self = .toolUse(id: id, name: name, input: input)
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown content type: \(type)")
        }
    }
}

// MARK: - JSON Value (dynamic JSON)

enum JSONValue: Codable, CustomStringConvertible {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    var description: String {
        switch self {
        case .string(let s): return "\"\(s)\""
        case .int(let i): return "\(i)"
        case .double(let d): return "\(d)"
        case .bool(let b): return "\(b)"
        case .object(let o): return "\(o)"
        case .array(let a): return "\(a)"
        case .null: return "null"
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int? {
        switch self {
        case .int(let i): return i
        case .double(let d): return Int(d)
        default: return nil
        }
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Cannot decode JSONValue")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }
}

// MARK: - Anthropic Client

final class AnthropicClient {
    private let apiKey: String
    private let baseURL = "https://api.anthropic.com/v1/messages"
    private let session: URLSession

    static let maxRetries = 5
    static let initialRetryDelayMs = 5000

    init(apiKey: String) {
        self.apiKey = apiKey
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: config)
    }

    func createMessage(request: MessagesRequest, verbose: Bool = false) async throws -> MessagesResponse {
        var lastError: Error?

        for retry in 0...Self.maxRetries {
            do {
                return try await sendRequest(request)
            } catch let error as APIError {
                lastError = error
                let isRetryable = error.statusCode == 429 || error.statusCode == 529 || error.statusCode == 503
                if !isRetryable || retry >= Self.maxRetries {
                    throw error
                }
                let delay = Self.initialRetryDelayMs * (1 << retry) // exponential backoff
                if verbose {
                    print("  [api] HTTP \(error.statusCode) — retrying in \(delay / 1000)s (attempt \(retry + 1)/\(Self.maxRetries))")
                }
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            } catch {
                lastError = error
                if retry >= Self.maxRetries {
                    throw error
                }
                let delay = Self.initialRetryDelayMs * (1 << retry)
                if verbose {
                    print("  [api] Error: \(error.localizedDescription) — retrying in \(delay / 1000)s")
                }
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            }
        }

        throw lastError ?? APIError(statusCode: 0, message: "Unknown error")
    }

    private func sendRequest(_ request: MessagesRequest) async throws -> MessagesResponse {
        var urlRequest = URLRequest(url: URL(string: baseURL)!)
        urlRequest.httpMethod = "POST"
        urlRequest.addValue(apiKey, forHTTPHeaderField: "x-api-key")
        urlRequest.addValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.addValue("application/json", forHTTPHeaderField: "content-type")

        let encoder = JSONEncoder()
        urlRequest.httpBody = try encoder.encode(request)

        let (data, response) = try await session.data(for: urlRequest)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError(statusCode: 0, message: "Invalid response type")
        }

        guard httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "No response body"
            throw APIError(statusCode: httpResponse.statusCode, message: body)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(MessagesResponse.self, from: data)
    }
}

struct APIError: LocalizedError {
    let statusCode: Int
    let message: String

    var errorDescription: String? {
        "API error \(statusCode): \(message)"
    }
}
