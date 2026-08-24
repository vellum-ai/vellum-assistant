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
/// The shell only stores payloads whose schema it understands. `sync` reads
/// the payload's `schemaVersion` and stores it only when it matches
/// `WidgetSnapshot.currentSchemaVersion`; anything else (a newer web
/// deployment against an older installed shell, or the inverse after a shell
/// upgrade) clears the stored snapshot instead, so the widgets fall back to
/// their empty state rather than showing data relabeled with a version whose
/// field meanings this build cannot vouch for. An older shell receiving a
/// newer payload therefore degrades to empty widgets until the shell updates.
/// This is the write-side half of the check `WidgetSnapshotStore.load()`
/// already makes on read.
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
        // A payload with no version is as unreadable as one carrying a version
        // this build does not know: every producer of this contract sends the
        // field, so its absence is skew rather than an older dialect.
        let payloadVersion = call.getInt("schemaVersion")
        guard payloadVersion == WidgetSnapshot.currentSchemaVersion else {
            NSLog(
                "[widget] Dropping a snapshot for schema %@; this build reads %d",
                payloadVersion.map { "\($0)" } ?? "<none>",
                WidgetSnapshot.currentSchemaVersion
            )
            Self.clearSnapshotAndReloadWidgets()
            call.resolve(["ok": true])
            return
        }
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
        Self.clearSnapshotAndReloadWidgets()
        call.resolve(["ok": true])
    }

    /// Drop the App Group snapshot and refresh the surfaces that render it.
    static func clearSnapshotAndReloadWidgets() {
        WidgetSnapshotStore.clear()
        reloadWidgets()
    }

    /// Bind the stored snapshot to the origin the shell is serving, dropping it
    /// when that origin has moved since the last recording.
    ///
    /// This is the native side of the origin-change invariant: every change of
    /// the active self-hosted origin drops the snapshot, because the bookkeeping
    /// that would carry an unfinished clear forward lives in per-origin web
    /// storage the destination origin cannot read. Recording rather than
    /// clearing outright is what makes the invariant hold across a change the
    /// running process never saw: the compared value is mirrored into the App
    /// Group, so the boot recording catches an origin the iOS Settings pane
    /// rewrote while the app was terminated. See `SelfHostedServer` for the
    /// three callers and why each one is needed.
    ///
    /// A mirror that was never written counts as a match, so the first launch
    /// after this ships adopts the origin it finds instead of blanking widgets
    /// that are correct.
    ///
    /// `canonicalOrigin` must come from `SelfHostedServer.activeOriginIdentity`
    /// on every caller: the comparison is string equality, so agreeing on one
    /// spelling per server is the whole contract.
    static func recordAppliedOrigin(_ canonicalOrigin: String) {
        if let previous = WidgetSnapshotStore.appliedOrigin(), previous != canonicalOrigin {
            clearSnapshotAndReloadWidgets()
        }
        WidgetSnapshotStore.setAppliedOrigin(canonicalOrigin)
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
