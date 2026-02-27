import SwiftUI
import VellumAssistantShared

struct APIKeyBanner: View {
    let onOpenSettings: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "key.fill")
                .font(VFont.caption)
            Text("API key not set. Add one in Settings to start chatting.")
                .font(VFont.caption)
                .lineLimit(2)
            Spacer()
            Button("Open Settings", action: onOpenSettings)
                .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .foregroundColor(.white)
        .background(VColor.warning)
    }
}
