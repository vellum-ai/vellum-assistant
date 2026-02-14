import SwiftUI
import VellumAssistantShared

// MARK: - Data Model

struct WeatherHourlyItem: Identifiable {
    let id: String
    let time: String
    let icon: String
    let tempC: Double
    let sourceIsFahrenheit: Bool

    func temp(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(tempC) }
        return useFahrenheit ? Int(tempC * 9 / 5 + 32) : Int((tempC - 32) * 5 / 9)
    }
}

struct WeatherForecastItem: Identifiable {
    let id: String
    let day: String
    let icon: String
    let lowC: Double
    let highC: Double
    let precip: Int?
    let condition: String

    /// Whether the original data was in Fahrenheit.
    let sourceIsFahrenheit: Bool

    func low(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(lowC) }
        return useFahrenheit ? Int(lowC * 9 / 5 + 32) : Int((lowC - 32) * 5 / 9)
    }

    func high(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(highC) }
        return useFahrenheit ? Int(highC * 9 / 5 + 32) : Int((highC - 32) * 5 / 9)
    }
}

struct WeatherForecastData {
    let location: String
    let currentTemp: Double
    let feelsLike: Double
    let condition: String
    let humidity: Int
    let windSpeed: Int
    let windDirection: String
    let sourceIsFahrenheit: Bool
    let hourly: [WeatherHourlyItem]
    let forecast: [WeatherForecastItem]

    func currentTemp(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(currentTemp) }
        return useFahrenheit ? Int(currentTemp * 9 / 5 + 32) : Int((currentTemp - 32) * 5 / 9)
    }

    func feelsLike(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(feelsLike) }
        return useFahrenheit ? Int(feelsLike * 9 / 5 + 32) : Int((feelsLike - 32) * 5 / 9)
    }

    func windSpeed(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return windSpeed }
        // Convert between mph (Fahrenheit) and km/h (Celsius)
        return useFahrenheit ? Int(Double(windSpeed) / 1.60934) : Int(Double(windSpeed) * 1.60934)
    }

    static func parse(from dict: [String: Any?]) -> WeatherForecastData? {
        guard let location = dict["location"] as? String else { return nil }

        let currentTemp = (dict["currentTemp"] as? Double) ?? Double(dict["currentTemp"] as? Int ?? 0)
        let feelsLike = (dict["feelsLike"] as? Double) ?? Double(dict["feelsLike"] as? Int ?? 0)
        let condition = dict["condition"] as? String ?? ""
        let humidity = dict["humidity"] as? Int ?? 0
        let windSpeed = dict["windSpeed"] as? Int ?? 0
        let windDirection = dict["windDirection"] as? String ?? ""
        let unit = dict["unit"] as? String ?? "F"
        let isFahrenheit = unit == "F"

        var hourlyItems: [WeatherHourlyItem] = []
        if let hourlyArray = dict["hourly"] as? [[String: Any?]] {
            for (index, entry) in hourlyArray.enumerated() {
                let time = entry["time"] as? String ?? ""
                let icon = entry["icon"] as? String ?? "cloud.fill"
                let temp = (entry["temp"] as? Double) ?? Double(entry["temp"] as? Int ?? 0)
                hourlyItems.append(WeatherHourlyItem(
                    id: "h\(index)-\(time)",
                    time: time,
                    icon: icon,
                    tempC: temp,
                    sourceIsFahrenheit: isFahrenheit
                ))
            }
        }

        var items: [WeatherForecastItem] = []
        if let forecastArray = dict["forecast"] as? [[String: Any?]] {
            for (index, entry) in forecastArray.enumerated() {
                let day = entry["day"] as? String ?? ""
                let icon = entry["icon"] as? String ?? "cloud.fill"
                let low = (entry["low"] as? Double) ?? Double(entry["low"] as? Int ?? 0)
                let high = (entry["high"] as? Double) ?? Double(entry["high"] as? Int ?? 0)
                let precip: Int? = entry["precip"] as? Int
                let itemCondition = entry["condition"] as? String ?? ""
                items.append(WeatherForecastItem(
                    id: "\(index)-\(day)",
                    day: day, icon: icon,
                    lowC: low, highC: high,
                    precip: precip,
                    condition: itemCondition,
                    sourceIsFahrenheit: isFahrenheit
                ))
            }
        }

        return WeatherForecastData(
            location: location,
            currentTemp: currentTemp,
            feelsLike: feelsLike,
            condition: condition,
            humidity: humidity,
            windSpeed: windSpeed,
            windDirection: windDirection,
            sourceIsFahrenheit: isFahrenheit,
            hourly: hourlyItems,
            forecast: items
        )
    }
}

// MARK: - Widget View

struct InlineWeatherWidget: View {
    let data: WeatherForecastData

    @State private var useFahrenheit: Bool

    init(data: WeatherForecastData) {
        self.data = data
        self._useFahrenheit = State(initialValue: data.sourceIsFahrenheit)
    }

    private var unit: String { useFahrenheit ? "F" : "C" }
    private var speedUnit: String { useFahrenheit ? "mph" : "km/h" }

    /// Global min/max across all forecast days, used to normalize the temperature bars.
    private var globalRange: (min: Int, max: Int) {
        let lows = data.forecast.map { $0.low(useFahrenheit: useFahrenheit) }
        let highs = data.forecast.map { $0.high(useFahrenheit: useFahrenheit) }
        let allMin = (lows.min() ?? 0)
        let allMax = (highs.max() ?? 100)
        return (allMin, allMax)
    }

    /// Today's H/L from the first forecast item.
    private var todayHighLow: (high: Int, low: Int)? {
        guard let today = data.forecast.first else { return nil }
        return (today.high(useFahrenheit: useFahrenheit), today.low(useFahrenheit: useFahrenheit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heroSection
            if !data.hourly.isEmpty {
                Divider().background(Slate._700.opacity(0.3))
                hourlySection
            }
            Divider().background(Slate._700.opacity(0.3))
            dailyForecastHeader
            Divider().background(Slate._700.opacity(0.3))

            ForEach(Array(data.forecast.enumerated()), id: \.element.id) { index, item in
                forecastRow(item, isFirst: index == 0)
                if index < data.forecast.count - 1 {
                    Divider().background(Slate._700.opacity(0.3))
                }
            }
        }
    }

    // MARK: - Hero Section (Current Conditions)

    private var heroSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            // Location + unit toggle
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(data.location)
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                }
                Spacer()
                Picker("", selection: $useFahrenheit) {
                    Text("°F").tag(true)
                    Text("°C").tag(false)
                }
                .pickerStyle(.segmented)
                .frame(width: 80)
            }

            // Big temperature + condition
            HStack(alignment: .top, spacing: VSpacing.md) {
                // Large temp display
                HStack(alignment: .top, spacing: 0) {
                    Text("\(data.currentTemp(useFahrenheit: useFahrenheit))")
                        .font(.system(size: 48, weight: .thin, design: .rounded))
                        .foregroundColor(VColor.textPrimary)
                    Text("°")
                        .font(.system(size: 28, weight: .thin, design: .rounded))
                        .foregroundColor(VColor.textSecondary)
                        .offset(y: 4)
                }

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    // Condition with icon
                    HStack(spacing: VSpacing.xs) {
                        if let firstItem = data.forecast.first {
                            Image(systemName: firstItem.icon)
                                .font(.system(size: 14))
                                .foregroundColor(iconColor(for: firstItem.icon))
                        }
                        Text(data.condition)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                    }

                    // Feels like
                    Text("Feels like \(data.feelsLike(useFahrenheit: useFahrenheit))°")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)

                    // H/L
                    if let hl = todayHighLow {
                        Text("H:\(hl.high)°  L:\(hl.low)°")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
                .padding(.top, VSpacing.sm)
            }

            // Wind + Humidity chips
            HStack(spacing: VSpacing.md) {
                Label {
                    Text("\(data.windSpeed(useFahrenheit: useFahrenheit)) \(speedUnit) \(data.windDirection)")
                        .font(VFont.caption)
                } icon: {
                    Image(systemName: "wind")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)

                Label {
                    Text("\(data.humidity)%")
                        .font(VFont.caption)
                } icon: {
                    Image(systemName: "humidity")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Hourly Forecast

    private var hourlySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "clock")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                Text("HOURLY FORECAST")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textMuted)
                Spacer()
            }
            .padding(.vertical, VSpacing.sm)

            Divider().background(Slate._700.opacity(0.3))

            // Scrollable hourly row
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.xl) {
                    ForEach(data.hourly) { item in
                        VStack(spacing: VSpacing.sm) {
                            Text(item.time)
                                .font(item.time == "Now" ? VFont.bodyBold : VFont.caption)
                                .foregroundColor(VColor.textPrimary)

                            Image(systemName: item.icon)
                                .font(.system(size: 18))
                                .foregroundColor(iconColor(for: item.icon))
                                .frame(height: 22)

                            Text("\(item.temp(useFahrenheit: useFahrenheit))°")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                        }
                        .frame(minWidth: 44)
                    }
                }
                .padding(.vertical, VSpacing.sm)
            }
        }
    }

    // MARK: - Daily Forecast Header

    private var dailyForecastHeader: some View {
        HStack {
            Image(systemName: "calendar")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            Text("\(data.forecast.count)-DAY FORECAST")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
            Spacer()
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Forecast Row

    private func forecastRow(_ item: WeatherForecastItem, isFirst: Bool) -> some View {
        let low = item.low(useFahrenheit: useFahrenheit)
        let high = item.high(useFahrenheit: useFahrenheit)

        return HStack(spacing: VSpacing.sm) {
            // Day name
            Text(item.day)
                .font(item.day == "Today" ? VFont.bodyBold : VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)
                .frame(width: 46, alignment: .leading)

            // Weather icon + optional precip
            VStack(spacing: VSpacing.xxs) {
                Image(systemName: item.icon)
                    .font(.system(size: 16))
                    .foregroundColor(iconColor(for: item.icon))
                    .frame(width: 24, height: 20)

                if let precip = item.precip {
                    Text("\(precip)%")
                        .font(VFont.small)
                        .foregroundColor(Amber._500)
                }
            }
            .frame(width: 36)

            // Low temp
            Text("\(low)°")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 32, alignment: .trailing)

            // Temperature bar
            temperatureBar(low: low, high: high, currentTemp: isFirst ? data.currentTemp(useFahrenheit: useFahrenheit) : nil)

            // High temp
            Text("\(high)°")
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(width: 32, alignment: .trailing)
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Temperature Bar

    private func temperatureBar(low: Int, high: Int, currentTemp: Int?) -> some View {
        let range = globalRange
        let span = max(range.max - range.min, 1)

        // Calculate the start and end positions of the filled portion (0...1)
        let startFraction = CGFloat(low - range.min) / CGFloat(span)
        let endFraction = CGFloat(high - range.min) / CGFloat(span)

        return GeometryReader { geometry in
            let totalWidth = geometry.size.width
            let barStart = totalWidth * startFraction
            let barWidth = totalWidth * (endFraction - startFraction)

            ZStack(alignment: .leading) {
                // Background track
                Capsule()
                    .fill(Slate._700.opacity(0.3))
                    .frame(height: 4)

                // Filled portion with gradient
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [Indigo._400, Emerald._400],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(barWidth, 4), height: 4)
                    .offset(x: barStart)

                // Current temperature dot (today only)
                if let temp = currentTemp {
                    let dotFraction = CGFloat(temp - range.min) / CGFloat(span)
                    let dotX = totalWidth * dotFraction
                    Circle()
                        .fill(Color.white)
                        .frame(width: 6, height: 6)
                        .shadow(color: .black.opacity(0.3), radius: 1, y: 1)
                        .offset(x: dotX - 3)
                }
            }
        }
        .frame(height: 6)
    }

    // MARK: - Helpers

    private func iconColor(for sfSymbol: String) -> Color {
        switch sfSymbol {
        case "sun.max.fill": return Amber._400
        case "cloud.sun.fill": return Amber._300
        case "moon.fill": return Indigo._200
        case "cloud.moon.fill": return Indigo._300
        case "cloud.fill": return Slate._400
        case "cloud.rain.fill": return Indigo._400
        case "snowflake": return Indigo._300
        case "cloud.bolt.fill": return Amber._500
        case "cloud.fog.fill": return Slate._500
        default: return VColor.textSecondary
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("InlineWeatherWidget") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ScrollView {
            InlineWeatherWidget(data: WeatherForecastData(
                location: "New York, NY",
                currentTemp: 28,
                feelsLike: 19,
                condition: "Overcast",
                humidity: 65,
                windSpeed: 12,
                windDirection: "NW",
                sourceIsFahrenheit: true,
                hourly: [
                    WeatherHourlyItem(id: "h0", time: "Now", icon: "cloud.fill", tempC: 28, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h1", time: "1AM", icon: "cloud.fill", tempC: 27, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h2", time: "2AM", icon: "cloud.fill", tempC: 26, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h3", time: "3AM", icon: "cloud.moon.fill", tempC: 25, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h4", time: "4AM", icon: "moon.fill", tempC: 24, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h5", time: "5AM", icon: "moon.fill", tempC: 24, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h6", time: "6AM", icon: "moon.fill", tempC: 23, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h7", time: "7AM", icon: "sun.max.fill", tempC: 24, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h8", time: "8AM", icon: "sun.max.fill", tempC: 26, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h9", time: "9AM", icon: "cloud.sun.fill", tempC: 29, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h10", time: "10AM", icon: "cloud.sun.fill", tempC: 31, sourceIsFahrenheit: true),
                    WeatherHourlyItem(id: "h11", time: "11AM", icon: "cloud.fill", tempC: 33, sourceIsFahrenheit: true),
                ],
                forecast: [
                    WeatherForecastItem(id: "0", day: "Today", icon: "cloud.fill", lowC: 24, highC: 36, precip: nil, condition: "Overcast", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "1", day: "Fri", icon: "sun.max.fill", lowC: 20, highC: 36, precip: nil, condition: "Sunny", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "2", day: "Sat", icon: "snowflake", lowC: 23, highC: 41, precip: 35, condition: "Snow", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "3", day: "Sun", icon: "cloud.fill", lowC: 26, highC: 37, precip: nil, condition: "Overcast", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "4", day: "Mon", icon: "cloud.sun.fill", lowC: 28, highC: 40, precip: nil, condition: "Partly cloudy", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "5", day: "Tue", icon: "cloud.sun.fill", lowC: 34, highC: 49, precip: nil, condition: "Partly cloudy", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "6", day: "Wed", icon: "cloud.fill", lowC: 33, highC: 44, precip: nil, condition: "Overcast", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "7", day: "Thu", icon: "snowflake", lowC: 35, highC: 44, precip: 55, condition: "Snow", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "8", day: "Fri", icon: "snowflake", lowC: 33, highC: 40, precip: 65, condition: "Snow", sourceIsFahrenheit: true),
                    WeatherForecastItem(id: "9", day: "Sat", icon: "cloud.fill", lowC: 31, highC: 43, precip: nil, condition: "Overcast", sourceIsFahrenheit: true),
                ]
            ))
            .padding()
            .frame(width: 450)
        }
    }
    .frame(width: 500, height: 800)
}
#endif
