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

struct MemoryDegradedBanner: View {
    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(VColor.warning)
            Text("Memory is temporarily unavailable")
                .font(VFont.caption)
                .foregroundStyle(VColor.textPrimary)
            Spacer()
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(Color(hex: 0xF5F3EB), in: RoundedRectangle(cornerRadius: VRadius.md))
        .padding(.horizontal)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
