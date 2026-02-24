import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AXAction")

/// Result of an AX-first action attempt.
enum AXActionResult {
    /// AX action succeeded — no CGEvent fallback needed.
    case success(String?)
    /// AX action could not be performed — caller should fall back to CGEvent.
    case fallback(reason: String)
}

/// Executes click and type actions via the Accessibility API instead of CGEvent injection.
///
/// AX-first actions are more reliable than coordinate-based CGEvent because they:
/// - Target the exact UI element (no coordinate drift from window repositioning)
/// - Work even when the element is partially obscured
/// - Don't require the element to be at a specific screen position
///
/// Falls back to CGEvent when:
/// - No element registry is available
/// - The target element doesn't support the required AX action
/// - AX API calls fail (app unresponsive, permission issues)
@MainActor
final class AXActionExecutor {

    /// Reference to the element registry for resolving elementId -> AXUIElement.
    private let elementRegistry: AXElementRegistry

    init(elementRegistry: AXElementRegistry) {
        self.elementRegistry = elementRegistry
    }

    /// Attempts to click an element via AX kAXPressAction.
    ///
    /// - Parameter elementId: The AX element ID from the last enumeration.
    /// - Returns: `.success` if the action was performed, `.fallback` if CGEvent should be used.
    func click(elementId: Int) -> AXActionResult {
        guard let axElement = elementRegistry.resolve(elementId: elementId) else {
            return .fallback(reason: "Element [\(elementId)] not in registry")
        }

        let result = AXUIElementPerformAction(axElement, kAXPressAction as CFString)
        if result == .success {
            log.info("AX click on [\(elementId)]: success")
            return .success("AX click performed on element [\(elementId)]")
        }

        // Some elements don't support kAXPressAction — fall back
        log.info("AX click on [\(elementId)]: failed (AXError \(result.rawValue)), falling back to CGEvent")
        return .fallback(reason: "kAXPressAction failed: AXError \(result.rawValue)")
    }

    /// Attempts to set text on an element via AX kAXValueAttribute.
    ///
    /// This works for text fields and text areas that accept the AXValue attribute.
    /// For elements that don't support it (e.g., content-editable web fields),
    /// falls back to CGEvent keyboard input.
    ///
    /// - Parameters:
    ///   - elementId: The AX element ID from the last enumeration.
    ///   - text: The text to set.
    /// - Returns: `.success` if the value was set, `.fallback` if CGEvent should be used.
    func type(elementId: Int, text: String) -> AXActionResult {
        guard let axElement = elementRegistry.resolve(elementId: elementId) else {
            return .fallback(reason: "Element [\(elementId)] not in registry")
        }

        // First, focus the element
        let focusResult = AXUIElementSetAttributeValue(axElement, kAXFocusedAttribute as CFString, true as CFTypeRef)
        if focusResult != .success {
            log.info("AX type on [\(elementId)]: focus failed (AXError \(focusResult.rawValue)), falling back")
            return .fallback(reason: "Could not focus element [\(elementId)]: AXError \(focusResult.rawValue)")
        }

        // Try setting the value directly
        let result = AXUIElementSetAttributeValue(axElement, kAXValueAttribute as CFString, text as CFTypeRef)
        if result == .success {
            log.info("AX type on [\(elementId)]: set value successfully (\(text.count) chars)")
            return .success("AX type performed on element [\(elementId)]")
        }

        log.info("AX type on [\(elementId)]: set value failed (AXError \(result.rawValue)), falling back to CGEvent")
        return .fallback(reason: "kAXValueAttribute set failed: AXError \(result.rawValue)")
    }

    /// Attempts to focus an element via AX.
    ///
    /// - Parameter elementId: The AX element ID from the last enumeration.
    /// - Returns: `.success` if focused, `.fallback` if it failed.
    func focus(elementId: Int) -> AXActionResult {
        guard let axElement = elementRegistry.resolve(elementId: elementId) else {
            return .fallback(reason: "Element [\(elementId)] not in registry")
        }

        let result = AXUIElementSetAttributeValue(axElement, kAXFocusedAttribute as CFString, true as CFTypeRef)
        if result == .success {
            log.info("AX focus on [\(elementId)]: success")
            return .success("AX focus on element [\(elementId)]")
        }

        return .fallback(reason: "Could not focus element [\(elementId)]: AXError \(result.rawValue)")
    }
}
