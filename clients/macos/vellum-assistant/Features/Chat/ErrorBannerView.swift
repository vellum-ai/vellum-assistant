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
    var reason: String? = nil

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(VColor.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("Memory is temporarily unavailable")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textPrimary)
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .font(VFont.small)
                        .foregroundStyle(VColor.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: VRadius.md))
        .padding(.horizontal)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
