import XCTest

@testable import VellumAssistantShared

@MainActor
final class STTClientTests: XCTestCase {

    // MARK: - 200 Success

    func testMapResponse200ReturnsSuccessWithText() {
        let json = #"{"text":"Hello world"}"#
        let response = GatewayHTTPClient.Response(
            data: json.data(using: .utf8)!,
            statusCode: 200
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .success(text: "Hello world"))
    }

    func testMapResponse200WithEmptyTextReturnsSuccessEmpty() {
        let json = #"{"text":""}"#
        let response = GatewayHTTPClient.Response(
            data: json.data(using: .utf8)!,
            statusCode: 200
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .success(text: ""))
    }

    func testMapResponse200WithMalformedJSONReturnsError() {
        let response = GatewayHTTPClient.Response(
            data: "not json".data(using: .utf8)!,
            statusCode: 200
        )

        let result = STTClient.mapResponse(response)

        if case .error(let statusCode, let message) = result {
            XCTAssertEqual(statusCode, 200)
            XCTAssertTrue(message.contains("decode"), "Expected decode error message, got: \(message)")
        } else {
            XCTFail("Expected .error, got \(result)")
        }
    }

    // MARK: - 400 Bad Request

    func testMapResponse400ReturnsError() {
        let body = "Invalid audio format"
        let response = GatewayHTTPClient.Response(
            data: body.data(using: .utf8)!,
            statusCode: 400
        )

        let result = STTClient.mapResponse(response)

        if case .error(let statusCode, let message) = result {
            XCTAssertEqual(statusCode, 400)
            XCTAssertTrue(message.contains("Bad request"), "Expected 'Bad request' in message, got: \(message)")
        } else {
            XCTFail("Expected .error, got \(result)")
        }
    }

    // MARK: - 503 Not Configured

    func testMapResponse503ReturnsNotConfigured() {
        let response = GatewayHTTPClient.Response(
            data: Data(),
            statusCode: 503
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .notConfigured)
    }

    // MARK: - 5xx Service Unavailable

    func testMapResponse500ReturnsServiceUnavailable() {
        let response = GatewayHTTPClient.Response(
            data: "Internal server error".data(using: .utf8)!,
            statusCode: 500
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .serviceUnavailable)
    }

    func testMapResponse502ReturnsServiceUnavailable() {
        let response = GatewayHTTPClient.Response(
            data: Data(),
            statusCode: 502
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .serviceUnavailable)
    }

    func testMapResponse504ReturnsServiceUnavailable() {
        let response = GatewayHTTPClient.Response(
            data: Data(),
            statusCode: 504
        )

        let result = STTClient.mapResponse(response)

        XCTAssertEqual(result, .serviceUnavailable)
    }

    // MARK: - Other Status Codes

    func testMapResponse404ReturnsGenericError() {
        let response = GatewayHTTPClient.Response(
            data: "Not found".data(using: .utf8)!,
            statusCode: 404
        )

        let result = STTClient.mapResponse(response)

        if case .error(let statusCode, _) = result {
            XCTAssertEqual(statusCode, 404)
        } else {
            XCTFail("Expected .error, got \(result)")
        }
    }

    func testMapResponse429ReturnsGenericError() {
        let response = GatewayHTTPClient.Response(
            data: "Rate limited".data(using: .utf8)!,
            statusCode: 429
        )

        let result = STTClient.mapResponse(response)

        if case .error(let statusCode, _) = result {
            XCTAssertEqual(statusCode, 429)
        } else {
            XCTFail("Expected .error, got \(result)")
        }
    }
}
