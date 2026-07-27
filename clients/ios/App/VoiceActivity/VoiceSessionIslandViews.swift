import SwiftUI

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
//    `liveVoiceStateLabel` in `live-voice-store.ts` own the wording — this
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
}

/// Deep link back into the running session.
///
/// `mode=resume` is the web-side contract: it foregrounds the app into the
/// live voice room, falling through to starting a fresh session if the app was
/// killed and the session no longer exists.
enum VoiceSessionDeepLink {
    /// Built from *this* build's own scheme, so a Dev island opens the Dev app
    /// even with production installed.
    static let resume = URL(string: "\(BundleURLScheme.current)://voice?mode=resume")
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

/// The accent glyph as a filled badge, for the roomier Lock Screen and
/// expanded layouts.
///
/// The glyph is black or white by the accent's own luminance so it is legible
/// on any avatar color, and the hairline border is `.primary` so the badge's
/// edge reads against a light *and* a dark Lock Screen.
struct VoiceAccentBadge: View {
    let accent: Color

    var body: some View {
        VoiceAccentGlyph(accent: accent.contrastingForeground)
            .frame(width: 34, height: 34)
            .background(accent, in: Circle())
            .overlay(Circle().strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
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
/// substituting a native string of their own.
///
/// Empty text renders nothing at all rather than an empty `Text` that still
/// claims layout space: `LIVE_VOICE_STATE_LABELS` maps `failed` to `""`, and a
/// blank line would leave a lopsided gap.
struct VoiceSessionText: View {
    let text: String
    var font: Font = .subheadline
    var color: HierarchicalShapeStyle = .primary

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(font)
                .foregroundStyle(color)
                .lineLimit(1)
                .truncationMode(.tail)
        }
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

    var body: some View {
        HStack(spacing: 12) {
            VoiceAccentBadge(accent: state.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                VoiceSessionText(text: assistantName, font: .headline)
                VoiceSessionText(text: state.label, color: .secondary)
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
