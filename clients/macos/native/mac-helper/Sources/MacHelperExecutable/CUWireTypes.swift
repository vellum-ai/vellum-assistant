import Foundation
import MacHelperCore

// Helper-local recreations of the daemon wire types for computer-use and
// app-control results. Field names/shapes mirror the shared MessageTypes.

// MARK: - Computer Use

struct HostCuResultPayload {
    let requestId: String
    var axTree: String?
    var axDiff: String?
    var screenshot: String?
    var screenshotWidthPx: Int?
    var screenshotHeightPx: Int?
    var screenWidthPt: Int?
    var screenHeightPt: Int?
    var executionResult: String?
    var executionError: String?
    var secondaryWindows: String?

    init(
        requestId: String,
        axTree: String? = nil,
        axDiff: String? = nil,
        screenshot: String? = nil,
        screenshotWidthPx: Int? = nil,
        screenshotHeightPx: Int? = nil,
        screenWidthPt: Int? = nil,
        screenHeightPt: Int? = nil,
        executionResult: String? = nil,
        executionError: String? = nil,
        secondaryWindows: String? = nil
    ) {
        self.requestId = requestId
        self.axTree = axTree
        self.axDiff = axDiff
        self.screenshot = screenshot
        self.screenshotWidthPx = screenshotWidthPx
        self.screenshotHeightPx = screenshotHeightPx
        self.screenWidthPt = screenWidthPt
        self.screenHeightPt = screenHeightPt
        self.executionResult = executionResult
        self.executionError = executionError
        self.secondaryWindows = secondaryWindows
    }

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = ["requestId": requestId]
        if let axTree { dict["axTree"] = axTree }
        if let axDiff { dict["axDiff"] = axDiff }
        if let screenshot { dict["screenshot"] = screenshot }
        if let screenshotWidthPx { dict["screenshotWidthPx"] = screenshotWidthPx }
        if let screenshotHeightPx { dict["screenshotHeightPx"] = screenshotHeightPx }
        if let screenWidthPt { dict["screenWidthPt"] = screenWidthPt }
        if let screenHeightPt { dict["screenHeightPt"] = screenHeightPt }
        if let executionResult { dict["executionResult"] = executionResult }
        if let executionError { dict["executionError"] = executionError }
        if let secondaryWindows { dict["secondaryWindows"] = secondaryWindows }
        return dict
    }
}

// MARK: - App Control

/// Lifecycle state of the target app at the moment of observation.
enum HostAppControlState: String {
    case running
    case missing
    case minimized
}

/// Window bounds in points for the focused window of the target app.
struct WindowBounds: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    func toDictionary() -> [String: Any] {
        ["x": x, "y": y, "width": width, "height": height]
    }
}

/// Payload posted back to the daemon with the result of a host app-control action.
struct HostAppControlResultPayload {
    let requestId: String
    let state: HostAppControlState
    let pngBase64: String?
    let windowBounds: WindowBounds?
    let executionResult: String?
    let executionError: String?

    init(
        requestId: String,
        state: HostAppControlState,
        pngBase64: String? = nil,
        windowBounds: WindowBounds? = nil,
        executionResult: String? = nil,
        executionError: String? = nil
    ) {
        self.requestId = requestId
        self.state = state
        self.pngBase64 = pngBase64
        self.windowBounds = windowBounds
        self.executionResult = executionResult
        self.executionError = executionError
    }

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "requestId": requestId,
            "state": state.rawValue,
        ]
        if let pngBase64 { dict["pngBase64"] = pngBase64 }
        if let windowBounds { dict["windowBounds"] = windowBounds.toDictionary() }
        if let executionResult { dict["executionResult"] = executionResult }
        if let executionError { dict["executionError"] = executionError }
        return dict
    }
}

/// A single step inside `.sequence`: one key press with optional modifiers,
/// hold duration, and post-press gap. Decoded from snake_case wire keys.
struct HostAppControlSequenceStep {
    let key: String
    let modifiers: [String]?
    let durationMs: Int?
    let gapMs: Int?

    init(
        key: String,
        modifiers: [String]? = nil,
        durationMs: Int? = nil,
        gapMs: Int? = nil
    ) {
        self.key = key
        self.modifiers = modifiers
        self.durationMs = durationMs
        self.gapMs = gapMs
    }

    static func from(dictionary dict: [String: Any]) throws -> HostAppControlSequenceStep {
        guard let key = dict["key"] as? String else {
            throw JsonRpcDispatchError.invalidParams("sequence step requires key")
        }
        return HostAppControlSequenceStep(
            key: key,
            modifiers: dict["modifiers"] as? [String],
            durationMs: (dict["duration_ms"] as? NSNumber)?.intValue,
            gapMs: (dict["gap_ms"] as? NSNumber)?.intValue
        )
    }
}

/// Discriminated-union payload for app-control input. The wire shape is
/// `{ "tool": "<variant>", ...fields }` for each variant.
enum HostAppControlInput {
    case start(app: String, args: [String]?)
    case observe(app: String, settleMs: Int?)
    case press(app: String, key: String, modifiers: [String]?, durationMs: Int?)
    case combo(app: String, keys: [String], durationMs: Int?)
    case sequence(app: String, steps: [HostAppControlSequenceStep])
    case type(app: String, text: String)
    case click(app: String, x: Double, y: Double, button: String?, double: Bool?)
    case drag(app: String, fromX: Double, fromY: Double, toX: Double, toY: Double, button: String?)
    case stop

    /// Whether the tool synthesizes input (CGEvent), which silently no-ops
    /// without Accessibility. Used to gate-and-prompt before executing so a
    /// first-time user doesn't get a "successful" action that did nothing.
    var needsAccessibility: Bool {
        switch self {
        case .press, .combo, .sequence, .type, .click, .drag:
            return true
        case .start, .observe, .stop:
            return false
        }
    }

    static func from(dictionary dict: [String: Any]) throws -> HostAppControlInput {
        let tool: String
        if let explicit = dict["tool"] as? String {
            tool = explicit
        } else if let toolName = dict["toolName"] as? String {
            // Derive the variant by stripping the `app_control_` prefix.
            tool = toolName.hasPrefix("app_control_")
                ? String(toolName.dropFirst("app_control_".count))
                : toolName
        } else {
            throw JsonRpcDispatchError.invalidParams("app control input requires tool")
        }

        func requireString(_ key: String) throws -> String {
            guard let value = dict[key] as? String else {
                throw JsonRpcDispatchError.invalidParams("app control \(tool) requires \(key)")
            }
            return value
        }
        func requireDouble(_ key: String) throws -> Double {
            guard let value = (dict[key] as? NSNumber)?.doubleValue else {
                throw JsonRpcDispatchError.invalidParams("app control \(tool) requires \(key)")
            }
            return value
        }

        switch tool {
        case "start":
            return .start(app: try requireString("app"), args: dict["args"] as? [String])
        case "observe":
            return .observe(
                app: try requireString("app"),
                settleMs: (dict["settle_ms"] as? NSNumber)?.intValue
            )
        case "press":
            return .press(
                app: try requireString("app"),
                key: try requireString("key"),
                modifiers: dict["modifiers"] as? [String],
                durationMs: (dict["duration_ms"] as? NSNumber)?.intValue
            )
        case "combo":
            guard let keys = dict["keys"] as? [String] else {
                throw JsonRpcDispatchError.invalidParams("app control combo requires keys")
            }
            return .combo(
                app: try requireString("app"),
                keys: keys,
                durationMs: (dict["duration_ms"] as? NSNumber)?.intValue
            )
        case "sequence":
            guard let rawSteps = dict["steps"] as? [[String: Any]] else {
                throw JsonRpcDispatchError.invalidParams("app control sequence requires steps")
            }
            let steps = try rawSteps.map { try HostAppControlSequenceStep.from(dictionary: $0) }
            return .sequence(app: try requireString("app"), steps: steps)
        case "type":
            return .type(app: try requireString("app"), text: try requireString("text"))
        case "click":
            return .click(
                app: try requireString("app"),
                x: try requireDouble("x"),
                y: try requireDouble("y"),
                button: dict["button"] as? String,
                double: dict["double"] as? Bool
            )
        case "drag":
            return .drag(
                app: try requireString("app"),
                fromX: try requireDouble("from_x"),
                fromY: try requireDouble("from_y"),
                toX: try requireDouble("to_x"),
                toY: try requireDouble("to_y"),
                button: dict["button"] as? String
            )
        case "stop":
            return .stop
        default:
            throw JsonRpcDispatchError.invalidParams("Unknown app control tool: \(tool)")
        }
    }
}
