/**
 * IPC channel name constants.
 *
 * Using string constants (rather than inline literals) catches typos at
 * compile time and makes the full channel surface grep-able from a single
 * location. Channels are grouped by the bridge surface they belong to.
 */

// App
export const APP_VERSION_INFO = "vellum:app:versionInfo";
export const APP_OPEN_WEBSITE = "vellum:app:openWebsite";

// Config
export const CONFIG_GET = "vellum:config:get";

// Text insertion
export const TEXT_INSERT = "vellum:text:insertIntoFrontApp";
export const TEXT_OPEN_SETTINGS = "vellum:text:openAutomationSettings";

// Auth
export const AUTH_START_OAUTH = "vellum:auth:startOAuth";
export const AUTH_CANCEL_OAUTH = "vellum:auth:cancelOAuth";
export const AUTH_GET_SESSION_TOKEN = "vellum:auth:getSessionToken";
export const AUTH_SIGN_OUT = "vellum:auth:signOut";

// Hotkeys
export const HOTKEYS_GET = "vellum:hotkeys:get";
export const HOTKEYS_SET = "vellum:hotkeys:set";
export const HOTKEYS_CHANGED = "vellum:hotkeys:changed";

// Launch at login
export const LAUNCH_AT_LOGIN_GET = "vellum:launchAtLogin:get";
export const LAUNCH_AT_LOGIN_SET = "vellum:launchAtLogin:set";

// Feature flags
export const FEATURE_FLAGS_SET = "vellum:featureFlags:set";

// Helper (native sidecar)
export const HELPER_PING = "vellum:helper:ping";
export const HELPER_GET_STATE = "vellum:helper:state:get";
export const HELPER_RESTART = "vellum:helper:restart";
export const HELPER_STATE_EVENT = "vellum:helper:state";
export const HELPER_HOTKEY_FN_PTT = "vellum:helper:hotkey:fnPushToTalk";
export const HELPER_HOTKEY_EVENT = "vellum:helper:hotkey:event";
export const HELPER_DICTATION_SET_PARTIALS = "vellum:helper:dictation:setPartials";
export const HELPER_DICTATION_PARTIAL_EVENT = "vellum:helper:dictation:partial";

// Commands
export const COMMAND_EVENT = "vellum:command";

// Status
export const STATUS_CONNECTION = "vellum:status:connection";

// Icon / avatar
export const ICON_SET_AVATAR = "vellum:icon:setAvatar";

// Dock
export const DOCK_SET_BADGE = "vellum:dock:setBadge";
export const DOCK_SET_SIGNED_IN = "vellum:dock:setSignedIn";

// Local mode
export const LOCAL_MODE_HATCH = "vellum:localMode:hatch";
export const LOCAL_MODE_READ_LOCKFILE = "vellum:localMode:readLockfile";
export const LOCAL_MODE_SAVE_ASSISTANT = "vellum:localMode:saveLockfileAssistant";
export const LOCAL_MODE_REPLACE_PLATFORM = "vellum:localMode:replacePlatformAssistants";
export const LOCAL_MODE_RETIRE = "vellum:localMode:retire";
export const LOCAL_MODE_WAKE = "vellum:localMode:wake";
export const LOCAL_MODE_GUARDIAN_TOKEN = "vellum:localMode:guardianToken";

// Menu
export const MENU_SET_PLATFORM_SESSION = "vellum:menu:setPlatformSession";

// Main window
export const MAIN_WINDOW_ENSURE_VISIBLE = "vellum:mainWindow:ensureVisible";
export const MAIN_WINDOW_SET_ONBOARDING = "vellum:mainWindow:setOnboarding";

// Power events
export const POWER_EVENT = "vellum:power:event";

// Deep links
export const DEEP_LINKS_DRAIN = "vellum:deepLinks:drain";
export const DEEP_LINKS_SUBSCRIBE = "vellum:deepLinks:subscribe";
export const DEEP_LINKS_UNSUBSCRIBE = "vellum:deepLinks:unsubscribe";
export const DEEP_LINKS_EVENT = "vellum:deepLinks:event";

// File open
export const FILE_OPEN_DRAIN = "vellum:fileOpen:drain";
export const FILE_OPEN_SUBSCRIBE = "vellum:fileOpen:subscribe";
export const FILE_OPEN_UNSUBSCRIBE = "vellum:fileOpen:unsubscribe";
export const FILE_OPEN_EVENT = "vellum:fileOpen:event";

// Feedback
export const FEEDBACK_DIAGNOSTICS = "vellum:feedback:diagnostics";
export const FEEDBACK_LOGS = "vellum:feedback:logs";

// Connectivity
export const CONNECTIVITY_GET = "vellum:connectivity:get";
export const CONNECTIVITY_STATE = "vellum:connectivity:state";
export const CONNECTIVITY_SET_DEVICE = "vellum:connectivity:device";
export const CONNECTIVITY_RETRY = "vellum:connectivity:retry";

// Notifications
export const NOTIFICATIONS_SHOW = "vellum:notifications:show";
export const NOTIFICATIONS_ACTION = "vellum:notifications:action";

// Bundle confirm
export const BUNDLE_CONFIRM_GET_DATA = "vellum:bundleConfirm:getData";
export const BUNDLE_CONFIRM_RESPOND = "vellum:bundleConfirm:respond";

// Quick input
export const QUICK_INPUT_SUBMIT = "vellum:quickInput:submit";
export const QUICK_INPUT_DISMISS = "vellum:quickInput:dismiss";

// Command palette
export const COMMAND_PALETTE_OPEN = "vellum:commandPalette:open";
export const COMMAND_PALETTE_DISMISS = "vellum:commandPalette:dismiss";
export const COMMAND_PALETTE_SELECT = "vellum:commandPalette:select";

// Dictation overlay
export const DICTATION_OVERLAY_SET_STATE = "vellum:dictationOverlay:setState";
export const DICTATION_OVERLAY_STATE_EVENT = "vellum:dictationOverlay:state";
export const DICTATION_OVERLAY_GET_STATE = "vellum:dictationOverlay:getState";

// Popout
export const POPOUT_OPEN = "vellum:popout:open";

// Auto-update
export const UPDATE_GET_STATE = "vellum:update:getState";
export const UPDATE_CHECK = "vellum:update:check";
export const UPDATE_INSTALL = "vellum:update:install";
export const UPDATE_STATE_EVENT = "vellum:update:state";
