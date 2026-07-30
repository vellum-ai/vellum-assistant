import SwiftUI
import UIKit

// Shared building blocks for the live-voice Live Activity.
//
// The Lock Screen, expanded, compact and minimal presentations are four
// separately-sized renderings of the *same* three facts — accent, phase
// label, assistant name — so they compose from these primitives rather than
// each growing its own copy that drifts.
//
// Two rules run through all of them:
//
// 1. **No native phase copy.** Every user-facing string here is either
//    `ContentState.label` or `VoiceSessionAttributes.assistantName`, both
//    passed through from the web side. `LIVE_VOICE_STATE_LABELS` /
//    `liveVoiceSurfaceLabel` in `live-voice-store.ts` own the wording — this
//    shell ships on App Store cadence while that copy deploys continuously,
//    so a native `switch` over `phase` would fossilize old strings. Tight
//    slots truncate the passed label; they never substitute a shorter native
//    one.
// 2. **Accent is decoration, never the carrier.** `accentHex` is the user's
//    avatar color and can be any brightness, while the Lock Screen renders
//    over a wallpaper in either appearance. Text is therefore always
//    `.primary`/`.secondary`, which adapts; the accent only fills shapes that
//    carry a hairline `.primary` border so their edge stays visible whatever
//    is behind them.

extension VoiceSessionAttributes.ContentState {
    /// The avatar accent as a SwiftUI color.
    ///
    /// `accentHex` is canonicalized on the way in — including through
    /// `init(from:)`, so it survives decoding into this extension — to a form
    /// `UIColor(cssHex:)` accepts. The final fallback is unreachable in
    /// practice and exists only so this stays non-optional.
    var accentColor: Color {
        Color(cssHex: accentHex)
            ?? Color(cssHex: Self.neutralAccentHex)
            ?? .secondary
    }

    /// The phase label to render, or nothing once ActivityKit has marked the
    /// content stale.
    ///
    /// Staleness means the app stopped pushing updates before this state's
    /// `staleDate` (`VoiceLiveActivityPlugin.contentStaleAfter`). For a session
    /// driven entirely by a web view that iOS may have suspended, that is far
    /// more likely to mean "wedged" than "still genuinely listening" — and the
    /// phase wording is the one thing on the island that can be *wrong*, so it
    /// is what drops. The assistant name and accent stay: a session with this
    /// assistant does exist, and tapping through still returns to it.
    func displayLabel(isStale: Bool) -> String {
        isStale ? "" : label
    }
}

/// The accent-tinted state indicator: a waveform, tinted with the avatar
/// accent. Small enough to be the entire content of the minimal presentation
/// and of the compact leading slot.
struct VoiceAccentGlyph: View {
    let accent: Color
    var scale: Image.Scale = .medium

    var body: some View {
        Image(systemName: "waveform")
            .imageScale(scale)
            .foregroundStyle(accent)
            .accessibilityHidden(true)
    }
}

/// The assistant's avatar at a given size.
///
/// Takes an already-decoded image so each slot decides its own fallback: the
/// roomy layouts substitute an accent-filled badge, the tight ones a bare
/// glyph. Decoding is the only image work done here, because the bytes arrive
/// already sized and encoded from the web side, and a Live Activity cannot
/// fetch or resize anything at render time.
///
/// **Deliberately neither cropped to a circle nor bordered.** A character
/// avatar is a shaped creature on a transparent background whose silhouette
/// runs out to the edges of its square, so a circular mask cuts the edges off
/// and a ring drawn around it frames empty space. `scaledToFit` keeps the whole
/// silhouette, and the alpha the PNG rungs preserve is what lets it sit
/// directly on the island.
///
/// The cost is a custom *uploaded* avatar, which is square and would look
/// tidier masked. Distinguishing them would mean sending the avatar kind across
/// the bridge; the shaped creature is the default and the common case, so it
/// wins the single treatment until that is worth the plumbing.
struct VoiceAvatarImage: View {
    let image: UIImage
    var diameter: CGFloat

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }
}

/// Decode the avatar attribute, or `nil` when there is none and when the bytes
/// do not form an image. A payload that fails to decode is treated exactly
/// like an absent one: the slot falls back to its accent treatment rather than
/// rendering a gap.
func voiceAvatarImage(_ data: Data?) -> UIImage? {
    guard let data else { return nil }
    return UIImage(data: data)
}

/// The assistant's avatar for the roomier Lock Screen and expanded layouts,
/// falling back to the accent glyph as a filled badge.
///
/// In the fallback the glyph is black or white by the accent's own luminance
/// so it is legible on any avatar color, and the hairline border is `.primary`
/// so the badge's edge reads against a light *and* a dark Lock Screen.
struct VoiceAccentBadge: View {
    let accent: Color
    var avatarImageData: Data?

    var body: some View {
        if let image = voiceAvatarImage(avatarImageData) {
            VoiceAvatarImage(image: image, diameter: 34)
        } else {
            VoiceAccentGlyph(accent: accent.contrastingForeground)
                .frame(width: 34, height: 34)
                .background(accent, in: Circle())
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
        }
    }
}

/// The identity mark for the two tightest slots, the compact leading and the
/// minimal presentation: the avatar if there is one, the accent waveform if
/// not.
///
/// Sized rather than left to the slot because these are the only presentations
/// iOS renders inline with the status bar, where an unconstrained image would
/// be laid out against the whole island rather than its own corner.
struct VoiceCompactIdentity: View {
    let accent: Color
    var avatarImageData: Data?

    var body: some View {
        if let image = voiceAvatarImage(avatarImageData) {
            VoiceAvatarImage(image: image, diameter: 20)
        } else {
            VoiceAccentGlyph(accent: accent, scale: .small)
        }
    }
}

/// Mute indicator, shown only while the session is muted. Not accent-tinted:
/// this is a status the user must be able to read at a glance regardless of
/// their avatar color.
struct VoiceMuteGlyph: View {
    var body: some View {
        Image(systemName: "mic.slash.fill")
            .imageScale(.small)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Muted")
    }
}

/// The one text primitive: a single passed-through line — the phase label or
/// the assistant name — sized for whichever slot it lands in.
///
/// Always one line with a tail ellipsis. The web side decides how long the
/// string is, so the tight slots shorten what they were given instead of
/// substituting a native string of their own. Every phase that reaches an
/// activity has a non-empty label (`LIVE_VOICE_STATE_LABELS` maps only the
/// phases with no activity to `""`), and the plugin rejects an empty
/// `assistantName`, so there is no empty-string case to special-case.
struct VoiceSessionText: View {
    let text: String
    var font: Font = .subheadline
    var color: HierarchicalShapeStyle = .primary

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

/// Lock Screen and notification-banner presentation: badge, assistant name,
/// phase label, and a mute glyph while muted.
///
/// No `activityBackgroundTint` — the system background already adapts to the
/// Lock Screen's appearance, and tinting it with an arbitrary avatar color is
/// exactly how the label text stops being readable in one of the two modes.
struct VoiceSessionLockScreenView: View {
    let assistantName: String
    let state: VoiceSessionAttributes.ContentState
    /// Whether ActivityKit considers this content out of date; drops the phase
    /// label. See `ContentState.displayLabel(isStale:)`.
    let isStale: Bool
    var avatarImageData: Data?

    var body: some View {
        HStack(spacing: 12) {
            VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatarImageData)
            VStack(alignment: .leading, spacing: 2) {
                VoiceSessionText(text: assistantName, font: .headline)
                VoiceSessionText(text: state.displayLabel(isStale: isStale), color: .secondary)
            }
            Spacer(minLength: 0)
            if state.muted {
                VoiceMuteGlyph()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
