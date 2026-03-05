import XCTest
@testable import VellumAssistantLib

// MARK: - AXTreeDiff Performance Baselines
//
// These tests establish XCTest performance baselines for AXTreeDiff.diff()
// computation across representative scenarios. On the first run XCTest records
// a baseline; subsequent runs fail if wall-clock time regresses by more than
// the default XCTest allowance (~10 %).
//
// Run manually with:
//   swift test --filter AXTreeDiffPerformanceTests  (from clients/macos/)
// or via Xcode's Test navigator.

final class AXTreeDiffPerformanceTests: XCTestCase {

    // MARK: - Synthetic Element Generation

    /// Creates a flat array of synthetic AXElement instances.
    /// Each element has a unique id and deterministic frame/role/title values
    /// derived from the index so that StableKey matching behaves realistically.
    private static func makeElements(
        count: Int,
        idOffset: Int = 0,
        prefix: String = "el"
    ) -> [AXElement] {
        let roles = [
            "AXButton", "AXTextField", "AXStaticText", "AXGroup",
            "AXCheckBox", "AXLink", "AXTextArea", "AXMenuItem"
        ]
        return (0..<count).map { i in
            let id = idOffset + i + 1
            let role = roles[i % roles.count]
            let x = CGFloat((i % 20) * 40)
            let y = CGFloat((i / 20) * 30)
            return AXElement(
                id: id,
                role: role,
                title: "\(prefix)-\(i)",
                value: i % 3 == 0 ? "value-\(i)" : nil,
                frame: CGRect(x: x, y: y, width: 100, height: 24),
                isEnabled: true,
                isFocused: i == 0,
                children: [],
                roleDescription: nil,
                identifier: "id-\(prefix)-\(i)",
                url: nil,
                placeholderValue: nil
            )
        }
    }

    /// Returns a copy of `elements` with `count` elements mutated (title changed).
    /// Mutations are spread evenly across the array.
    private static func mutateElements(
        _ elements: [AXElement],
        count: Int
    ) -> [AXElement] {
        guard count > 0, !elements.isEmpty else { return elements }
        let step = max(1, elements.count / count)
        var result = elements
        for i in stride(from: 0, to: elements.count, by: step) {
            let old = result[i]
            result[i] = AXElement(
                id: old.id,
                role: old.role,
                title: (old.title ?? "") + "-changed",
                value: old.value,
                frame: old.frame,
                isEnabled: old.isEnabled,
                isFocused: old.isFocused,
                children: old.children,
                roleDescription: old.roleDescription,
                identifier: old.identifier,
                url: old.url,
                placeholderValue: old.placeholderValue
            )
        }
        return result
    }

    // MARK: - Benchmarks

    /// Small tree (~50 elements), ~5 elements changed.
    /// Simulates a typical session step where the UI has minimal changes.
    func testSmallTreeSmallDiff() {
        let previous = Self.makeElements(count: 50, prefix: "s")
        let current = Self.mutateElements(previous, count: 5)

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<200 {
                _ = AXTreeDiff.diff(previousFlat: previous, currentFlat: current)
            }
        }
    }

    /// Medium tree (~200 elements), ~50 elements changed.
    /// Simulates switching between app views with substantial UI changes.
    func testMediumTreeManyChanges() {
        let previous = Self.makeElements(count: 200, prefix: "m")
        let current = Self.mutateElements(previous, count: 50)

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<50 {
                _ = AXTreeDiff.diff(previousFlat: previous, currentFlat: current)
            }
        }
    }

    /// Large tree (~500 elements), identical previous and current.
    /// This is the no-op fast path when the UI hasn't changed between session steps.
    func testLargeTreeIdentical() {
        let elements = Self.makeElements(count: 500, prefix: "l")

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<50 {
                _ = AXTreeDiff.diff(previousFlat: elements, currentFlat: elements)
            }
        }
    }

    /// Large tree (~200 elements), complete replacement — previous and current
    /// share no structural keys. Worst case: forces full multimap rebuild with
    /// no matches.
    func testLargeTreeCompleteReplacement() {
        let previous = Self.makeElements(count: 200, idOffset: 0, prefix: "old")
        let current = Self.makeElements(count: 200, idOffset: 1000, prefix: "new")

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<50 {
                _ = AXTreeDiff.diff(previousFlat: previous, currentFlat: current)
            }
        }
    }
}
