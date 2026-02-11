import SwiftUI
import Observation

/// Thin adapter for legacy references. The main hatch logic is now in EggHatchScene.
@Observable
final class HatchViewModel {
    var onComplete: (() -> Void)?
}
