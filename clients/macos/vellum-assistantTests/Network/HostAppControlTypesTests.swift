import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class HostAppControlTypesTests: XCTestCase {

    // MARK: - Helpers

    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - HostAppControlInput round-trip per variant

    func test_input_start_roundTrips() throws {
        let input = HostAppControlInput.start(app: "com.apple.TextEdit", args: ["--new"])
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_start_withoutArgs_roundTrips() throws {
        let input = HostAppControlInput.start(app: "com.apple.TextEdit", args: nil)
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_observe_roundTrips() throws {
        let input = HostAppControlInput.observe(app: "com.apple.Safari")
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_press_roundTrips() throws {
        let input = HostAppControlInput.press(
            app: "com.apple.Safari",
            key: "Return",
            modifiers: ["cmd", "shift"],
            durationMs: 50
        )
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_combo_roundTrips() throws {
        let input = HostAppControlInput.combo(
            app: "com.apple.Safari",
            keys: ["cmd", "t"],
            durationMs: nil
        )
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_type_roundTrips() throws {
        let input = HostAppControlInput.type(app: "com.apple.TextEdit", text: "Hello, world")
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_click_roundTrips() throws {
        let input = HostAppControlInput.click(
            app: "com.apple.Safari",
            x: 120.5,
            y: 240.0,
            button: "left",
            double: false
        )
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_click_minimal_roundTrips() throws {
        let input = HostAppControlInput.click(
            app: "com.apple.Safari",
            x: 0,
            y: 0,
            button: nil,
            double: nil
        )
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_drag_roundTrips() throws {
        let input = HostAppControlInput.drag(
            app: "com.apple.Safari",
            fromX: 10,
            fromY: 20,
            toX: 100,
            toY: 200,
            button: "left"
        )
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_stop_roundTrips() throws {
        let input = HostAppControlInput.stop(app: "com.apple.TextEdit", reason: "user_cancelled")
        XCTAssertEqual(try roundTrip(input), input)
    }

    func test_input_stop_empty_roundTrips() throws {
        let input = HostAppControlInput.stop(app: nil, reason: nil)
        XCTAssertEqual(try roundTrip(input), input)
    }

    // MARK: - HostAppControlInput wire shape

    func test_input_decodes_from_tool_discriminator() throws {
        // Wire format uses snake_case (matches TOOLS.json input schema and the
        // TypeScript HostAppControlPressInput shape). Swift maps to camelCase
        // via explicit CodingKey raw values.
        let json = #"""
        {
          "tool": "press",
          "app": "com.apple.Safari",
          "key": "Return",
          "modifiers": ["cmd"],
          "duration_ms": 100
        }
        """#
        let decoded = try JSONDecoder().decode(HostAppControlInput.self, from: Data(json.utf8))
        guard case .press(let app, let key, let modifiers, let durationMs) = decoded else {
            return XCTFail("Expected .press variant, got \(decoded)")
        }
        XCTAssertEqual(app, "com.apple.Safari")
        XCTAssertEqual(key, "Return")
        XCTAssertEqual(modifiers, ["cmd"])
        XCTAssertEqual(durationMs, 100)
    }

    func test_input_drag_decodes_snake_case_coordinates() throws {
        // Regression guard for the pre-existing CodingKey bug where the
        // snake_case `from_x`/`from_y`/`to_x`/`to_y` wire keys silently
        // failed to decode and drag coordinates fell through to undefined
        // behavior.
        let json = #"""
        {
          "tool": "drag",
          "app": "com.apple.Safari",
          "from_x": 10,
          "from_y": 20,
          "to_x": 100,
          "to_y": 200,
          "button": "left"
        }
        """#
        let decoded = try JSONDecoder().decode(HostAppControlInput.self, from: Data(json.utf8))
        guard case .drag(let app, let fromX, let fromY, let toX, let toY, let button) = decoded else {
            return XCTFail("Expected .drag variant, got \(decoded)")
        }
        XCTAssertEqual(app, "com.apple.Safari")
        XCTAssertEqual(fromX, 10)
        XCTAssertEqual(fromY, 20)
        XCTAssertEqual(toX, 100)
        XCTAssertEqual(toY, 200)
        XCTAssertEqual(button, "left")
    }

    func test_input_unknown_tool_throws() {
        let json = #"{"tool": "teleport", "app": "x"}"#
        XCTAssertThrowsError(
            try JSONDecoder().decode(HostAppControlInput.self, from: Data(json.utf8))
        )
    }

    // MARK: - HostAppControlRequest

    func test_request_roundTrips() throws {
        let request = HostAppControlRequest(
            type: "host_app_control_request",
            requestId: "req-1",
            conversationId: "conv-1",
            input: .click(app: "com.apple.Safari", x: 50, y: 75, button: "left", double: false)
        )
        XCTAssertEqual(try roundTrip(request), request)
    }

    // MARK: - HostAppControlCancel

    func test_cancel_roundTrips() throws {
        let cancel = HostAppControlCancel(
            type: "host_app_control_cancel",
            requestId: "req-1"
        )
        XCTAssertEqual(try roundTrip(cancel), cancel)
    }

    // MARK: - HostAppControlState

    func test_state_decodes_each_case() throws {
        let cases: [(String, HostAppControlState)] = [
            ("\"running\"", .running),
            ("\"missing\"", .missing),
            ("\"minimized\"", .minimized),
        ]
        for (json, expected) in cases {
            let decoded = try JSONDecoder().decode(HostAppControlState.self, from: Data(json.utf8))
            XCTAssertEqual(decoded, expected)
        }
    }

    // MARK: - HostAppControlResultPayload

    func test_resultPayload_full_roundTrips() throws {
        let payload = HostAppControlResultPayload(
            requestId: "req-1",
            state: .running,
            pngBase64: "AAAA",
            windowBounds: WindowBounds(x: 0, y: 0, width: 1024, height: 768),
            executionResult: "ok",
            executionError: nil
        )
        XCTAssertEqual(try roundTrip(payload), payload)
    }

    func test_resultPayload_minimal_roundTrips() throws {
        let payload = HostAppControlResultPayload(requestId: "req-2", state: .missing)
        XCTAssertEqual(try roundTrip(payload), payload)
    }

    // MARK: - WindowBounds

    func test_windowBounds_roundTrips() throws {
        let bounds = WindowBounds(x: 100.5, y: 200.5, width: 800, height: 600)
        XCTAssertEqual(try roundTrip(bounds), bounds)
    }
}
