import SwiftUI

enum VShadow {
    static let sm = (color: Color.black.opacity(0.2), radius: CGFloat(4), y: CGFloat(2))
    static let md = (color: Color.black.opacity(0.3), radius: CGFloat(8), y: CGFloat(4))
    static let lg = (color: Color.black.opacity(0.4), radius: CGFloat(16), y: CGFloat(8))
    static let glow = (color: Amber._500.opacity(0.3), radius: CGFloat(12), y: CGFloat(0))
}
