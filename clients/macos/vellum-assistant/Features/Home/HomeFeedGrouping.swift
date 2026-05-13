import Foundation
import VellumAssistantShared

/// A feed row for display — either a single item, or a parent item with
/// a run of low-priority children collapsed beneath it.
enum HomeFeedGroupedRow: Hashable {
    case single(FeedItem)
    case group(parent: FeedItem, children: [FeedItem])

    var id: String {
        switch self {
        case .single(let item): return item.id
        case .group(let parent, _): return parent.id
        }
    }
}

/// Collapses contiguous low-priority items into grouped rows.
///
/// A run of ≥ ``minimumGroupSize`` consecutive items with
/// `priority < lowPriorityThreshold` is emitted as a single
/// ``HomeFeedGroupedRow/group(parent:children:)`` row: the first item in
/// the run becomes the parent and the remaining items become children in
/// original order. Items that don't qualify — items at or above the
/// threshold, or runs shorter than `minimumGroupSize` — pass through as
/// ``HomeFeedGroupedRow/single(_:)``.
///
/// Relative input order is preserved across both singles and groups.
enum HomeFeedGrouping {
    /// Items with `priority < lowPriorityThreshold` are eligible to be
    /// collapsed into a group.
    static let lowPriorityThreshold: Int = 30

    /// A run of eligible items must reach this length to be collapsed.
    static let minimumGroupSize: Int = 3

    /// Collapse contiguous low-priority items into a single grouped row.
    /// A run is eligible when there are ≥ ``minimumGroupSize`` consecutive
    /// items with `priority < lowPriorityThreshold`. The first item in
    /// the run becomes the parent; remaining items become children in
    /// order. Items at or above the threshold, and runs shorter than
    /// ``minimumGroupSize``, pass through as `.single`. Preserves the
    /// input's relative order.
    static func group(_ items: [FeedItem]) -> [HomeFeedGroupedRow] {
        var rows: [HomeFeedGroupedRow] = []
        var buffer: [FeedItem] = []

        func flushBuffer() {
            if buffer.count >= minimumGroupSize {
                let parent = buffer[0]
                let children = Array(buffer.dropFirst())
                rows.append(.group(parent: parent, children: children))
            } else {
                for item in buffer {
                    rows.append(.single(item))
                }
            }
            buffer.removeAll(keepingCapacity: true)
        }

        for item in items {
            if item.priority < lowPriorityThreshold {
                buffer.append(item)
            } else {
                flushBuffer()
                rows.append(.single(item))
            }
        }
        flushBuffer()

        return rows
    }
}
