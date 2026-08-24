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

    /// Opacity a control's fill sits at on the card, matching
    /// ``WidgetTheme/onBrandFill``.
    private static let controlFillOpacity = 0.22

    /// The card behind everything.
    let surface: Color

    /// Glyphs and text drawn on ``surface``.
    let onSurface: Color

    /// A control's fill on ``surface``: ``onSurface`` at low opacity.
    let controlFill: Color

    /// The palette for an avatar accent, or the static brand card when there
    /// is no accent to work from and when the one on offer is unreadable.
    init(accentHex: String?) {
        guard let accentHex,
              let canonical = canonicalCSSHex(accentHex),
              let light = UIColor(cssHex: canonical),
              let dark = UIColor(cssHex: darkenHex(canonical, Self.darkSurfaceFactor))
        else {
            surface = WidgetTheme.brandCardSurface
            onSurface = WidgetTheme.onBrand
            controlFill = WidgetTheme.onBrandFill
            return
        }
        let lightOn = light.contrastingForeground
        let darkOn = dark.contrastingForeground
        surface = Self.dynamic(light: light, dark: dark)
        onSurface = Self.dynamic(light: lightOn, dark: darkOn)
        controlFill = Self.dynamic(
            light: lightOn.withAlphaComponent(Self.controlFillOpacity),
            dark: darkOn.withAlphaComponent(Self.controlFillOpacity)
        )
    }

    /// A color that resolves from the appearance the widget is rendered in.
    /// ``WidgetTheme`` keeps its own copy of this for the literals it holds;
    /// this one composes colors derived at render time.
    private static func dynamic(light: UIColor, dark: UIColor) -> Color {
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
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

    var eyeHeight: CGFloat = 33

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

    /// The photo, absent when the snapshot carries none and when its bytes do
    /// not form an image. Both fall through to the ground below, which is what
    /// makes this safe to hand a card's whole background to.
    let image: UIImage?

    /// Tints the ground for the case where there is no photo to blur, the way
    /// the takeover tints its own. Nil leaves the ground hue-neutral, which is
    /// all an uploaded photo can offer: it carries no accent by design.
    var accentHex: String? = nil

    var body: some View {
        ground
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .blur(radius: Self.blurRadius)
                        .overlay { Color.black.opacity(Self.scrimOpacity) }
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }

    private var ground: Color {
        let hex = accentHex.map(avatarSurfaceHex) ?? avatarSurfaceGround
        return Color(cssHex: hex) ?? .black
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
        WidgetAvatarKind(snapshotKind: snapshot?.avatar?.kind)
    }

    /// The avatar's raster, decoded. `nil` for an avatar carrying none and for
    /// bytes that do not form an image; every widget draws both the same way.
    var avatarImage: UIImage? {
        snapshot?.avatar?.imageData.flatMap(UIImage.init(data:))
    }

    /// The colors to theme this rendering with, already fallen back to the
    /// static brand card when there is no accent.
    var avatarPalette: WidgetAvatarPalette {
        WidgetAvatarPalette(accentHex: snapshot?.avatar?.accentHex)
    }
}

#if DEBUG

/// A card built out of the whole kit, so a preview shows the palette holding up
/// under the things actually drawn on it rather than three color swatches.
private struct WidgetAvatarKitPreviewCard: View {
    let title: String
    let palette: WidgetAvatarPalette

    var body: some View {
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
        .frame(width: 150, height: 150)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func controlCircle(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 15))
            .foregroundStyle(palette.onSurface)
            .frame(width: 38, height: 38)
            .background(palette.controlFill, in: Circle())
    }
}

/// The same content in both appearances, side by side: every value in this file
/// resolves per appearance, so a preview showing one of them is half a preview.
private func previewAppearances<Content: View>(
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
/// extension no asset.
private func previewAvatarPhoto() -> UIImage {
    let size = CGSize(width: 120, height: 120)
    return UIGraphicsImageRenderer(size: size).image { context in
        (UIColor(cssHex: "#3B6EA5") ?? .systemBlue).setFill()
        context.fill(CGRect(origin: .zero, size: size))
        (UIColor(cssHex: "#E8B04B") ?? .systemOrange).setFill()
        context.cgContext.fillEllipse(in: CGRect(x: 22, y: 26, width: 76, height: 76))
    }
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
        ZStack {
            BlurredAvatarBackground(image: photo)
            WidgetAvatarImageView(image: photo, size: 44, cornerRadius: 14)
        }
        .frame(width: 150, height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
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
