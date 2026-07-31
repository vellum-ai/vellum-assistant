import CoreFoundation
import Foundation

public enum JsonRpcErrorCode {
    public static let parseError = -32700
    public static let invalidRequest = -32600
    public static let methodNotFound = -32601
    public static let invalidParams = -32602
    public static let internalError = -32603
}

public enum JsonRpcDispatchError: Error, Equatable {
    case invalidParams(String)
    case internalError(String)
}

public enum JsonRpcCodecError: Error {
    case invalidJSONObject
    case invalidUTF8
    case rawNewlineEncoded
}

public enum JsonRpcCodec {
    public static func encodeLine(_ object: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw JsonRpcCodecError.invalidJSONObject
        }

        let data = try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        )
        guard let line = String(data: data, encoding: .utf8) else {
            throw JsonRpcCodecError.invalidUTF8
        }
        guard !line.contains("\n"), !line.contains("\r") else {
            throw JsonRpcCodecError.rawNewlineEncoded
        }
        return line
    }

    public static func successResponse(id: Any, result: Any?) -> [String: Any] {
        [
            "jsonrpc": "2.0",
            "id": id,
            "result": result ?? NSNull(),
        ]
    }

    public static func errorResponse(
        id: Any?,
        code: Int,
        message: String,
        data: Any? = nil
    ) -> [String: Any] {
        var error: [String: Any] = [
            "code": code,
            "message": message,
        ]
        if let data {
            error["data"] = data
        }

        return [
            "jsonrpc": "2.0",
            "id": id ?? NSNull(),
            "error": error,
        ]
    }

    public static func notification(
        method: String,
        params: Any? = nil
    ) -> [String: Any] {
        var object: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
        ]
        if let params {
            object["params"] = params
        }
        return object
    }
}

public final class JsonRpcRouter {
    public typealias Handler = (Any?) throws -> Any?

    private var handlers: [String: Handler] = [:]

    public init() {}

    public func register(_ method: String, handler: @escaping Handler) {
        handlers[method] = handler
    }

    public func handle(line: String) -> String {
        let response = responseObject(for: line)
        return (try? JsonRpcCodec.encodeLine(response)) ?? fallbackInternalError
    }

    private func responseObject(for line: String) -> [String: Any] {
        let raw: Any
        do {
            guard let data = line.data(using: .utf8) else {
                return JsonRpcCodec.errorResponse(
                    id: nil,
                    code: JsonRpcErrorCode.parseError,
                    message: "Parse error"
                )
            }
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            return JsonRpcCodec.errorResponse(
                id: nil,
                code: JsonRpcErrorCode.parseError,
                message: "Parse error"
            )
        }

        guard let object = raw as? [String: Any] else {
            return JsonRpcCodec.errorResponse(
                id: nil,
                code: JsonRpcErrorCode.invalidRequest,
                message: "Invalid request"
            )
        }

        let id = normalizedId(object["id"])
        guard id.isValid else {
            return JsonRpcCodec.errorResponse(
                id: nil,
                code: JsonRpcErrorCode.invalidRequest,
                message: "Invalid request"
            )
        }

        guard
            object["jsonrpc"] as? String == "2.0",
            let method = object["method"] as? String,
            !method.isEmpty
        else {
            return JsonRpcCodec.errorResponse(
                id: id.value,
                code: JsonRpcErrorCode.invalidRequest,
                message: "Invalid request"
            )
        }

        guard let handler = handlers[method] else {
            return JsonRpcCodec.errorResponse(
                id: id.value,
                code: JsonRpcErrorCode.methodNotFound,
                message: "Method not found"
            )
        }

        do {
            let result = try handler(object["params"])
            return JsonRpcCodec.successResponse(id: id.value, result: result)
        } catch let error as JsonRpcDispatchError {
            switch error {
            case let .invalidParams(message):
                return JsonRpcCodec.errorResponse(
                    id: id.value,
                    code: JsonRpcErrorCode.invalidParams,
                    message: message
                )
            case let .internalError(message):
                return JsonRpcCodec.errorResponse(
                    id: id.value,
                    code: JsonRpcErrorCode.internalError,
                    message: message
                )
            }
        } catch {
            return JsonRpcCodec.errorResponse(
                id: id.value,
                code: JsonRpcErrorCode.internalError,
                message: error.localizedDescription
            )
        }
    }

    private var fallbackInternalError: String {
        #"{"error":{"code":-32603,"message":"Internal error"},"id":null,"jsonrpc":"2.0"}"#
    }
}

private struct NormalizedId {
    let value: Any
    let isValid: Bool
}

private func normalizedId(_ raw: Any?) -> NormalizedId {
    guard let raw else {
        return NormalizedId(value: NSNull(), isValid: true)
    }

    if raw is NSNull {
        return NormalizedId(value: NSNull(), isValid: true)
    }

    if let string = raw as? String {
        return NormalizedId(value: string, isValid: true)
    }

    if let number = raw as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return NormalizedId(value: NSNull(), isValid: false)
        }
        let double = number.doubleValue
        guard double.rounded() == double else {
            return NormalizedId(value: NSNull(), isValid: false)
        }
        return NormalizedId(value: number.intValue, isValid: true)
    }

    return NormalizedId(value: NSNull(), isValid: false)
}
