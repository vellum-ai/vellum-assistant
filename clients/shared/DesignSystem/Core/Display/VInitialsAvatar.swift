import SwiftUI

/// A circular avatar showing the initials of a name.
public struct VInitialsAvatar: View {
    public let name: String
    public var color: Color = VColor.primaryBase
    public var size: CGFloat = 28

    public init(name: String, color: Color = VColor.primaryBase, size: CGFloat = 28) {
        self.name = name
        self.color = color
        self.size = size
    }

    public var body: some View {
        Text(initials)
            .font(.system(size: size * 0.35, weight: .semibold))
            .foregroundColor(VColor.auxWhite)
            .frame(width: size, height: size)
            .background(Circle().fill(color))
            .accessibilityHidden(true)
    }

    private var initials: String {
        let result = name.split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()
        return result.isEmpty ? "?" : result
    }
}
