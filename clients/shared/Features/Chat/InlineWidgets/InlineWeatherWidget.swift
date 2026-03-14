import SwiftUI

// MARK: - Data Model

public struct WeatherHourlyItem: Identifiable {
    public let id: String
    public let time: String
    public let icon: String
    public let tempC: Double
    public let sourceIsFahrenheit: Bool

    public init(id: String, time: String, icon: String, tempC: Double, sourceIsFahrenheit: Bool) {
        self.id = id
        self.time = time
        self.icon = icon
        self.tempC = tempC
        self.sourceIsFahrenheit = sourceIsFahrenheit
    }

    public func temp(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(tempC) }
        return useFahrenheit ? Int(tempC * 9 / 5 + 32) : Int((tempC - 32) * 5 / 9)
    }
}

public struct WeatherForecastItem: Identifiable {
    public let id: String
    public let day: String
    public let icon: String
    public let lowC: Double
    public let highC: Double
    public let precip: Int?
    public let condition: String

    /// Whether the original data was in Fahrenheit.
    public let sourceIsFahrenheit: Bool

    public init(id: String, day: String, icon: String, lowC: Double, highC: Double, precip: Int?, condition: String, sourceIsFahrenheit: Bool) {
        self.id = id
        self.day = day
        self.icon = icon
        self.lowC = lowC
        self.highC = highC
        self.precip = precip
        self.condition = condition
        self.sourceIsFahrenheit = sourceIsFahrenheit
    }

    public func low(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(lowC) }
        return useFahrenheit ? Int(lowC * 9 / 5 + 32) : Int((lowC - 32) * 5 / 9)
    }

    public func high(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(highC) }
        return useFahrenheit ? Int(highC * 9 / 5 + 32) : Int((highC - 32) * 5 / 9)
    }
}

public struct WeatherForecastData {
    public let location: String
    public let currentTemp: Double
    public let feelsLike: Double
    public let condition: String
    public let humidity: Int
    public let windSpeed: Int
    public let windDirection: String
    public let sourceIsFahrenheit: Bool
    public let hourly: [WeatherHourlyItem]
    public let forecast: [WeatherForecastItem]

    public init(location: String, currentTemp: Double, feelsLike: Double, condition: String, humidity: Int, windSpeed: Int, windDirection: String, sourceIsFahrenheit: Bool, hourly: [WeatherHourlyItem], forecast: [WeatherForecastItem]) {
        self.location = location
        self.currentTemp = currentTemp
        self.feelsLike = feelsLike
        self.condition = condition
        self.humidity = humidity
        self.windSpeed = windSpeed
        self.windDirection = windDirection
        self.sourceIsFahrenheit = sourceIsFahrenheit
        self.hourly = hourly
        self.forecast = forecast
    }

    public func currentTemp(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(currentTemp) }
        return useFahrenheit ? Int(currentTemp * 9 / 5 + 32) : Int((currentTemp - 32) * 5 / 9)
    }

    public func feelsLike(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return Int(feelsLike) }
        return useFahrenheit ? Int(feelsLike * 9 / 5 + 32) : Int((feelsLike - 32) * 5 / 9)
    }

    public func windSpeed(useFahrenheit: Bool) -> Int {
        if sourceIsFahrenheit == useFahrenheit { return windSpeed }
        // Convert between mph (Fahrenheit) and km/h (Celsius)
        return useFahrenheit ? Int(Double(windSpeed) / 1.60934) : Int(Double(windSpeed) * 1.60934)
    }

    public static func parse(from dict: [String: Any?]) -> WeatherForecastData? {
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

public struct InlineWeatherWidget: View {
    public let data: WeatherForecastData

    @State private var useFahrenheit: Bool

    public init(data: WeatherForecastData) {
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

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heroSection
            if !data.hourly.isEmpty {
                Divider().background(VColor.surfaceActive.opacity(0.3))
                hourlySection
            }
            Divider().background(VColor.surfaceActive.opacity(0.3))
            dailyForecastHeader
            Divider().background(VColor.surfaceActive.opacity(0.3))

            ForEach(Array(data.forecast.enumerated()), id: \.element.id) { index, item in
                forecastRow(item, isFirst: index == 0)
                if index < data.forecast.count - 1 {
                    Divider().background(VColor.surfaceActive.opacity(0.3))
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
                        .foregroundColor(VColor.contentDefault)
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
                        .foregroundColor(VColor.contentDefault)
                    Text("°")
                        .font(.system(size: 28, weight: .thin, design: .rounded))
                        .foregroundColor(VColor.contentSecondary)
                        .offset(y: 4)
                }

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    // Condition with icon
                    HStack(spacing: VSpacing.xs) {
                        if let firstItem = data.forecast.first {
                            VIconView(SFSymbolMapping.icon(forSFSymbol: firstItem.icon, fallback: .cloud), size: 14)
                                .foregroundColor(iconColor(for: firstItem.icon))
                        }
                        Text(data.condition)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.contentDefault)
                    }

                    // Feels like
                    Text("Feels like \(data.feelsLike(useFahrenheit: useFahrenheit))°")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)

                    // H/L
                    if let hl = todayHighLow {
                        Text("H:\(hl.high)°  L:\(hl.low)°")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
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
                    VIconView(.wind, size: 12)
                }
                .foregroundColor(VColor.contentTertiary)

                Label {
                    Text("\(data.humidity)%")
                        .font(VFont.caption)
                } icon: {
                    VIconView(.droplets, size: 12)
                }
                .foregroundColor(VColor.contentTertiary)
            }
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Hourly Forecast

    private var hourlySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: VSpacing.xs) {
                VIconView(.clock, size: 12)
                    .foregroundColor(VColor.contentTertiary)
                Text("HOURLY FORECAST")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentTertiary)
                Spacer()
            }
            .padding(.vertical, VSpacing.sm)

            Divider().background(VColor.surfaceActive.opacity(0.3))

            // Scrollable hourly row
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.xl) {
                    ForEach(data.hourly) { item in
                        VStack(spacing: VSpacing.sm) {
                            Text(item.time)
                                .font(item.time == "Now" ? VFont.bodyBold : VFont.caption)
                                .foregroundColor(VColor.contentDefault)

                            VIconView(SFSymbolMapping.icon(forSFSymbol: item.icon, fallback: .cloud), size: 18)
                                .foregroundColor(iconColor(for: item.icon))
                                .frame(height: 22)

                            Text("\(item.temp(useFahrenheit: useFahrenheit))°")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.contentDefault)
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
            VIconView(.calendar, size: 12)
                .foregroundColor(VColor.contentTertiary)
            Text("\(data.forecast.count)-DAY FORECAST")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentTertiary)
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
                .foregroundColor(VColor.contentDefault)
                .frame(width: 46, alignment: .leading)

            // Weather icon + optional precip
            VStack(spacing: VSpacing.xxs) {
                VIconView(SFSymbolMapping.icon(forSFSymbol: item.icon, fallback: .cloud), size: 16)
                    .foregroundColor(iconColor(for: item.icon))
                    .frame(width: 24, height: 20)

                if let precip = item.precip {
                    Text("\(precip)%")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeHover)
                }
            }
            .frame(width: 36)

            // Low temp
            Text("\(low)°")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .frame(width: 32, alignment: .trailing)

            // Temperature bar
            temperatureBar(low: low, high: high, currentTemp: isFirst ? data.currentTemp(useFahrenheit: useFahrenheit) : nil)

            // High temp
            Text("\(high)°")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
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
                    .fill(VColor.surfaceActive.opacity(0.3))
                    .frame(height: 4)

                // Filled portion with gradient
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [VColor.systemPositiveWeak, VColor.systemPositiveStrong],
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
                        .fill(VColor.auxWhite)
                        .frame(width: 6, height: 6)
                        .shadow(color: VColor.auxBlack.opacity(0.3), radius: 1, y: 1)
                        .offset(x: dotX - 3)
                }
            }
        }
        .frame(height: 6)
    }

    // MARK: - Helpers

    private func iconColor(for sfSymbol: String) -> Color {
        switch sfSymbol {
        case "sun.max.fill": return VColor.systemNegativeHover
        case "cloud.sun.fill": return VColor.systemNegativeWeak
        case "moon.fill": return VColor.systemPositiveWeak
        case "cloud.moon.fill": return VColor.systemPositiveWeak
        case "cloud.fill": return VColor.borderHover
        case "cloud.rain.fill": return VColor.systemPositiveWeak
        case "snowflake": return VColor.systemPositiveWeak
        case "cloud.bolt.fill": return VColor.systemNegativeHover
        case "cloud.fog.fill": return VColor.contentDisabled
        default: return VColor.contentSecondary
        }
    }
}

// MARK: - Preview

#if DEBUG
#endif
