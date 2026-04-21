import SwiftUI

extension ToolbarContent {
    /// Opts this toolbar item out of the shared Liquid Glass background container
    /// that iOS 26 draws behind adjacent toolbar items in the same placement.
    ///
    /// On iOS 26+ this applies [`sharedBackgroundVisibility(.hidden)`](https://developer.apple.com/documentation/swiftui/toolbarcontent/sharedbackgroundvisibility(_:))
    /// so each item renders its own chrome instead of being grouped into a
    /// single capsule. No-op on earlier iOS versions, which don't group
    /// adjacent toolbar items.
    @ToolbarContentBuilder
    func hideSharedToolbarBackgroundIfAvailable() -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            self.sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}
