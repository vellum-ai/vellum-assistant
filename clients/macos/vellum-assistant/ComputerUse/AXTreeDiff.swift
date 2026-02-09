import Foundation

/// Computes a compact diff between two formatted AX tree snapshots.
/// Returns a human-readable summary of what changed (elements added, removed, value changes, focus changes).
enum AXTreeDiff {

    /// Stable identity for matching elements across scans.
    /// Uses immutable structural properties instead of ephemeral IDs (which reset each
    /// enumeration). Title is intentionally excluded — it can change in place (e.g. a
    /// button label updating) and should be detected as a "Changed" entry, not remove+add.
    struct StableKey: Hashable, Comparable {
        let role: String
        let identifier: String?
        let frameX: Int
        let frameY: Int

        static func < (lhs: StableKey, rhs: StableKey) -> Bool {
            if lhs.role != rhs.role { return lhs.role < rhs.role }
            if lhs.frameX != rhs.frameX { return lhs.frameX < rhs.frameX }
            return lhs.frameY < rhs.frameY
        }
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
    /// Elements are matched by stable structural identity (role, identifier, frame
    /// position) rather than ephemeral IDs, which reset each enumeration and shift
    /// when elements are inserted or removed. Uses multiset matching per key so
    /// duplicate elements (same structural identity) are individually tracked.
    static func diff(previous: [AXElement], current: [AXElement]) -> String? {
        let prevFlat = AccessibilityTreeEnumerator.flattenElements(previous)
        let currFlat = AccessibilityTreeEnumerator.flattenElements(current)

        // Build multimaps so duplicate structural keys are preserved
        var prevByKey: [StableKey: [ElementSnapshot]] = [:]
        for el in prevFlat {
            prevByKey[stableKey(of: el), default: []].append(snapshot(of: el))
        }
        var currByKey: [StableKey: [ElementSnapshot]] = [:]
        for el in currFlat {
            currByKey[stableKey(of: el), default: []].append(snapshot(of: el))
        }

        var changes: [String] = []
        let allKeys = Set(prevByKey.keys).union(currByKey.keys).sorted()

        for key in allKeys {
            var unmatchedPrev = prevByKey[key] ?? []
            var unmatchedCurr = currByKey[key] ?? []

            // Remove identical pairs (unchanged elements)
            for snap in Array(unmatchedPrev) {
                if let idx = unmatchedCurr.firstIndex(of: snap) {
                    unmatchedCurr.remove(at: idx)
                    unmatchedPrev.remove(at: unmatchedPrev.firstIndex(of: snap)!)
                }
            }

            // Pair remaining as changes (same structural key, different state)
            let paired = min(unmatchedPrev.count, unmatchedCurr.count)
            for i in 0..<paired {
                let prev = unmatchedPrev[i]
                let curr = unmatchedCurr[i]

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
                    changes.append("~ Changed: [\(curr.id)] \(label) — \(elementChanges.joined(separator: ", "))")
                }
            }

            // Extra in prev = removed
            for i in paired..<unmatchedPrev.count {
                let snap = unmatchedPrev[i]
                let label = snap.title ?? snap.role
                changes.append("- Removed: [\(snap.id)] \(label)")
            }

            // Extra in curr = added
            for i in paired..<unmatchedCurr.count {
                let snap = unmatchedCurr[i]
                let label = snap.title ?? snap.role
                changes.append("+ Added: [\(snap.id)] \(label)")
            }
        }

        guard !changes.isEmpty else { return nil }

        // If more than half the elements changed on a non-trivial page, it likely navigated —
        // the diff is noise, so drop it and let the model just read the current tree.
        let totalElements = max(prevFlat.count, currFlat.count)
        if totalElements >= 10 && changes.count > totalElements / 2 {
            return nil
        }

        return "CHANGES SINCE LAST ACTION:\n" + changes.joined(separator: "\n")
    }

    private static func stableKey(of element: AXElement) -> StableKey {
        StableKey(
            role: element.role,
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
