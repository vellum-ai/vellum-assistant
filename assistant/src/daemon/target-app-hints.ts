export interface ComputerUseTargetAppHint {
  appName: string;
  bundleId?: string;
}

/**
 * Context-requiring pattern wrapper: for generic words like "notes", "mail",
 * "terminal", "messages", "settings" that could appear in normal sentences,
 * we require the word to appear in an app-like context.
 *
 * Matches patterns like:
 *   "open Notes", "in Terminal", "test Notes", "Notes app",
 *   "QA notes search", "launch Terminal"
 *
 * Does NOT match casual uses like "take notes" or "send mail".
 */
function contextPattern(word: string): RegExp {
  // Action verbs / prepositions that signal app-intent.
  // Deliberately excludes "the" — too many false positives
  // ("the settings in the config", "the messages carefully").
  return new RegExp(
    `(?:(?:(?:open|launch|switch\\s+to|in|test|qa|check|use)\\s+)${word}|${word}\\s+app)\\b`,
    'i',
  );
}

interface AppHintEntry {
  patterns: RegExp[];
  appName: string;
  bundleId: string;
}

/**
 * Ordered table of app hints. Entries are checked top-to-bottom; first match wins.
 * More specific apps (Vellum) come before generic ones.
 *
 * For unique app names (Slack, Chrome, Discord, etc.), simple word-boundary
 * matching is sufficient. For generic words (notes, mail, terminal, messages,
 * settings), we use `contextPattern` to avoid false positives like
 * "take notes about the meeting" or "send mail to Bob".
 */
export const APP_HINTS: AppHintEntry[] = [
  // Vellum (our app — highest priority)
  {
    patterns: [/\b(vellum|velly)\s+(desktop\s+)?app\b/, /\b(vellum|velly)\s+assistant\b/],
    appName: 'Vellum Assistant',
    bundleId: 'com.vellum.vellum-assistant',
  },
  // Browsers
  {
    patterns: [/\bchrome\b/, /\bgoogle\s+chrome\b/],
    appName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
  },
  {
    patterns: [/\bsafari\b/],
    appName: 'Safari',
    bundleId: 'com.apple.Safari',
  },
  {
    patterns: [/\bfirefox\b/],
    appName: 'Firefox',
    bundleId: 'org.mozilla.firefox',
  },
  {
    patterns: [/\barc\s+browser\b/],
    appName: 'Arc',
    bundleId: 'company.thebrowser.Browser',
  },
  // Communication
  {
    patterns: [/\bslack\b/],
    appName: 'Slack',
    bundleId: 'com.tinyspeck.slackmacgap',
  },
  {
    patterns: [/\bdiscord\b/],
    appName: 'Discord',
    bundleId: 'com.hnc.Discord',
  },
  {
    patterns: [/\bzoom\b/],
    appName: 'zoom.us',
    bundleId: 'us.zoom.xos',
  },
  {
    patterns: [/\bmicrosoft\s+teams\b/, /\bteams\s+app\b/],
    appName: 'Microsoft Teams',
    bundleId: 'com.microsoft.teams2',
  },
  // Terminals
  {
    patterns: [/\bwarp\b/],
    appName: 'Warp',
    bundleId: 'dev.warp.Warp-Stable',
  },
  {
    patterns: [contextPattern('terminal')],
    appName: 'Terminal',
    bundleId: 'com.apple.Terminal',
  },
  {
    patterns: [/\biterm2?\b/],
    appName: 'iTerm',
    bundleId: 'com.googlecode.iterm2',
  },
  // IDEs
  {
    patterns: [/\b(vs\s*code|visual\s+studio\s+code)\b/],
    appName: 'Visual Studio Code',
    bundleId: 'com.microsoft.VSCode',
  },
  {
    patterns: [/\bcursor\b/],
    appName: 'Cursor',
    bundleId: 'com.todesktop.230313mzl4w4u92',
  },
  {
    patterns: [/\bxcode\b/],
    appName: 'Xcode',
    bundleId: 'com.apple.dt.Xcode',
  },
  // Productivity
  {
    patterns: [/\bnotion\b/],
    appName: 'Notion',
    bundleId: 'notion.id',
  },
  {
    patterns: [/\bfigma\b/],
    appName: 'Figma',
    bundleId: 'com.figma.Desktop',
  },
  {
    patterns: [/\bfinder\b/],
    appName: 'Finder',
    bundleId: 'com.apple.finder',
  },
  // Apple apps (generic words — require context)
  {
    patterns: [contextPattern('notes')],
    appName: 'Notes',
    bundleId: 'com.apple.Notes',
  },
  {
    patterns: [contextPattern('messages'), /\bimessage\b/],
    appName: 'Messages',
    bundleId: 'com.apple.MobileSMS',
  },
  {
    patterns: [contextPattern('mail')],
    appName: 'Mail',
    bundleId: 'com.apple.mail',
  },
  {
    patterns: [/\bsystem\s+settings\b/, /\bsystem\s+preferences\b/, contextPattern('settings')],
    appName: 'System Settings',
    bundleId: 'com.apple.systempreferences',
  },
];

/**
 * Resolve an explicit target app hint from user task text.
 * This is intentionally conservative: only high-confidence patterns should
 * lock the CU session to an app.
 *
 * Iterates through APP_HINTS in order; returns the first match.
 */
export function resolveComputerUseTargetAppHint(task: string): ComputerUseTargetAppHint | undefined {
  const normalized = task.toLowerCase();

  for (const entry of APP_HINTS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(normalized)) {
        return { appName: entry.appName, bundleId: entry.bundleId };
      }
    }
  }

  return undefined;
}
