import VellumAssistantShared
import SwiftUI

/// Full-bleed pixel art meadow background for onboarding.
struct MeadowBackground: View {
    var body: some View {
        ZStack {
            VColor.surfaceOverlay

            if let url = ResourceBundle.bundle.url(forResource: "meadow", withExtension: "svg"),
               let nsImage = NSImage(contentsOf: url) {
                Image(nsImage: nsImage)
                    .resizable()
                    .interpolation(.none)
                    .aspectRatio(contentMode: .fill)
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
    }
}
