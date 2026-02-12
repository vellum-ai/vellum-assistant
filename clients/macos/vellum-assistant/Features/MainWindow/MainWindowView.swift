import SwiftUI

struct MainWindowView: View {
    var body: some View {
        ZStack {
            VColor.background
                .ignoresSafeArea()

            VStack(spacing: VSpacing.lg) {
                Text(UserDefaults.standard.string(forKey: "assistantName") ?? "vellum-assistant")
                    .font(VFont.display)
                    .foregroundStyle(VColor.textPrimary)

                Text("Main window — components coming soon")
                    .font(VFont.body)
                    .foregroundStyle(VColor.textSecondary)
            }
        }
        .frame(minWidth: 800, minHeight: 600)
    }
}

#Preview {
    MainWindowView()
}
