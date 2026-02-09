import Foundation

/// Computes a compact diff between two formatted AX tree snapshots.
/// Returns a human-readable summary of what changed (elements added, removed, value changes, focus changes).
enum AXTreeDiff {

    /// Stable identity for matching elements across scans.
    /// Uses structural properties instead of ephemeral IDs (which reset each enumeration).
    struct StableKey: Hashable {
        let role: String
        let title: String?
        let identifier: String?
        let frameX: Int
        let frameY: Int
    }

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
    ///
    /// Elements are matched by stable structural identity (role, title, identifier,
    /// frame position) rather than ephemeral IDs, which reset each enumeration and
    /// shift when elements are inserted or removed.
    static func diff(previous: [AXElement], current: [AXElement]) -> String? {
        let prevFlat = AccessibilityTreeEnumerator.flattenElements(previous)
        let currFlat = AccessibilityTreeEnumerator.flattenElements(current)

        let prevByKey = Dictionary(
            prevFlat.map { (stableKey(of: $0), snapshot(of: $0)) },
            uniquingKeysWith: { first, _ in first }
        )
        let currByKey = Dictionary(
            currFlat.map { (stableKey(of: $0), snapshot(of: $0)) },
            uniquingKeysWith: { first, _ in first }
        )

        var changes: [String] = []

        // Find removed elements (in previous but not in current)
        let removedKeys = Set(prevByKey.keys).subtracting(currByKey.keys)
        for key in removedKeys.sorted(by: { $0.role < $1.role || ($0.role == $1.role && ($0.title ?? "") < ($1.title ?? "")) }) {
            if let snap = prevByKey[key] {
                let label = snap.title ?? snap.role
                changes.append("- Removed: [\(snap.id)] \(label)")
            }
        }

        // Find added elements (in current but not in previous)
        let addedKeys = Set(currByKey.keys).subtracting(prevByKey.keys)
        for key in addedKeys.sorted(by: { $0.role < $1.role || ($0.role == $1.role && ($0.title ?? "") < ($1.title ?? "")) }) {
            if let snap = currByKey[key] {
                let label = snap.title ?? snap.role
                changes.append("+ Added: [\(snap.id)] \(label)")
            }
        }

        // Find changed elements (same stable identity, different state)
        let commonKeys = Set(prevByKey.keys).intersection(currByKey.keys)
        for key in commonKeys.sorted(by: { $0.role < $1.role || ($0.role == $1.role && ($0.title ?? "") < ($1.title ?? "")) }) {
            guard let prev = prevByKey[key], let curr = currByKey[key] else { continue }
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
                // Use the current element's ID so the model can target it
                changes.append("~ Changed: [\(curr.id)] \(label) — \(elementChanges.joined(separator: ", "))")
            }
        }

        guard !changes.isEmpty else { return nil }

        return "CHANGES SINCE LAST ACTION:\n" + changes.joined(separator: "\n")
    }

    private static func stableKey(of element: AXElement) -> StableKey {
        StableKey(
            role: element.role,
            title: element.title,
            identifier: element.identifier,
            frameX: Int(element.frame.origin.x),
            frameY: Int(element.frame.origin.y)
        )
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
