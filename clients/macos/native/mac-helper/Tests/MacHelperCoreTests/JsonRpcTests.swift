import Foundation
import Testing

@testable import MacHelperCore

private func parseObject(_ line: String) throws -> [String: Any] {
    let data = Data(line.utf8)
    let raw = try JSONSerialization.jsonObject(with: data)
    return try #require(raw as? [String: Any])
}

private func number(_ value: Any?) -> Int? {
    (value as? NSNumber)?.intValue
}

@Test func routerDispatchesPing() throws {
    let router = JsonRpcRouter()
    router.register("ping") { _ in "pong" }

    let line = router.handle(
        line: #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#
    )

    let object = try parseObject(line)
    #expect(object["jsonrpc"] as? String == "2.0")
    #expect(number(object["id"]) == 1)
    #expect(object["result"] as? String == "pong")
}

@Test func routerReturnsStandardParseError() throws {
    let router = JsonRpcRouter()

    let object = try parseObject(router.handle(line: "{nope"))
    let error = try #require(object["error"] as? [String: Any])

    #expect(object["id"] is NSNull)
    #expect(number(error["code"]) == JsonRpcErrorCode.parseError)
}

@Test func routerReturnsMethodNotFound() throws {
    let router = JsonRpcRouter()

    let object = try parseObject(
        router.handle(line: #"{"jsonrpc":"2.0","id":"abc","method":"missing"}"#)
    )
    let error = try #require(object["error"] as? [String: Any])

    #expect(object["id"] as? String == "abc")
    #expect(number(error["code"]) == JsonRpcErrorCode.methodNotFound)
}

@Test func routerMapsInvalidParams() throws {
    let router = JsonRpcRouter()
    router.register("needs.params") { _ in
        throw JsonRpcDispatchError.invalidParams("params were wrong")
    }

    let object = try parseObject(
        router.handle(line: #"{"jsonrpc":"2.0","id":2,"method":"needs.params"}"#)
    )
    let error = try #require(object["error"] as? [String: Any])

    #expect(number(error["code"]) == JsonRpcErrorCode.invalidParams)
    #expect(error["message"] as? String == "params were wrong")
}

@Test func codecEscapesNewlinesForNdjsonFrames() throws {
    let line = try JsonRpcCodec.encodeLine(
        JsonRpcCodec.successResponse(id: 7, result: ["text": "hello\nworld"])
    )

    #expect(!line.contains("\n"))
    #expect(line.contains(#"\n"#))
}

@Test func codecBuildsNotificationsWithoutIds() throws {
    let line = try JsonRpcCodec.encodeLine(
        JsonRpcCodec.notification(
            method: "hotkey.event",
            params: ["kind": "fnPushToTalk", "state": "down"]
        )
    )

    let object = try parseObject(line)
    #expect(object["jsonrpc"] as? String == "2.0")
    #expect(object["method"] as? String == "hotkey.event")
    #expect(object["id"] == nil)
}
