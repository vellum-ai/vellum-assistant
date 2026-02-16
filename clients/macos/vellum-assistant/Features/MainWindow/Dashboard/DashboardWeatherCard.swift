import SwiftUI
import VellumAssistantShared

/// A compact card that displays current weather on the dashboard.
struct DashboardWeatherCard: View {
    @ObservedObject var weatherService: DashboardWeatherService

    var body: some View {
        Group {
            if let weather = weatherService.weather {
                HStack(spacing: VSpacing.md) {
                    Text(weather.conditionEmoji)
                        .font(.system(size: 28))

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        HStack(spacing: VSpacing.sm) {
                            Text(weather.temperature)
                                .font(VFont.cardTitle)
                                .foregroundColor(VColor.textPrimary)

                            Text(weather.condition)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                        }

                        Text(weather.location)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    Spacer()
                }
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            } else if weatherService.isLoading {
                HStack(spacing: VSpacing.md) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading weather...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            }
        }
    }
}
