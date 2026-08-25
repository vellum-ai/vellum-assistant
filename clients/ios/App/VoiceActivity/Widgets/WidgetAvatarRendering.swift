import SwiftUI
import UIKit
import WidgetKit

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

    /// The pupil's box and where it sits in the white, as shares of eye
    /// height. It fills most of the eye and presses against the right edge,
    /// which is the whole trick: small centered dots read as punctuation, a
    /// heavy sideways pair reads as a face caught mid-glance.
    ///
    /// Readable to the rest of the file because ``AvatarEyeCutoutShape`` has to
    /// place the same box, and a hole drawn from a second set of numbers is a
    /// hole that stops matching the pupil it stands in for.
    fileprivate static let pupilWidthRatio: CGFloat = 18.0 / 33.0
    fileprivate static let pupilHeightRatio: CGFloat = 21.5 / 33.0
    fileprivate static let pupilOffsetXRatio: CGFloat = 9.0 / 33.0
    fileprivate static let pupilOffsetYRatio: CGFloat = 6.5 / 33.0

    /// The height the pair is drawn at where the card has room for it.
    static let defaultEyeHeight: CGFloat = 33

    /// The pair's width as a share of its height: two eyes and the gap between
    /// them. Published because a card fitting the pair beside something else
    /// picks a height and has to know how wide that comes out.
    static let pairAspect: CGFloat = widthRatio * 2 + gapRatio

    var eyeHeight: CGFloat = WidgetAvatarEyes.defaultEyeHeight

    @Environment(\.widgetRenderingMode) private var renderingMode

    /// Whether the system is drawing the widget in one of its monochrome modes:
    /// a themed Home Screen, StandBy, or the lock screen. See the note on
    /// ``cutoutEye``.
    private var isFlattened: Bool { renderingMode != .fullColor }

    var body: some View {
        HStack(spacing: eyeHeight * Self.gapRatio) {
            eye
            eye
        }
        .accessibilityHidden(true)
    }

    /// The face is drawn two different ways for one reason: a dark pupil laid
    /// over a light white is a pair of colors, and a flattened widget has no
    /// colors to lay over each other.
    @ViewBuilder
    private var eye: some View {
        if isFlattened {
            cutoutEye
        } else {
            layeredEye
        }
    }

    /// The eye as one figure with the pupil punched out of it.
    ///
    /// WidgetKit's flattened modes redraw every view in one of two monochrome
    /// groups and keep only its alpha, so the sclera and the pupil come out the
    /// same white and the face loses its gaze entirely. Filling both paths as a
    /// single even-odd figure gives the pupil back as a hole, and the dark card
    /// the system substitutes for the widget's own shows through it, which is
    /// the one dark the extension is still allowed.
    private var cutoutEye: some View {
        AvatarEyeCutoutShape()
            .fill(WidgetTheme.avatarSclera, style: FillStyle(eoFill: true))
            .frame(width: eyeHeight * Self.widthRatio, height: eyeHeight)
    }

    /// The eye as the compositor draws it: a real pupil in its real color, on
    /// its own layer. A hole would be wrong here, since what shows through is
    /// the assistant's accent rather than anything a pupil should be.
    private var layeredEye: some View {
        AvatarEyeScleraShape()
            .fill(WidgetTheme.avatarSclera)
            .frame(width: eyeHeight * Self.widthRatio, height: eyeHeight)
            .overlay(alignment: .topLeading) {
                AvatarEyePupilShape()
                    .fill(WidgetTheme.avatarPupil)
                    .frame(
                        width: eyeHeight * Self.pupilWidthRatio,
                        height: eyeHeight * Self.pupilHeightRatio
                    )
                    .offset(
                        x: eyeHeight * Self.pupilOffsetXRatio,
                        y: eyeHeight * Self.pupilOffsetYRatio
                    )
            }
    }
}

/// The white of one eye: a hand-drawn egg rather than a true ellipse, its long
/// axis tilted a few degrees, traced from the character mark the product draws
/// so the widget's stand-in is recognizably the same face. Control points are
/// in the 28x33 box the mark is designed in and scale with the rect.
private struct AvatarEyeScleraShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width / 28
        let h = rect.height / 33
        var path = Path()
        path.move(to: CGPoint(x: 13.34 * w, y: 0.02 * h))
        path.addCurve(
            to: CGPoint(x: 27.98 * w, y: 15.71 * h),
            control1: CGPoint(x: 21.06 * w, y: -0.41 * h),
            control2: CGPoint(x: 27.61 * w, y: 6.61 * h)
        )
        path.addCurve(
            to: CGPoint(x: 14.69 * w, y: 32.98 * h),
            control1: CGPoint(x: 28.36 * w, y: 24.80 * h),
            control2: CGPoint(x: 22.41 * w, y: 32.53 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.02 * w, y: 17.30 * h),
            control1: CGPoint(x: 6.96 * w, y: 33.43 * h),
            control2: CGPoint(x: 0.39 * w, y: 26.40 * h)
        )
        path.addCurve(
            to: CGPoint(x: 13.34 * w, y: 0.02 * h),
            control1: CGPoint(x: -0.36 * w, y: 8.19 * h),
            control2: CGPoint(x: 5.61 * w, y: 0.45 * h)
        )
        path.closeSubpath()
        return path
    }
}

/// The pupil, the same egg at a steeper tilt, in its own 18x21 design box.
private struct AvatarEyePupilShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width / 18
        let h = rect.height / 21
        var path = Path()
        path.move(to: CGPoint(x: 7.77 * w, y: 0.10 * h))
        path.addCurve(
            to: CGPoint(x: 17.92 * w, y: 9.09 * h),
            control1: CGPoint(x: 12.70 * w, y: -0.70 * h),
            control2: CGPoint(x: 17.25 * w, y: 3.33 * h)
        )
        path.addCurve(
            to: CGPoint(x: 10.18 * w, y: 20.91 * h),
            control1: CGPoint(x: 18.59 * w, y: 14.85 * h),
            control2: CGPoint(x: 15.12 * w, y: 20.14 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.08 * w, y: 11.91 * h),
            control1: CGPoint(x: 5.27 * w, y: 21.67 * h),
            control2: CGPoint(x: 0.75 * w, y: 17.64 * h)
        )
        path.addCurve(
            to: CGPoint(x: 7.77 * w, y: 0.10 * h),
            control1: CGPoint(x: -0.58 * w, y: 6.17 * h),
            control2: CGPoint(x: 2.85 * w, y: 0.89 * h)
        )
        path.closeSubpath()
        return path
    }
}

/// Both eye paths in one figure: the white, and the pupil inside it, for a
/// caller that fills them even-odd so the pupil comes out as a hole.
///
/// It composes the same two shapes rather than redrawing either, and it places
/// the pupil from ``WidgetAvatarEyes``' own ratios, so the hole lands exactly
/// where the layered rendering paints the pupil and the two treatments stay the
/// same face.
private struct AvatarEyeCutoutShape: Shape {
    func path(in rect: CGRect) -> Path {
        // Every ratio is a share of eye height, which is this rect's height:
        // the pupil is sized and placed against the eye's own scale, the way
        // the layered rendering sizes and offsets it.
        let eyeHeight = rect.height
        let pupilSize = CGSize(
            width: eyeHeight * WidgetAvatarEyes.pupilWidthRatio,
            height: eyeHeight * WidgetAvatarEyes.pupilHeightRatio
        )
        // Both shapes trace from their box's own top-left and neither reads its
        // rect's origin, so the pupil is drawn at zero and moved into place
        // rather than handed an offset rect it would ignore.
        let pupil = AvatarEyePupilShape()
            .path(in: CGRect(origin: .zero, size: pupilSize))
            .offsetBy(
                dx: rect.minX + eyeHeight * WidgetAvatarEyes.pupilOffsetXRatio,
                dy: rect.minY + eyeHeight * WidgetAvatarEyes.pupilOffsetYRatio
            )
        var path = AvatarEyeScleraShape().path(in: rect)
        path.addPath(pupil)
        return path
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

    /// The photo is told how to survive a flattened widget before anything else
    /// is done to it.
    ///
    /// Left alone, WidgetKit resolves a bitmap in those modes by its luminance
    /// and hands back a silhouette: a face becomes a blob. Asking for a
    /// desaturated accent keeps the picture's own shading and only drains its
    /// color, which is the difference between a mark someone recognizes and one
    /// they do not. It changes nothing in full color, where the mode is never
    /// consulted.
    ///
    /// The modifier arrived in iOS 18 and this extension still runs on 17,
    /// where the plain image is the only option and the silhouette is what that
    /// OS was always going to draw. The availability branch wraps the whole
    /// chain rather than the image alone, so `scaledToFill` reads its ratio off
    /// the photo directly instead of through a conditional in between.
    @ViewBuilder
    var body: some View {
        if #available(iOS 18.0, *) {
            shaped(Image(uiImage: image).resizable().widgetAccentedRenderingMode(.accentedDesaturated))
        } else {
            shaped(Image(uiImage: image).resizable())
        }
    }

    /// Everything the mark's slot asks of the photo: filled to the slot,
    /// clipped to its corner, and redacted on a locked device.
    private func shaped(_ photo: some View) -> some View {
        photo
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

/// The same content as a flattened widget draws it, for the previews checking
/// what a themed Home Screen does to a card.
///
/// Only half the story, and deliberately so: setting the environment key runs
/// the flattened code paths, but the canvas cannot perform the recoloring
/// WidgetKit does afterwards. What a preview like this proves is that the
/// translucent fills and the cut-out pupils are drawn at all; how they come out
/// once the system has tinted them takes a device.
func previewFlattened<Content: View>(
    @ViewBuilder _ content: @escaping () -> Content
) -> some View {
    content()
        .environment(\.widgetRenderingMode, .accented)
        .padding(12)
        .background(Color.black)
        .padding()
}

/// The ground a flattened preview stands its card on, in place of the dark
/// material WidgetKit substitutes for a widget's own background in these modes.
///
/// A preview that kept painting the accent would be checking the fills against
/// a surface the device is not going to draw, and the pupil holes would show
/// teal rather than the dark they are cut to reveal.
let previewFlattenedGround = Color(white: 0.13)

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
///
/// Staleness is a parameter because the cards disagree about what it costs
/// them: it drops a count and keeps an avatar, so a preview is the only place
/// the two are visible side by side.
func previewEntry(
    unread: Int = 0,
    inProgress: Int = 0,
    avatar: WidgetSnapshotAvatar? = nil,
    isStale: Bool = false
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
        isStale: isStale
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

#Preview("Flattened") {
    // The eyes are the thing to look at: the pupils have to be holes the ground
    // shows through rather than a second white laid on the first.
    previewFlattened {
        previewWidgetCard(width: 150, height: 150) {
            WidgetAvatarEyes(eyeHeight: 42)
        } background: {
            previewFlattenedGround
        }
    }
}

#endif
