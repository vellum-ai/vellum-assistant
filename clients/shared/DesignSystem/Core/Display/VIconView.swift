import SwiftUI

/// Renders a `VIcon` at the given size.  Drop-in replacement for `Image(systemName:)`.
public struct VIconView: View {
    private let icon: VIcon
    private let size: CGFloat

    public init(_ icon: VIcon, size: CGFloat = 14) {
        self.icon = icon
        self.size = size
    }

    public var body: some View {
        icon.image(size: size)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
    }
}
