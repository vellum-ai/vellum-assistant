import ApplicationServices
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AXRegistry")

/// Maps AXElement IDs (from the enumerated AX tree) back to live AXUIElement references.
///
/// During AX tree enumeration, each element is assigned a monotonic integer ID. This registry
/// stores the original AXUIElement reference for each ID so that AX-first actions (click, type)
/// can target elements directly without coordinate conversion.
///
/// The registry is cleared and rebuilt on each enumeration cycle, so element IDs are only valid
/// for the current step.
///
/// Thread safety: accessed from the enumerator (synchronous, single-threaded) and from
/// `AXActionExecutor` (MainActor). All access is sequential — enumeration completes before
/// any action executor reads — so no concurrent mutation occurs.
final class AXElementRegistry: @unchecked Sendable {
    /// Maps element ID -> live AXUIElement reference.
    private var elements: [Int: AXUIElement] = [:]

    /// Clears all stored references. Called at the start of each enumeration.
    func clear() {
        elements.removeAll(keepingCapacity: true)
    }

    /// Registers an AXUIElement with the given ID.
    func register(elementId: Int, element: AXUIElement) {
        elements[elementId] = element
    }

    /// Resolves an element ID to its live AXUIElement reference.
    /// Returns nil if the ID is not in the registry (e.g., stale ID from a previous step).
    func resolve(elementId: Int) -> AXUIElement? {
        return elements[elementId]
    }

    /// The number of registered elements.
    var count: Int { elements.count }
}
