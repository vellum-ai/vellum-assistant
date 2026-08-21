import Capacitor
import Foundation
import WidgetKit

/// Capacitor plugin the web layer uses to mirror a small conversation summary
/// (two counts and the most recent threads) into `WidgetSnapshotStore`, the
/// App Group cache the VoiceActivity extension can read.
///
/// Two methods:
/// - `sync({ generatedAt, unreadCount, inProgressCount, conversations })`
///   replaces the whole snapshot. Full replacement rather than a diff keeps
///   the contract trivial: the web side owns ordering and membership, and a
///   sync after archiving or reading a thread needs no tombstones.
/// - `clear()` drops it, for sign-out. See `WidgetSnapshotStore`'s cache
///   boundary for why this store, unlike `RecentChatsStore`, has one.
///
/// The payload's own version field is not read. The shell re-encodes into its
/// own model, so what lands in the store is a `currentSchemaVersion` blob by
/// construction and a field this build does not know is simply dropped.
///
/// Malformed conversation entries are dropped rather than rejecting the call:
/// a partial summary beats none, and the web producer already shapes the
/// payload. Per the skew rule in `clients/web/docs/CAPACITOR.md`, the one
/// result shape (`{ok: true}`) covers every state, including an empty payload.
@objc(WidgetSnapshotPlugin)
public class WidgetSnapshotPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetSnapshotPlugin"
    public let jsName = "WidgetSnapshot"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    /// The snapshot contract's ceiling. The web side already sends at most
    /// this many; clamping here keeps a misbehaving caller from growing the
    /// shared container without limit.
    private static let maxConversations = 3

    @objc public func sync(_ call: CAPPluginCall) {
        let conversations = (call.getArray("conversations") ?? [])
            .compactMap(Self.conversation(from:))
            .prefix(Self.maxConversations)
        let snapshot = WidgetSnapshot(
            schemaVersion: WidgetSnapshot.currentSchemaVersion,
            // The producer owns `generatedAt`; receipt time stands in only
            // when the payload carries no parseable timestamp, so the stored
            // value is always a real instant.
            generatedAt: Self.date(from: call.getString("generatedAt")) ?? Date(),
            unreadCount: max(0, call.getInt("unreadCount") ?? 0),
            inProgressCount: max(0, call.getInt("inProgressCount") ?? 0),
            conversations: Array(conversations)
        )
        WidgetSnapshotStore.save(snapshot)
        Self.reloadWidgets()
        call.resolve(["ok": true])
    }

    @objc public func clear(_ call: CAPPluginCall) {
        WidgetSnapshotStore.clear()
        Self.reloadWidgets()
        call.resolve(["ok": true])
    }

    private static func conversation(from item: Any) -> WidgetSnapshotConversation? {
        guard let dict = item as? [String: Any],
              let id = dict["id"] as? String, !id.isEmpty,
              let title = dict["title"] as? String, !title.isEmpty
        else {
            return nil
        }
        return WidgetSnapshotConversation(
            id: id,
            title: title,
            subtitle: (dict["subtitle"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            hasUnseen: dict["hasUnseen"] as? Bool ?? false,
            isProcessing: dict["isProcessing"] as? Bool ?? false
        )
    }

    /// JavaScript's `toISOString()` always carries milliseconds, which the
    /// plain internet-date-time parser rejects outright, so both shapes are
    /// tried before giving up.
    private static func date(from raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return fractionalSecondsFormatter.date(from: raw) ?? wholeSecondsFormatter.date(from: raw)
    }

    private static let fractionalSecondsFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let wholeSecondsFormatter = ISO8601DateFormatter()

    /// Every kind renders from the one snapshot, so a write invalidates all of
    /// them. `reloadTimelines` on a kind no widget is showing is a no-op.
    private static func reloadWidgets() {
        for kind in VellumWidgetKind.all {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
    }
}
