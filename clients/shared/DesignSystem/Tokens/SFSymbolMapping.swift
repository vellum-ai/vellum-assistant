/// Maps SF Symbol names to `VIcon` cases.
/// Used by dynamic icon consumers (weather widget, HTTP surfaces, trace views)
/// where the icon name arrives as a string at runtime.
public enum SFSymbolMapping {

    /// Returns the `VIcon` for a given SF Symbol name, or `nil` if unmapped.
    public static func icon(forSFSymbol name: String) -> VIcon? {
        mapping[name]
    }

    /// Returns the `VIcon` for a given SF Symbol name, with a fallback.
    public static func icon(forSFSymbol name: String, fallback: VIcon) -> VIcon {
        mapping[name] ?? fallback
    }

    // MARK: - Lookup Table

    private static let mapping: [String: VIcon] = [
        // Navigation / Arrows
        "chevron.down": .chevronDown,
        "chevron.up": .chevronUp,
        "chevron.left": .chevronLeft,
        "chevron.right": .chevronRight,
        "arrow.up": .arrowUp,
        "arrow.down": .arrowDown,
        "arrow.right": .arrowRight,
        "arrow.up.right": .arrowUpRight,
        "arrow.up.right.square": .externalLink,
        "arrow.down.to.line": .arrowDownToLine,
        "arrow.clockwise": .refreshCw,
        "arrow.counterclockwise": .rotateCcw,
        "arrow.triangle.2.circlepath": .refreshCw,
        "arrow.trianglehead.counterclockwise": .rotateCcw,
        "arrow.down.circle": .circleArrowDown,
        "arrow.down.circle.fill": .circleArrowDown,
        "arrow.up.circle": .circleArrowUp,
        "arrow.up.circle.fill": .circleArrowUp,
        "arrow.right.circle": .arrowRight,
        "arrow.right.arrow.left.circle": .refreshCw,
        "arrow.right.arrow.left.circle.fill": .refreshCw,
        "arrow.triangle.branch": .gitBranch,
        "arrow.uturn.backward": .rotateCcw,
        "arrow.down.doc.fill": .arrowDownToLine,
        "rectangle.portrait.and.arrow.right": .logOut,

        // X / Close / Plus / Check
        "xmark": .x,
        "xmark.circle": .circleX,
        "xmark.circle.fill": .circleX,
        "xmark.seal.fill": .badgeX,
        "plus": .plus,
        "plus.circle": .plus,
        "plus.message": .messageCirclePlus,
        "checkmark": .check,
        "checkmark.circle": .circleCheck,
        "checkmark.circle.fill": .circleCheck,
        "checkmark.seal": .badgeCheck,
        "checkmark.seal.fill": .badgeCheck,
        "checkmark.shield": .shieldCheck,
        "checkmark.shield.fill": .shieldCheck,

        // Status / Alerts
        "exclamationmark.triangle": .triangleAlert,
        "exclamationmark.triangle.fill": .triangleAlert,
        "exclamationmark.circle": .circleAlert,
        "exclamationmark.circle.fill": .circleAlert,
        "exclamationmark.icloud.fill": .cloudOff,
        "info.circle": .info,
        "info.circle.fill": .info,
        "circle": .circle,
        "circle.fill": .circle,
        "circle.dashed": .circleDashed,
        "circle.dotted": .circleDot,
        "stop.circle.fill": .circleStop,
        "stop.fill": .square,

        // Search / Zoom
        "magnifyingglass": .search,
        "plus.magnifyingglass": .zoomIn,
        "minus.magnifyingglass": .zoomOut,

        // Files / Documents
        "doc": .file,
        "doc.fill": .file,
        "doc.text": .fileText,
        "doc.text.fill": .fileText,
        "doc.badge.plus": .filePlus,
        "doc.richtext": .fileText,
        "doc.on.doc": .copy,
        "doc.on.clipboard": .clipboard,
        "doc.zipper": .fileArchive,
        "note.text": .scrollText,
        "folder": .folder,
        "folder.badge.magnifyingglass": .folderSearch,
        "tablecells": .table,
        "rectangle.on.rectangle": .layers,
        "checklist": .listChecks,

        // Edit
        "pencil": .pencil,
        "pencil.line": .pencil,
        "square.and.pencil": .squarePen,
        "square.and.arrow.up": .share,

        // Trash / Archive / Pin
        "trash": .trash,
        "archivebox": .archive,
        "pin": .pin,
        "pin.fill": .pin,
        "pin.slash": .pinOff,

        // Settings / Tools
        "gear": .settings,
        "gearshape": .settings,
        "wrench": .wrench,
        "wrench.fill": .wrench,
        "wrench.and.screwdriver": .wrench,
        "wrench.and.screwdriver.fill": .wrench,
        "wand.and.stars": .wand,

        // Shield / Lock / Security
        "shield": .shield,
        "shield.fill": .shield,
        "shield.lefthalf.filled": .shieldAlert,
        "shield.slash": .shieldOff,
        "lock.shield": .shield,
        "lock.shield.fill": .shield,
        "lock": .lock,
        "lock.fill": .lock,
        "lock.open": .lockOpen,
        "key.fill": .keyRound,

        // Communication
        "bubble.left": .messageCircle,
        "bubble.left.fill": .messageCircle,
        "bubble.left.and.bubble.right": .messagesSquare,
        "bubble.left.and.text.bubble.right": .messagesSquare,
        "message": .messageSquare,
        "message.fill": .messageSquare,
        "text.bubble": .messageCircle,
        "text.bubble.fill": .messageCircle,
        "envelope": .mail,
        "envelope.fill": .mail,
        "paperplane": .send,
        "paperplane.fill": .send,
        "paperclip": .paperclip,

        // People
        "person.2": .users,
        "person.2.fill": .users,
        "person.fill": .user,
        "person.circle.fill": .circleUser,
        "person.crop.circle": .circleUser,
        "person.crop.circle.badge.questionmark": .circleUser,
        "person.text.rectangle": .contact,

        // Phone / Bell
        "phone": .phone,
        "phone.fill": .phoneCall,
        "phone.badge.waveform": .phoneCall,
        "bell": .bell,
        "bell.fill": .bell,
        "bell.badge": .bellDot,
        "number": .hash,

        // Terminal / System
        "terminal": .terminal,
        "globe": .globe,
        "cpu": .cpu,
        "memorychip": .hardDrive,
        "network": .network,
        "desktopcomputer": .monitor,
        "iphone": .smartphone,
        "apps.iphone": .smartphone,
        "laptopcomputer.and.iphone": .laptop,
        "macwindow": .appWindow,
        "rectangle.dashed": .squareDashed,
        "rectangle.3.group": .layers,
        "sidebar.left": .panelLeft,
        "square.grid.2x2": .layoutGrid,
        "power": .power,
        "qrcode.viewfinder": .qrCode,
        "escape": .logOut,

        // Eye
        "eye": .eye,
        "eye.slash.fill": .eyeOff,
        "eye.trianglebadge.exclamationmark": .eye,

        // Media
        "photo": .image,
        "photo.on.rectangle": .image,
        "film": .film,
        "play.fill": .play,
        "play.circle": .circlePlay,
        "play.circle.fill": .circlePlay,
        "play.rectangle": .video,
        "play.rectangle.fill": .video,
        "square.fill": .square,

        // Audio
        "mic": .mic,
        "mic.fill": .mic,
        "mic.circle": .mic,
        "mic.slash.circle": .micOff,
        "speaker.wave.2": .volume2,
        "speaker.wave.2.fill": .volume2,
        "waveform": .audioWaveform,
        "waveform.circle": .audioWaveform,
        "waveform.path": .audioWaveform,
        "waveform.path.ecg": .audioWaveform,

        // Time
        "calendar": .calendar,
        "clock": .clock,
        "clock.fill": .clock,
        "clock.arrow.circlepath": .history,
        "clock.badge.exclamationmark": .clockAlert,
        "clock.badge.checkmark": .clock,
        "clock.badge.questionmark": .clock,

        // Weather
        "sun.max.fill": .sun,
        "moon.fill": .moon,
        "cloud": .cloud,
        "cloud.fill": .cloud,
        "cloud.rain.fill": .cloudRain,
        "cloud.bolt.fill": .cloudLightning,
        "cloud.fog.fill": .cloudFog,
        "cloud.sun.fill": .cloudSun,
        "cloud.moon.fill": .cloudMoon,
        "snowflake": .snowflake,
        "wind": .wind,
        "humidity": .droplets,

        // Camera / Scan
        "camera": .camera,
        "camera.fill": .camera,
        "camera.viewfinder": .scan,
        "camera.metering.spot": .scan,
        "viewfinder": .scan,

        // Objects
        "tag": .tag,
        "link": .link,
        "car.fill": .car,
        "music.note": .music,
        "cart": .shoppingCart,
        "cart.fill": .shoppingCart,
        "gamecontroller": .gamepad,
        "gamecontroller.fill": .gamepad,
        "map": .map,
        "map.fill": .map,
        "heart": .heart,
        "heart.fill": .heart,
        "flag": .flag,
        "flag.fill": .flag,
        "bookmark": .bookmark,
        "bookmark.fill": .bookmark,
        "gift": .gift,
        "gift.fill": .gift,
        "printer": .printer,
        "printer.fill": .printer,
        "scissors": .scissors,
        "stethoscope": .stethoscope,
        "creditcard.trianglebadge.exclamationmark": .creditCard,
        "dollarsign.circle": .receipt,
        "tray": .inbox,
        "tray.full": .inbox,
        "tray.full.fill": .inbox,
        "tray.and.arrow.down": .inbox,
        "tray.and.arrow.up": .inbox,
        "binoculars": .binoculars,
        "binoculars.fill": .binoculars,
        "paintbrush": .paintbrush,

        // Misc
        "sparkles": .sparkles,
        "sparkle": .sparkle,
        "ant": .bug,
        "ladybug": .bug,
        "puzzlepiece.extension": .puzzle,
        "puzzlepiece.fill": .puzzle,
        "bolt.fill": .zap,
        "star.fill": .star,
        "lightbulb.fill": .lightbulb,
        "brain": .brain,
        "brain.head.profile": .brain,
        "list.bullet": .list,
        "list.bullet.clipboard": .clipboardList,
        "chart.bar": .barChart,
        "chart.bar.fill": .barChart,
        "chart.line.uptrend.xyaxis": .trendingUp,
        "house": .house,
        "cursorarrow.click": .mousePointerClick,
        "cursorarrow.click.2": .mousePointerClick,
        "keyboard": .keyboard,
        "safari": .compass,
        "text.word.spacing": .fileText,
        "text.badge.xmark": .fileText,
        "wifi": .wifi,
        "wifi.exclamationmark": .wifiOff,

        // Code
        "chevron.left.forwardslash.chevron.right": .fileCode,

        // Expand / Collapse
        "arrow.up.left.and.arrow.down.right": .maximize,
        "arrow.down.right.and.arrow.up.left": .minimize,

        // Controls / Layout
        "ellipsis": .ellipsis,
        "ellipsis.circle": .ellipsis,
        "slider.horizontal.3": .slidersHorizontal,
        "circle.lefthalf.filled": .monitor,
        "square.and.arrow.down": .arrowDownToLine,
        "qrcode": .qrCode,

        // HTTP / Composition
        "app.fill": .layoutGrid,
        "shippingbox.fill": .package,
    ]
}
