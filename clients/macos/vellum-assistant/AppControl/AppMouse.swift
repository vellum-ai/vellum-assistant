import CoreGraphics
import Foundation
import VellumAssistantShared

/// Per-process mouse input helper for the app-control skill.
///
/// All events are posted via `CGEvent.postToPid(_:)` (the modern Swift
/// spelling of `CGEventPostToPid`) so they target the specific host process
/// rather than the global event tap, keeping the user's real cursor and
/// other apps unaffected.
///
/// Coordinates are window-relative and translated to global at post time
/// using the current `WindowBounds` reported by the assistant.
enum AppMouse {

    // MARK: - Errors

    enum AppMouseError: LocalizedError {
        case eventCreationFailed

        var errorDescription: String? {
            switch self {
            case .eventCreationFailed: return "Failed to create CGEvent"
            }
        }
    }

    // MARK: - Mouse buttons

    enum MouseButton: String {
        case left
        case right
        case middle
    }

    static func cgButton(for button: MouseButton) -> CGMouseButton {
        switch button {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    private static func downType(for button: MouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    private static func upType(for button: MouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    private static func draggedType(for button: MouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }

    // MARK: - Pure helpers (unit-tested)

    /// Translates a window-relative point to a global screen coordinate.
    static func windowRelativeToGlobal(_ point: CGPoint, windowBounds: WindowBounds) -> CGPoint {
        return CGPoint(x: windowBounds.x + point.x, y: windowBounds.y + point.y)
    }

    /// Returns `steps` evenly-spaced intermediate points strictly between
    /// `from` and `to` (exclusive of both endpoints). Returns an empty
    /// array when `steps <= 0`.
    static func interpolate(from: CGPoint, to: CGPoint, steps: Int) -> [CGPoint] {
        guard steps > 0 else { return [] }
        var points: [CGPoint] = []
        points.reserveCapacity(steps)
        let denom = CGFloat(steps + 1)
        for i in 1...steps {
            let t = CGFloat(i) / denom
            points.append(CGPoint(
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t
            ))
        }
        return points
    }

    // MARK: - Click

    /// Posts a synthetic mouse click to the target process.
    ///
    /// `x`/`y` are window-relative; they are translated to global coordinates
    /// using `windowBounds`. When `double` is `true`, two down/up cycles are
    /// posted with `mouseEventClickState` set to 2 on the second cycle to
    /// match how macOS native double-click events look.
    static func click(
        pid: pid_t,
        windowBounds: WindowBounds,
        x: Double,
        y: Double,
        button: MouseButton,
        double: Bool
    ) throws {
        let global = windowRelativeToGlobal(CGPoint(x: x, y: y), windowBounds: windowBounds)
        let cgButton = cgButton(for: button)
        let down = downType(for: button)
        let up = upType(for: button)

        try postClick(pid: pid, position: global, downType: down, upType: up, cgButton: cgButton, clickState: 1)
        if double {
            try postClick(pid: pid, position: global, downType: down, upType: up, cgButton: cgButton, clickState: 2)
        }
    }

    private static func postClick(
        pid: pid_t,
        position: CGPoint,
        downType: CGEventType,
        upType: CGEventType,
        cgButton: CGMouseButton,
        clickState: Int64
    ) throws {
        try postMouseEvent(pid: pid, type: downType, position: position, cgButton: cgButton, clickState: clickState)
        try postMouseEvent(pid: pid, type: upType, position: position, cgButton: cgButton, clickState: clickState)
    }

    private static func postMouseEvent(
        pid: pid_t,
        type: CGEventType,
        position: CGPoint,
        cgButton: CGMouseButton,
        clickState: Int64? = nil
    ) throws {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: position,
            mouseButton: cgButton
        ) else {
            throw AppMouseError.eventCreationFailed
        }
        if let clickState {
            event.setIntegerValueField(.mouseEventClickState, value: clickState)
        }
        event.postToPid(pid)
    }

    // MARK: - Drag

    /// Posts a synthetic mouse drag to the target process: mouseDown at
    /// `from`, 10 interpolated mouseDragged events, then mouseUp at `to`.
    static func drag(
        pid: pid_t,
        windowBounds: WindowBounds,
        fromX: Double,
        fromY: Double,
        toX: Double,
        toY: Double,
        button: MouseButton
    ) throws {
        let fromGlobal = windowRelativeToGlobal(CGPoint(x: fromX, y: fromY), windowBounds: windowBounds)
        let toGlobal = windowRelativeToGlobal(CGPoint(x: toX, y: toY), windowBounds: windowBounds)
        let cgButton = cgButton(for: button)

        try postMouseEvent(pid: pid, type: downType(for: button), position: fromGlobal, cgButton: cgButton)
        for point in interpolate(from: fromGlobal, to: toGlobal, steps: 10) {
            try postMouseEvent(pid: pid, type: draggedType(for: button), position: point, cgButton: cgButton)
        }
        try postMouseEvent(pid: pid, type: upType(for: button), position: toGlobal, cgButton: cgButton)
    }
}
