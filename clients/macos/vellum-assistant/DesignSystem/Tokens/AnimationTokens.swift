import SwiftUI

enum VAnimation {
    static let fast     = Animation.easeOut(duration: 0.15)
    static let standard = Animation.easeInOut(duration: 0.25)
    static let slow     = Animation.easeInOut(duration: 0.4)
    static let spring   = Animation.spring(response: 0.3, dampingFraction: 0.8)
}
