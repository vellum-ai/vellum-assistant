import ActivityKit
import Foundation

/// ActivityKit model describing a running live-voice session.
///
/// Compiled into both the app (which requests and updates the activity) and the
/// widget extension (which renders it), so this file must stay free of UI and of
/// app-only imports — `ActivityKit` and `Foundation` only.
///
/// `assistantName` is an attribute rather than part of `ContentState` because it
/// is fixed for the lifetime of an activity; everything that changes mid-session
/// lives in `ContentState`.
struct VoiceSessionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Session phase, mirroring `LiveVoiceSessionState` in
        /// `clients/web/src/domains/chat/voice/live-voice/live-voice-store.ts`,
        /// which is the source of truth. **The two enums must be changed
        /// together**: the web side sends these raw values across the Capacitor
        /// bridge, so a case added or renamed there without a matching change
        /// here fails to decode.
        ///
        /// `idle` and `failed` are deliberately absent — these are exactly the
        /// phases of a *running* session. An idle session has no Live Activity,
        /// and the web mirror ends the activity on a failure rather than
        /// rendering it (the failure is surfaced in the app, where it can be
        /// dismissed). A case for either would be unreachable state the island
        /// UI would still have to handle. The web type is derived from the same
        /// predicate that decides this — `isLiveVoiceSessionActive` — so it
        /// cannot drift on that side.
        enum Phase: String, Codable, Hashable {
            case connecting
            case listening
            case transcribing
            case thinking
            case speaking
            case ending
        }

        /// Neutral accent (`systemGray`) used when `accentHex` is unparseable.
        static let neutralAccentHex = "#8E8E93"

        var phase: Phase

        /// User-facing activity copy, passed through from the web side.
        ///
        /// `LIVE_VOICE_STATE_LABELS` and `liveVoiceSurfaceLabel` (including its
        /// `reconnecting` → "Reconnecting…" case and its silent-`speaking` →
        /// "Thinking…" remap) in `live-voice-store.ts` are the single source of
        /// this copy — it is the same call the voice room makes. **The native
        /// side must never invent its own phase wording** — the shell ships on
        /// App Store cadence while
        /// that copy deploys continuously, so a native `switch` over `phase`
        /// would silently fossilize old strings.
        var label: String

        /// Avatar accent the voice room renders, as `#RRGGBB` (`#RRGGBBAA` and
        /// `#RGB` are accepted and canonicalized), so the island matches the
        /// room. Always parseable: unrecognized input falls back to
        /// ``neutralAccentHex`` rather than trapping.
        var accentHex: String

        var muted: Bool

        init(phase: Phase, label: String, accentHex: String, muted: Bool) {
            self.phase = phase
            self.label = label
            self.accentHex = Self.canonicalAccentHex(accentHex)
            self.muted = muted
        }

        /// Decoding funnels through the validating initializer so the
        /// always-parseable `accentHex` invariant survives the trip across the
        /// process boundary into the widget extension.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                phase: try container.decode(Phase.self, forKey: .phase),
                label: try container.decode(String.self, forKey: .label),
                accentHex: try container.decode(String.self, forKey: .accentHex),
                muted: try container.decode(Bool.self, forKey: .muted)
            )
        }

        /// Canonicalizes a CSS hex color (`#RGB`, `#RRGGBB`, `#RRGGBBAA`, with
        /// the `#` optional) to `#` plus uppercase digits, falling back to
        /// ``neutralAccentHex`` for anything else. The accepted grammar matches
        /// `UIColor(cssHex:)`, so the canonical form always parses.
        static func canonicalAccentHex(_ raw: String) -> String {
            var digits = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if digits.hasPrefix("#") {
                digits.removeFirst()
            }
            if digits.count == 3 {
                digits = digits.map { "\($0)\($0)" }.joined()
            }
            guard digits.count == 6 || digits.count == 8,
                  digits.allSatisfy({ $0.isASCII && $0.isHexDigit })
            else {
                return neutralAccentHex
            }
            return "#" + digits
        }
    }

    var assistantName: String

    /// When the session's activity was requested, so the presentations can run
    /// a live elapsed timer.
    ///
    /// **Stamped natively, at `request`, on purpose.** SwiftUI's
    /// `Text(timerInterval:)` is driven by the system, so a timer costs zero
    /// ActivityKit updates: it is the one thing on the island that keeps
    /// moving while a suspended web layer pushes nothing, which is exactly when
    /// the user is looking at it. Reading the clock here rather than accepting
    /// a timestamp from the web side (or from a server push, which composes
    /// content state on a different machine) also means the value is on the
    /// same clock as the device rendering it, so there is no skew to show.
    ///
    /// An attribute, not `ContentState`: it is fixed for the activity's
    /// lifetime. Being an attribute is also what makes it survive the push
    /// path, since a server-driven update replaces the content state wholesale
    /// and cannot touch it.
    ///
    /// Optional on the wire (see the decoder below) even though it is always
    /// set for an activity this build requests.
    var startedAt: Date

    /// The assistant's avatar as encoded image data (PNG, or JPEG for
    /// photographic uploads), or `nil` when there is none to show.
    ///
    /// An attribute rather than `ContentState` because it is fixed for the
    /// activity's lifetime: it travels once, at `request`, and never through
    /// an update. `ContentState` is re-sent on every phase change, and
    /// ActivityKit rate-limits updates, so image bytes on that path would
    /// exhaust the budget `use-live-activity-mirror.ts` protects.
    ///
    /// **The bytes travel because the extension cannot fetch them.** A Live
    /// Activity renders from a snapshot with no async image loading, so a URL
    /// would only ever draw a placeholder. That is also why this is not an App
    /// Group: a shared container solves file *sharing*, and nothing here needs
    /// a file.
    ///
    /// Kept small by `encodeAvatarForIsland`, which scales and re-encodes until
    /// it fits a measured budget. The real ceiling is far below the 4KB Apple
    /// documents for attributes plus content state: 3366 bytes threw
    /// `attributesTooLarge` on an iPhone 17 Pro simulator while 1997 rendered.
    /// Oversize does not degrade the avatar, it kills the whole activity, so
    /// the web side sends nothing rather than sending too much.
    var avatarImageData: Data?
}

extension VoiceSessionAttributes {
    /// Decodes attributes archived by *any* build that has run on this device.
    ///
    /// An activity outlives the app update that replaces the code rendering
    /// it: a session started before the update is still on screen after it,
    /// and its attributes were archived without whatever fields the new build
    /// added. Synthesized decoding treats a missing field as a failure, and a
    /// `VoiceSessionAttributes` that cannot decode is one ActivityKit cannot
    /// hand back at all, so the activity becomes unrenderable *and* invisible
    /// to `endActivitiesStrandedByAPreviousLaunch()`. The user is left with an
    /// island nothing can reach or dismiss.
    ///
    /// Every field added from here on therefore decodes with a fallback.
    /// `startedAt` falling back to now restarts the elapsed count for such an
    /// activity, which is the right trade: a stale count on an activity that
    /// is about to be swept, instead of an island that cannot be swept.
    ///
    /// Written in an extension so the memberwise initializer the plugin calls
    /// survives.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            assistantName: try container.decode(String.self, forKey: .assistantName),
            startedAt: try container.decodeIfPresent(Date.self, forKey: .startedAt)
                ?? Date(),
            avatarImageData: try container.decodeIfPresent(
                Data.self,
                forKey: .avatarImageData
            )
        )
    }
}
