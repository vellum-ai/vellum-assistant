import SwiftUI

struct VAppPill: View {
    let name: String
    var icon: String?
    var isFavorite: Bool = false
    var onTap: () -> Void = {}
    var onToggleFavorite: () -> Void = {}

    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.sm) {
                iconView
                    .frame(width: 16, height: 16)

                Text(name)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                Spacer(minLength: 0)

                Button(action: onToggleFavorite) {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .font(.system(size: 10))
                        .foregroundColor(isFavorite ? Amber._500 : VColor.textMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(isHovered ? VColor.surface : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
    }

    @ViewBuilder
    private var iconView: some View {
        if let svgString = icon,
           let rendered = SVGRenderer.swiftUIImage(svgString: svgString, id: name, size: 16) {
            rendered
                .interpolation(.none)
        } else {
            Image(systemName: "app.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
        }
    }
}

#if DEBUG
#Preview("VAppPill") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.sm) {
            VAppPill(name: "Weather App", isFavorite: true)
            VAppPill(name: "Todo List")
            VAppPill(name: "Calculator", isFavorite: false)
        }
        .padding()
    }
    .frame(width: 250, height: 200)
}
#endif
