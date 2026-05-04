import SwiftUI
import AppKit

/// Centralized icon token backed by vendored Lucide PDF assets.
/// Raw values match PDF filenames in the `LucideIcons` resource directory.
public enum VIcon: String, CaseIterable, Sendable {

    // MARK: - Navigation

    case chevronDown = "lucide-chevron-down"
    case chevronUp = "lucide-chevron-up"
    case chevronLeft = "lucide-chevron-left"
    case chevronRight = "lucide-chevron-right"
    case chevronsUpDown = "lucide-chevrons-up-down"
    case chevronsDownUp = "lucide-chevrons-down-up"
    case arrowUp = "lucide-arrow-up"
    case arrowDown = "lucide-arrow-down"
    case arrowLeft = "lucide-arrow-left"
    case arrowRight = "lucide-arrow-right"
    case arrowUpRight = "lucide-arrow-up-right"
    case arrowDownToLine = "lucide-arrow-down-to-line"
    case externalLink = "lucide-external-link"
    case refreshCw = "lucide-refresh-cw"
    case rotateCcw = "lucide-rotate-ccw"
    case panelLeft = "lucide-panel-left"

    // MARK: - Actions

    case x = "lucide-x"
    case plus = "lucide-plus"
    case check = "lucide-check"
    case search = "lucide-search"
    case copy = "lucide-copy"
    case trash = "lucide-trash-2"
    case pencil = "lucide-pencil"
    case pin = "lucide-pin"
    case pinOff = "lucide-pin-off"
    case archive = "lucide-archive"
    case upload = "lucide-upload"
    case send = "lucide-send"
    case share = "lucide-share-2"
    case ellipsis = "lucide-ellipsis"
    case squarePen = "lucide-square-pen"
    case wand = "lucide-wand"
    case paintbrush = "lucide-paintbrush"
    case link = "lucide-link"
    case paperclip = "lucide-paperclip"
    case logOut = "lucide-log-out"

    // MARK: - Status

    case circleCheck = "lucide-circle-check"
    case circleX = "lucide-circle-x"
    case triangleAlert = "lucide-triangle-alert"
    case info = "lucide-info"
    case circle = "lucide-circle"
    case circleDot = "lucide-circle-dot"
    case circleDashed = "lucide-circle-dashed"
    case circleDollarSign = "lucide-circle-dollar-sign"
    case circleAlert = "lucide-circle-alert"
    case circleStop = "lucide-circle-stop"
    case badgeCheck = "lucide-badge-check"
    case badgeX = "lucide-badge-x"
    case circleArrowUp = "lucide-circle-arrow-up"
    case circleArrowDown = "lucide-circle-arrow-down"
    case circlePlay = "lucide-circle-play"

    // MARK: - Security

    case shield = "lucide-shield"
    case shieldBan = "lucide-shield-ban"
    case shieldCheck = "lucide-shield-check"
    case shieldAlert = "lucide-shield-alert"
    case shieldOff = "lucide-shield-off"
    case lock = "lucide-lock"
    case lockOpen = "lucide-lock-open"
    case keyRound = "lucide-key-round"

    // MARK: - Files & Documents

    case file = "lucide-file"
    case fileText = "lucide-file-text"
    case filePlus = "lucide-file-plus"
    case fileCode = "lucide-file-code"
    case fileArchive = "lucide-file-archive"
    case folder = "lucide-folder"
    case folderClosed = "lucide-folder-closed"
    case folderOpen = "lucide-folder-open"
    case folderPlus = "lucide-folder-plus"
    case folderSearch = "lucide-folder-search"
    case clipboard = "lucide-clipboard"
    case clipboardList = "lucide-clipboard-list"
    case scrollText = "lucide-scroll-text"
    case bookOpen = "lucide-book-open"
    case table = "lucide-table-2"

    // MARK: - Media

    case image = "lucide-image"
    case film = "lucide-film"
    case play = "lucide-play"
    case square = "lucide-square"
    case mic = "lucide-mic"
    case micOff = "lucide-mic-off"
    case volume2 = "lucide-volume-2"
    case audioWaveform = "lucide-audio-waveform"
    case video = "lucide-video"
    case camera = "lucide-camera"
    case music = "lucide-music-2"
    case musicNotes = "lucide-music-4"
    case clapperboard = "lucide-clapperboard"
    case headphones = "lucide-headphones"
    case maximize = "lucide-maximize-2"
    case minimize = "lucide-minimize-2"
    case scan = "lucide-scan"

    // MARK: - Communication

    case messageCircle = "lucide-message-circle"
    case messageSquare = "lucide-message-square"
    case messagesSquare = "lucide-messages-square"
    case messageCirclePlus = "lucide-message-circle-plus"
    case mail = "lucide-mail"
    case phone = "lucide-phone"
    case phoneCall = "lucide-phone-call"
    case bell = "lucide-bell"
    case bellDot = "lucide-bell-dot"
    case hash = "lucide-hash"

    // MARK: - People

    case users = "lucide-users"
    case user = "lucide-user"
    case circleUser = "lucide-circle-user"
    case contact = "lucide-contact"

    // MARK: - System

    case terminal = "lucide-terminal"
    case globe = "lucide-globe"
    case wifi = "lucide-wifi"
    case wifiOff = "lucide-wifi-off"
    case monitor = "lucide-monitor"
    case smartphone = "lucide-smartphone"
    case laptop = "lucide-laptop"
    case qrCode = "lucide-qr-code"
    case layoutGrid = "lucide-layout-grid"
    case squareDashed = "lucide-square-dashed"
    case appWindow = "lucide-app-window"
    case power = "lucide-power"
    case settings = "lucide-settings"
    case slidersHorizontal = "lucide-sliders-horizontal"
    case filter = "lucide-filter"
    case cpu = "lucide-cpu"
    case hardDrive = "lucide-hard-drive"
    case network = "lucide-network"
    case keyboard = "lucide-keyboard"
    case mousePointerClick = "lucide-mouse-pointer-click"
    case eye = "lucide-eye"
    case eyeOff = "lucide-eye-off"
    case layers = "lucide-layers"

    // MARK: - Time

    case calendar = "lucide-calendar"
    case clock = "lucide-clock"
    case clockAlert = "lucide-clock-alert"
    case history = "lucide-history"

    // MARK: - Weather

    case sun = "lucide-sun"
    case moon = "lucide-moon"
    case cloud = "lucide-cloud"
    case cloudRain = "lucide-cloud-rain"
    case cloudLightning = "lucide-cloud-lightning"
    case cloudFog = "lucide-cloud-fog"
    case cloudSun = "lucide-cloud-sun"
    case cloudMoon = "lucide-cloud-moon"
    case cloudOff = "lucide-cloud-off"
    case snowflake = "lucide-snowflake"
    case wind = "lucide-wind"
    case droplets = "lucide-droplets"
    case thermometer = "lucide-thermometer"

    // MARK: - Objects

    case tag = "lucide-tag"
    case wrench = "lucide-wrench"
    case inbox = "lucide-inbox"
    case package = "lucide-package"
    case creditCard = "lucide-credit-card"
    case car = "lucide-car"
    case stethoscope = "lucide-stethoscope"
    case receipt = "lucide-receipt"
    case star = "lucide-star"
    case lightbulb = "lucide-lightbulb"
    case shoppingCart = "lucide-shopping-cart"
    case gamepad = "lucide-gamepad-2"
    case map = "lucide-map"
    case heart = "lucide-heart"
    case flag = "lucide-flag"
    case bookmark = "lucide-bookmark"
    case gift = "lucide-gift"
    case printer = "lucide-printer"
    case scissors = "lucide-scissors"
    case rocket = "lucide-rocket"
    case palette = "lucide-palette"
    case gripVertical = "lucide-grip-vertical"
    case graduationCap = "lucide-graduation-cap"
    case trophy = "lucide-trophy"
    case plane = "lucide-plane"
    case utensils = "lucide-utensils"
    case dumbbell = "lucide-dumbbell"
    case flask = "lucide-flask-conical"
    case briefcase = "lucide-briefcase"
    case tent = "lucide-tent"
    case bike = "lucide-bike"
    case penTool = "lucide-pen-tool"

    // MARK: - Misc

    case dices = "lucide-dices"
    case sparkles = "lucide-sparkles"
    case sparkle = "lucide-sparkle"
    case bug = "lucide-bug"
    case puzzle = "lucide-puzzle"
    case zap = "lucide-zap"
    case list = "lucide-list"
    case listChecks = "lucide-list-checks"
    case listOrdered = "lucide-list-ordered"
    case bold = "lucide-bold"
    case italic = "lucide-italic"
    case underline = "lucide-underline"
    case quote = "lucide-quote"
    case textAlignStart = "lucide-text-align-start"
    case textAlignCenter = "lucide-text-align-center"
    case textAlignEnd = "lucide-text-align-end"
    case barChart = "lucide-chart-bar"
    case trendingUp = "lucide-trending-up"
    case binoculars = "lucide-binoculars"
    case brain = "lucide-brain"
    case gitBranch = "lucide-git-branch"
    case gitPullRequest = "lucide-git-pull-request"
    case github = "lucide-github"
    case compass = "lucide-compass"
    case house = "lucide-house"
    case zoomIn = "lucide-zoom-in"
    case zoomOut = "lucide-zoom-out"

    // MARK: - Resolution

    /// Resolves an icon name that may be a Lucide raw value (`"lucide-x"`)
    /// or an SF Symbol name (`"xmark"`). Falls back to `.puzzle`.
    public static func resolve(_ name: String) -> VIcon {
        VIcon(rawValue: name) ?? SFSymbolMapping.icon(forSFSymbol: name) ?? .puzzle
    }

    // MARK: - Image Resolution

    /// URL of the PDF file inside the resource bundle's `LucideIcons` directory.
    private var pdfURL: URL? {
        Bundle.vellumShared.url(forResource: rawValue, withExtension: "pdf", subdirectory: "LucideIcons")
    }

    /// SwiftUI `Image` resolved from the vendored PDF.
    public func image(size: CGFloat = 24) -> Image {
        guard let ns = cachedNSImage(size: size) else {
            return Image(systemName: "questionmark.square")
        }
        return Image(nsImage: ns)
    }

    /// Convenience for callers that don't specify a size.
    public var image: Image { image() }

    /// Non-evicting store for loaded NSImage instances, keyed on "rawValue-base" or "rawValue-{size}".
    /// Unlike NSCache, a plain dictionary is never evicted under memory pressure, preserving
    /// the identity stability that SwiftUI relies on for diffing.
    private static var nsImageStore: [String: NSImage] = [:]
    private static let nsImageLock = NSLock()

    /// Loads (or returns cached) NSImage from the vendored PDF.
    /// Pass `nil` for the unsized base image, or a size for a sized variant.
    private func cachedNSImage(size: CGFloat? = nil) -> NSImage? {
        let cacheKey: String
        let roundedSize: CGFloat?
        if let size {
            // Clamped to [1, 512] to bound keyspace; VIcon.allCases.count × 512 ≈ trivial memory
            let roundedInt = max(1, min(Int(size.rounded()), 512))
            roundedSize = CGFloat(roundedInt)
            cacheKey = "\(rawValue)-\(roundedInt)"
        } else {
            roundedSize = nil
            cacheKey = "\(rawValue)-base"
        }

        Self.nsImageLock.lock()
        if let cached = Self.nsImageStore[cacheKey] {
            Self.nsImageLock.unlock()
            return cached
        }
        Self.nsImageLock.unlock()

        guard let url = pdfURL, let img = NSImage(contentsOf: url) else { return nil }
        img.isTemplate = true
        if let roundedSize {
            img.size = NSSize(width: roundedSize, height: roundedSize)
        }

        Self.nsImageLock.lock()
        // Double-check in case another thread populated it while we were loading.
        if let existing = Self.nsImageStore[cacheKey] {
            Self.nsImageLock.unlock()
            return existing
        }
        Self.nsImageStore[cacheKey] = img
        Self.nsImageLock.unlock()
        return img
    }

    /// AppKit `NSImage` resolved from the vendored PDF.
    public var nsImage: NSImage? {
        cachedNSImage()
    }

    /// Convenience returning a sized `NSImage`.
    public func nsImage(size: CGFloat) -> NSImage? {
        cachedNSImage(size: size)
    }
}
