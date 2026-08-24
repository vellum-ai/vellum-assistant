import SwiftUI
import UIKit

// Everything a Vellum Home Screen widget needs to draw the user's own
// assistant rather than a fixed brand mark: the colors derived from its
// accent, the eyes, the avatar image, and the blurred photo card a custom
// avatar sits on. They live together because a widget that themed itself would
// theme itself slightly differently from the next one.

/// What a widget can do with the snapshot's avatar, as the three treatments it
/// actually has rather than as the string the payload carries.
///
/// Anything unrecognized reads as ``none``, matching the payload's own
/// contract: an avatar this build cannot draw costs the widget its theming and
/// nothing else.
enum WidgetAvatarKind {
    /// A composed character: an accent color, and a raster of its face.
    case character
    /// An uploaded photo. Carries no accent by design, so the card blurs the
    /// photo instead of tinting itself with a color extracted from it.
    case image
    /// No avatar to draw. The static brand palette stands in.
    case none

    init(snapshotKind: String?) {
        switch snapshotKind {
        case "character":
            self = .character
        case "image":
            self = .image
        default:
            self = .none
        }
    }
}

/// The colors a widget card painted with an avatar accent draws from.
///
/// One hex arrives in the snapshot and the rest is derived, because the
/// extension is handed a single color and needs a card, a foreground that
/// survives it, and a control fill that reads as cut out of it rather than
/// placed on top. The foreground follows the surface's own luminance: a yellow
/// avatar and a deep green one both have to produce a legible card, which a
/// fixed white cannot.
///
/// Both appearances are resolved up front and handed over as dynamic colors.
/// The foreground has to contrast with whichever surface is actually drawn,
/// and asking a trait-less color what it looks like answers for only one of
/// them.
struct WidgetAvatarPalette {
    /// Factor deepening an accent for dark appearance, so a saturated card is
    /// not the brightest thing on a dark Home Screen. Calibrated on the brand
    /// green: it turns ``WidgetTheme/brandCardSurface``'s light `#0E9B8B` into
    /// exactly the `#0B7A6E` it was hand-picked to pair with, so the derived
    /// palette and the static one agree wherever they overlap.
    private static let darkSurfaceFactor = 0.79

    /// The card behind everything.
    let surface: Color

    /// Glyphs and text drawn on ``surface``.
    let onSurface: Color

    /// ``onSurface`` resolved for each appearance, so a card mixing its own
    /// fill can ask how bright the color it would be washing with is.
    private let resolvedOnSurface: (light: UIColor, dark: UIColor)

    /// The palette for an avatar accent, or the static brand card when there
    /// is no accent to work from and when the one on offer is unreadable.
    init(accentHex: String?) {
        guard let accentHex,
              let canonical = canonicalCSSHex(accentHex),
              let parsed = UIColor(cssHex: canonical),
              let dark = UIColor(cssHex: darkenHex(canonical, Self.darkSurfaceFactor))
        else {
            surface = WidgetTheme.brandCardSurface
            onSurface = WidgetTheme.onBrand
            // The brand card is a deep green in both appearances, so what sits
            // on it is white in both.
            resolvedOnSurface = (.white, .white)
            return
        }
        // A card surface is opaque by definition. An 8-digit accent keeps its
        // alpha through the parser while the darkened variant drops it, so the
        // light side is squared with the dark side here.
        let light = parsed.withAlphaComponent(1)
        let lightOn = light.contrastingForeground
        let darkOn = dark.contrastingForeground
        surface = WidgetTheme.appearanceDynamic(light: light, dark: dark)
        onSurface = WidgetTheme.appearanceDynamic(light: lightOn, dark: darkOn)
        resolvedOnSurface = (lightOn, darkOn)
    }

    /// A control's fill on ``surface``: ``onSurface`` at the weight the caller
    /// picks, so the action circles and the chip read as cut out of the card
    /// rather than as a second color placed on top of it.
    ///
    /// Two weights rather than one because ``onSurface`` comes out white over
    /// some accents and near-black over others, and one opacity does not read
    /// the same both ways: a white wash lifts a dark card further than a black
    /// wash deepens a light one.
    func controlFill(onWhite: Double, onDark: Double) -> Color {
        WidgetTheme.appearanceDynamic(
            light: weighted(resolvedOnSurface.light, onWhite: onWhite, onDark: onDark),
            dark: weighted(resolvedOnSurface.dark, onWhite: onWhite, onDark: onDark)
        )
    }

    private func weighted(_ color: UIColor, onWhite: Double, onDark: Double) -> UIColor {
        var brightness: CGFloat = 0
        var alpha: CGFloat = 0
        color.getWhite(&brightness, alpha: &alpha)
        return color.withAlphaComponent(brightness > 0.5 ? onWhite : onDark)
    }
}

/// The assistant's eyes, drawn straight onto the card behind them.
///
/// Shapes rather than a bitmap: they stay sharp at every scale and on every
/// display, and they cost the extension no asset. The face's raster travels in
/// the snapshot for the slots that show the whole avatar, but a card whose
/// background *is* the avatar's color wants the eyes alone on it, with nothing
/// boxed around them.
///
/// Sized from one number so a widget places the pair by picking its height:
/// each eye is 28x33 at the default, and the pair is 61 wide.
struct WidgetAvatarEyes: View {
    /// Width of one eye, as a share of its height.
    private static let widthRatio: CGFloat = 28.0 / 33.0

    /// Gap between the two, as a share of eye height.
    private static let gapRatio: CGFloat = 5.0 / 33.0

    /// Pupil diameter and how far it sits off the bottom of the white, both as
    /// a share of eye height. Pupils sit low, which is the whole trick:
    /// centered dots read as punctuation, low ones read as a face looking back.
    private static let pupilRatio: CGFloat = 0.41
    private static let pupilInsetRatio: CGFloat = 0.18

    /// The height the pair is drawn at where the card has room for it.
    static let defaultEyeHeight: CGFloat = 33

    /// The pair's width as a share of its height: two eyes and the gap between
    /// them. Published because a card fitting the pair beside something else
    /// picks a height and has to know how wide that comes out.
    static let pairAspect: CGFloat = widthRatio * 2 + gapRatio

    var eyeHeight: CGFloat = WidgetAvatarEyes.defaultEyeHeight

    var body: some View {
        HStack(spacing: eyeHeight * Self.gapRatio) {
            eye
            eye
        }
        .accessibilityHidden(true)
    }

    private var eye: some View {
        Ellipse()
            .fill(WidgetTheme.avatarSclera)
            .frame(width: eyeHeight * Self.widthRatio, height: eyeHeight)
            .overlay(alignment: .bottom) {
                Circle()
                    .fill(WidgetTheme.avatarPupil)
                    .frame(width: eyeHeight * Self.pupilRatio, height: eyeHeight * Self.pupilRatio)
                    .padding(.bottom, eyeHeight * Self.pupilInsetRatio)
            }
    }
}

/// The avatar itself, from the raster the snapshot carries.
///
/// Filled rather than fitted, and clipped, because every slot that shows this
/// is a mark of a known size in a laid-out card: a photo letterboxed inside its
/// slot would leave the card with a hole the size of the difference. `nil`
/// corner radius clips to a circle.
///
/// `.privacySensitive()` because it is the user's own avatar and a widget draws
/// on a locked device.
struct WidgetAvatarImageView: View {
    let image: UIImage
    let size: CGFloat
    var cornerRadius: CGFloat? = nil

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius ?? size / 2, style: .continuous))
            .privacySensitive()
            .accessibilityHidden(true)
    }
}

/// The card behind a custom avatar: the photo, blurred past recognition, under
/// a scrim deep enough that anything drawn on top stays legible.
///
/// This is the treatment the takeover backdrop and the identity page already
/// give the same picture, at the same blur and the same scrim, so a custom
/// avatar looks like itself everywhere it appears.
///
/// Deliberately not `.privacySensitive()`: the blur has already destroyed every
/// detail a redaction would be protecting, and redacting the card's own ground
/// would blank the widget rather than protect anything. The marks drawn on top
/// carry the redaction.
struct BlurredAvatarBackground: View {
    private static let blurRadius: CGFloat = 30
    private static let scrimOpacity = 0.55

    /// The blur samples transparency past the layer's edge, so the photo grows
    /// beyond the card by twice the radius per side before blurring and the
    /// clip trims the excess; otherwise the perimeter fades into the ground.
    private static let overscan: CGFloat = blurRadius * 2

    /// The near-black under the photo, and the whole card when there is no
    /// photo to blur. Hue-neutral, which is all an uploaded photo can offer: it
    /// carries no accent by design. `SURFACE_GROUND` in
    /// `clients/web/src/utils/avatar-tone.ts`.
    private static let groundHex = "#151515"

    /// The photo, absent when the snapshot carries none and when its bytes do
    /// not form an image. Both fall through to the ground below, which is what
    /// makes this safe to hand a card's whole background to.
    let image: UIImage?

    var body: some View {
        ground
            .overlay {
                if let image {
                    GeometryReader { geo in
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(
                                width: geo.size.width + Self.overscan * 2,
                                height: geo.size.height + Self.overscan * 2
                            )
                            .position(
                                x: geo.size.width / 2,
                                y: geo.size.height / 2
                            )
                            .blur(radius: Self.blurRadius)
                    }
                    .overlay { Color.black.opacity(Self.scrimOpacity) }
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }

    private var ground: Color {
        Color(cssHex: Self.groundHex) ?? .black
    }
}

extension SnapshotEntry {
    /// Which of the three avatar treatments this rendering calls for.
    ///
    /// Not gated on ``isStale``. Staleness drops claims about what is happening
    /// right now; which assistant the account belongs to is not one of them,
    /// and a card that changed color half an hour after the phone was last
    /// unlocked would be the widget lying about something it does know.
    var avatarKind: WidgetAvatarKind {
        let kind = WidgetAvatarKind(snapshotKind: snapshot?.avatar?.kind)
        if kind == .image && avatarImage == nil {
            // An image avatar whose bytes were dropped for budget or fail to
            // decode has no photo to blur; the brand fallback stands in.
            return .none
        }
        return kind
    }

    /// The avatar's raster, decoded. `nil` for an avatar carrying none and for
    /// bytes that do not form an image; every widget draws both the same way.
    var avatarImage: UIImage? {
        snapshot?.avatar?.imageData.flatMap(UIImage.init(data:))
    }

    /// The accent this rendering themes itself with, or `nil` to keep the
    /// static tokens.
    ///
    /// The one owner of the rule that only a character avatar carries an
    /// accent: an uploaded photo has none by design, an account with nothing
    /// synced has none to read, and any other kind keeps the static palette
    /// even if a malformed or newer-schema snapshot carries an accent
    /// alongside it. Both palettes below read the gate from here so a card and
    /// the controls on it cannot disagree about which accounts are themed.
    var themeAccentHex: String? {
        guard avatarKind == .character else {
            return nil
        }
        return snapshot?.avatar?.accentHex
    }

    /// The colors to paint a full-bleed card with, already fallen back to the
    /// static brand card when there is no accent.
    var avatarPalette: WidgetAvatarPalette {
        WidgetAvatarPalette(accentHex: themeAccentHex)
    }

    /// The wash theming a New Chat surface on a light card, already fallen back
    /// to the static tokens when there is no accent.
    var softAccent: WidgetSoftAccent {
        WidgetSoftAccent(accentHex: themeAccentHex)
    }
}

#if DEBUG

/// A card built out of the whole kit, so a preview shows the palette holding up
/// under the things actually drawn on it rather than three color swatches.
private struct WidgetAvatarKitPreviewCard: View {
    let title: String
    let palette: WidgetAvatarPalette

    var body: some View {
        previewWidgetCard(width: 150, height: 150) {
            VStack(spacing: 10) {
                WidgetAvatarEyes(eyeHeight: 26)
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(palette.onSurface)
                HStack(spacing: 8) {
                    controlCircle("camera.fill")
                    controlCircle("waveform")
                }
            }
        } background: {
            palette.surface
        }
    }

    private func controlCircle(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 15))
            .foregroundStyle(palette.onSurface)
            .frame(width: 38, height: 38)
            .background(palette.controlFill(onWhite: 0.14, onDark: 0.10), in: Circle())
    }
}

/// The same content in both appearances, side by side: every value in this file
/// resolves per appearance, so a preview showing one of them is half a preview.
///
/// Shared with the widgets built out of the kit, which have the same problem.
func previewAppearances<Content: View>(
    @ViewBuilder _ content: @escaping () -> Content
) -> some View {
    HStack(spacing: 16) {
        ForEach([ColorScheme.light, ColorScheme.dark], id: \.self) { scheme in
            content()
                .padding(12)
                .background(scheme == .dark ? Color.black : Color(white: 0.92))
                .environment(\.colorScheme, scheme)
        }
    }
    .padding()
}

/// A stand-in photo, drawn rather than shipped so the previews cost the
/// extension no asset. Shared with the widgets built out of the kit.
func previewAvatarPhoto() -> UIImage {
    let size = CGSize(width: 120, height: 120)
    return UIGraphicsImageRenderer(size: size).image { context in
        (UIColor(cssHex: "#3B6EA5") ?? .systemBlue).setFill()
        context.fill(CGRect(origin: .zero, size: size))
        (UIColor(cssHex: "#E8B04B") ?? .systemOrange).setFill()
        context.cgContext.fillEllipse(in: CGRect(x: 22, y: 26, width: 76, height: 76))
    }
}

/// A card at the size a widget is drawn at, clipped the way the system clips
/// one, so a preview shows a layout landing on its own margins rather than a
/// view floating in a canvas.
///
/// The background is the caller's: one widget paints the flat surface token and
/// the next paints the avatar over the widget's whole bounds.
func previewWidgetCard<Content: View, Background: View>(
    width: CGFloat = 161,
    height: CGFloat = 161,
    @ViewBuilder content: () -> Content,
    @ViewBuilder background: () -> Background
) -> some View {
    content()
        .frame(width: width, height: height)
        .background { background() }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
}

/// A snapshot carrying exactly what a preview needs to say: the two counts and
/// the avatar. Shared with the widgets built out of the kit, none of which
/// previews a conversation list.
func previewEntry(
    unread: Int = 0,
    inProgress: Int = 0,
    avatar: WidgetSnapshotAvatar? = nil
) -> SnapshotEntry {
    SnapshotEntry(
        date: Date(),
        snapshot: WidgetSnapshot(
            schemaVersion: WidgetSnapshot.currentSchemaVersion,
            generatedAt: Date(),
            unreadCount: unread,
            inProgressCount: inProgress,
            conversations: [],
            avatar: avatar
        ),
        isStale: false
    )
}

#Preview("Character accents") {
    previewAppearances {
        HStack(spacing: 12) {
            WidgetAvatarKitPreviewCard(
                title: "Teal",
                palette: WidgetAvatarPalette(accentHex: "#0E9B8B")
            )
            // The light one: its on-colors have to come out dark, or the card
            // is white text on yellow.
            WidgetAvatarKitPreviewCard(
                title: "Yellow",
                palette: WidgetAvatarPalette(accentHex: "#F2C94C")
            )
        }
    }
}

#Preview("Custom image") {
    let photo = previewAvatarPhoto()
    previewAppearances {
        previewWidgetCard(width: 150, height: 150) {
            WidgetAvatarImageView(image: photo, size: 44, cornerRadius: 14)
        } background: {
            BlurredAvatarBackground(image: photo)
        }
    }
}

#Preview("No avatar") {
    previewAppearances {
        WidgetAvatarKitPreviewCard(
            title: "Fallback",
            palette: WidgetAvatarPalette(accentHex: nil)
        )
    }
}

#endif
