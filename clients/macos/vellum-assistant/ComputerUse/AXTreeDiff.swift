import Foundation

/// Computes a compact diff between two formatted AX tree snapshots.
/// Returns a human-readable summary of what changed (elements added, removed, value changes, focus changes).
enum AXTreeDiff {

    struct ElementSnapshot: Hashable {
        let id: Int
        let role: String
        let title: String?
        let value: String?
        let isFocused: Bool
        let isEnabled: Bool
    }

    /// Produce a compact diff summary between two AX tree element lists.
    /// Returns nil if the trees are identical.
    static func diff(previous: [AXElement], current: [AXElement]) -> String? {
        let prevFlat = AccessibilityTreeEnumerator.flattenElements(previous)
        let currFlat = AccessibilityTreeEnumerator.flattenElements(current)

        let prevSnapshots = Dictionary(
            prevFlat.map { (snapshot(of: $0).id, snapshot(of: $0)) },
            uniquingKeysWith: { first, _ in first }
        )
        let currSnapshots = Dictionary(
            currFlat.map { (snapshot(of: $0).id, snapshot(of: $0)) },
            uniquingKeysWith: { first, _ in first }
        )

        var changes: [String] = []

        // Find removed elements (in previous but not in current)
        let removedIds = Set(prevSnapshots.keys).subtracting(currSnapshots.keys)
        for id in removedIds.sorted() {
            if let snap = prevSnapshots[id] {
                let label = snap.title ?? snap.role
                changes.append("- Removed: [\(id)] \(label)")
            }
        }

        // Find added elements (in current but not in previous)
        let addedIds = Set(currSnapshots.keys).subtracting(prevSnapshots.keys)
        for id in addedIds.sorted() {
            if let snap = currSnapshots[id] {
                let label = snap.title ?? snap.role
                changes.append("+ Added: [\(id)] \(label)")
            }
        }

        // Find changed elements (same ID, different state)
        let commonIds = Set(prevSnapshots.keys).intersection(currSnapshots.keys)
        for id in commonIds.sorted() {
            guard let prev = prevSnapshots[id], let curr = currSnapshots[id] else { continue }
            if prev == curr { continue }

            var elementChanges: [String] = []
            let label = curr.title ?? curr.role

            if prev.value != curr.value {
                let oldVal = prev.value ?? "(empty)"
                let newVal = curr.value ?? "(empty)"
                let truncOld = oldVal.count > 30 ? String(oldVal.prefix(30)) + "..." : oldVal
                let truncNew = newVal.count > 30 ? String(newVal.prefix(30)) + "..." : newVal
                elementChanges.append("value: \"\(truncOld)\" → \"\(truncNew)\"")
            }
            if prev.isFocused != curr.isFocused {
                elementChanges.append(curr.isFocused ? "gained focus" : "lost focus")
            }
            if prev.isEnabled != curr.isEnabled {
                elementChanges.append(curr.isEnabled ? "enabled" : "disabled")
            }
            if prev.title != curr.title {
                elementChanges.append("title: \"\(prev.title ?? "(none)")\" → \"\(curr.title ?? "(none)")\"")
            }

            if !elementChanges.isEmpty {
                changes.append("~ Changed: [\(id)] \(label) — \(elementChanges.joined(separator: ", "))")
            }
        }

        guard !changes.isEmpty else { return nil }

        return "CHANGES SINCE LAST ACTION:\n" + changes.joined(separator: "\n")
    }

    private static func snapshot(of element: AXElement) -> ElementSnapshot {
        ElementSnapshot(
            id: element.id,
            role: element.role,
            title: element.title,
            value: element.value,
            isFocused: element.isFocused,
            isEnabled: element.isEnabled
        )
    }
}
