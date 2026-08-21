import Foundation
import WidgetKit

/// One rendering of the App Group snapshot, at the moment WidgetKit draws it.
///
/// `isStale` is carried on the entry rather than recomputed in the view because
/// a widget's views are drawn from entries the system may have held for a
/// while: the timeline decides when the snapshot stops being trustworthy, and
/// every view renders the decision it was handed.
struct SnapshotEntry: TimelineEntry {
    let date: Date

    /// The cached snapshot, or `nil` when no app build has ever synced one
    /// into this environment's App Group (a fresh install, a signed-out
    /// account, a shell whose web bundle predates the sync).
    let snapshot: WidgetSnapshot?

    /// Whether the snapshot is old enough that its claims about work happening
    /// *right now* are dropped. See ``SnapshotProvider/staleAfter``.
    let isStale: Bool

    /// The conversations to render, empty whenever there is no snapshot.
    var conversations: [WidgetSnapshotConversation] {
        snapshot?.conversations ?? []
    }
}

/// The timeline behind every Vellum Home Screen widget: read the App Group
/// snapshot, hand it over, and schedule the one moment it stops being fresh.
///
/// The extension has no network stack and no auth, so there is nothing to
/// fetch here. `WidgetSnapshotPlugin` writes the snapshot while the app is
/// open and calls `WidgetCenter.reloadTimelines(ofKind:)`, which is what
/// actually keeps these widgets current; the `.atEnd` policy is the floor
/// under that, not the mechanism.
struct SnapshotProvider: TimelineProvider {
    /// How long a snapshot's live claims are trusted.
    ///
    /// The app is the only writer, so an untouched phone's snapshot ages
    /// without bound. Half an hour is well past any plausible "I just put the
    /// phone down" gap and well short of leaving a spinner on the Home Screen
    /// all afternoon for a turn that finished before lunch. Titles and group
    /// names keep rendering past it: what a conversation is called does not go
    /// out of date the way "working on it" does.
    static let staleAfter: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: Date(), snapshot: .placeholder, isStale: false)
    }

    /// The gallery and the widget's transient previews ask through here. A
    /// preview shows the fixture rather than the real snapshot, so browsing
    /// the gallery on a locked device cannot put someone's conversation titles
    /// on screen, and so an account with nothing synced yet is still offered a
    /// widget that looks like something.
    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        completion(entry(at: Date(), for: WidgetSnapshotStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date()
        let snapshot = WidgetSnapshotStore.load()
        var entries = [entry(at: now, for: snapshot)]
        if let snapshot {
            // The one scheduled transition: the same snapshot, redrawn without
            // its live claims. Omitted when the snapshot is already past it,
            // in which case the entry above is stale from the start.
            let staleAt = snapshot.generatedAt.addingTimeInterval(Self.staleAfter)
            if staleAt > now {
                entries.append(SnapshotEntry(date: staleAt, snapshot: snapshot, isStale: true))
            }
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    private func entry(at date: Date, for snapshot: WidgetSnapshot?) -> SnapshotEntry {
        guard let snapshot else {
            return SnapshotEntry(date: date, snapshot: nil, isStale: false)
        }
        return SnapshotEntry(
            date: date,
            snapshot: snapshot,
            isStale: date.timeIntervalSince(snapshot.generatedAt) >= Self.staleAfter
        )
    }
}

extension WidgetSnapshot {
    /// Filler for `placeholder(in:)` and the widget gallery.
    ///
    /// Invented rather than sampled from the store, for the reason the gallery
    /// preview exists at all: whatever this renders can be seen by anyone
    /// holding the phone, including before it is unlocked. It covers all three
    /// row treatments (unread, working, plain) so the gallery entry shows what
    /// the widget can actually tell you.
    static let placeholder = WidgetSnapshot(
        schemaVersion: WidgetSnapshot.currentSchemaVersion,
        generatedAt: Date(),
        unreadCount: 2,
        inProgressCount: 1,
        conversations: [
            WidgetSnapshotConversation(
                id: "placeholder-1",
                title: "Your morning briefing",
                subtitle: "Daily",
                lastMessageAt: nil,
                hasUnseen: true,
                isProcessing: false
            ),
            WidgetSnapshotConversation(
                id: "placeholder-2",
                title: "Trip planning notes",
                subtitle: "Travel",
                lastMessageAt: nil,
                hasUnseen: true,
                isProcessing: false
            ),
            WidgetSnapshotConversation(
                id: "placeholder-3",
                title: "Looking that up",
                subtitle: nil,
                lastMessageAt: nil,
                hasUnseen: false,
                isProcessing: true
            ),
        ]
    )
}
