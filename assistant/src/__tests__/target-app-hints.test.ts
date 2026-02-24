import { describe, test, expect } from 'bun:test';
import { resolveComputerUseTargetAppHint } from '../daemon/target-app-hints.js';

describe('resolveComputerUseTargetAppHint', () => {
  // ── Vellum (our app) ──────────────────────────────────────────────
  describe('Vellum', () => {
    test('matches "Vellum app"', () => {
      const result = resolveComputerUseTargetAppHint('open the Vellum app');
      expect(result).toEqual({ appName: 'Vellum Assistant', bundleId: 'com.vellum.vellum-assistant' });
    });

    test('matches "Velly desktop app"', () => {
      const result = resolveComputerUseTargetAppHint('use the Velly desktop app');
      expect(result).toEqual({ appName: 'Vellum Assistant', bundleId: 'com.vellum.vellum-assistant' });
    });

    test('matches "Vellum assistant"', () => {
      const result = resolveComputerUseTargetAppHint('test the Vellum assistant');
      expect(result).toEqual({ appName: 'Vellum Assistant', bundleId: 'com.vellum.vellum-assistant' });
    });
  });

  // ── Browsers ───────────────────────────────────────────────────────
  describe('Browsers', () => {
    test('matches "chrome"', () => {
      const result = resolveComputerUseTargetAppHint('open chrome and navigate to google.com');
      expect(result).toEqual({ appName: 'Google Chrome', bundleId: 'com.google.Chrome' });
    });

    test('matches "Google Chrome"', () => {
      const result = resolveComputerUseTargetAppHint('use Google Chrome to test the site');
      expect(result).toEqual({ appName: 'Google Chrome', bundleId: 'com.google.Chrome' });
    });

    test('matches "safari"', () => {
      const result = resolveComputerUseTargetAppHint('test in Safari');
      expect(result).toEqual({ appName: 'Safari', bundleId: 'com.apple.Safari' });
    });

    test('matches "firefox"', () => {
      const result = resolveComputerUseTargetAppHint('open Firefox');
      expect(result).toEqual({ appName: 'Firefox', bundleId: 'org.mozilla.firefox' });
    });

    test('matches "arc browser"', () => {
      const result = resolveComputerUseTargetAppHint('switch to Arc browser');
      expect(result).toEqual({ appName: 'Arc', bundleId: 'company.thebrowser.Browser' });
    });
  });

  // ── Communication ──────────────────────────────────────────────────
  describe('Communication', () => {
    test('matches "slack"', () => {
      const result = resolveComputerUseTargetAppHint('test slack typing');
      expect(result).toEqual({ appName: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' });
    });

    test('matches "discord"', () => {
      const result = resolveComputerUseTargetAppHint('open discord and join the call');
      expect(result).toEqual({ appName: 'Discord', bundleId: 'com.hnc.Discord' });
    });

    test('matches "zoom"', () => {
      const result = resolveComputerUseTargetAppHint('join the zoom meeting');
      expect(result).toEqual({ appName: 'zoom.us', bundleId: 'us.zoom.xos' });
    });

    test('matches "Microsoft Teams"', () => {
      const result = resolveComputerUseTargetAppHint('message them on Microsoft Teams');
      expect(result).toEqual({ appName: 'Microsoft Teams', bundleId: 'com.microsoft.teams2' });
    });

    test('matches "teams app"', () => {
      const result = resolveComputerUseTargetAppHint('open the teams app');
      expect(result).toEqual({ appName: 'Microsoft Teams', bundleId: 'com.microsoft.teams2' });
    });
  });

  // ── Terminals ──────────────────────────────────────────────────────
  describe('Terminals', () => {
    test('matches "warp"', () => {
      const result = resolveComputerUseTargetAppHint('open warp and run the command');
      expect(result).toEqual({ appName: 'Warp', bundleId: 'dev.warp.Warp-Stable' });
    });

    test('matches "open Terminal"', () => {
      const result = resolveComputerUseTargetAppHint('open terminal and run ls');
      expect(result).toEqual({ appName: 'Terminal', bundleId: 'com.apple.Terminal' });
    });

    test('matches "in Terminal"', () => {
      const result = resolveComputerUseTargetAppHint('run the command in terminal');
      expect(result).toEqual({ appName: 'Terminal', bundleId: 'com.apple.Terminal' });
    });

    test('matches "iterm"', () => {
      const result = resolveComputerUseTargetAppHint('switch to iterm');
      expect(result).toEqual({ appName: 'iTerm', bundleId: 'com.googlecode.iterm2' });
    });

    test('matches "iterm2"', () => {
      const result = resolveComputerUseTargetAppHint('use iterm2 for this');
      expect(result).toEqual({ appName: 'iTerm', bundleId: 'com.googlecode.iterm2' });
    });
  });

  // ── IDEs ───────────────────────────────────────────────────────────
  describe('IDEs', () => {
    test('matches "VS Code"', () => {
      const result = resolveComputerUseTargetAppHint('open VS Code');
      expect(result).toEqual({ appName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' });
    });

    test('matches "vscode"', () => {
      const result = resolveComputerUseTargetAppHint('open vscode');
      expect(result).toEqual({ appName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' });
    });

    test('matches "Visual Studio Code"', () => {
      const result = resolveComputerUseTargetAppHint('use Visual Studio Code');
      expect(result).toEqual({ appName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' });
    });

    test('matches "cursor"', () => {
      const result = resolveComputerUseTargetAppHint('open cursor and edit the file');
      expect(result).toEqual({ appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' });
    });

    test('matches "xcode"', () => {
      const result = resolveComputerUseTargetAppHint('build the project in xcode');
      expect(result).toEqual({ appName: 'Xcode', bundleId: 'com.apple.dt.Xcode' });
    });
  });

  // ── Productivity ───────────────────────────────────────────────────
  describe('Productivity', () => {
    test('matches "notion"', () => {
      const result = resolveComputerUseTargetAppHint('update the page in Notion');
      expect(result).toEqual({ appName: 'Notion', bundleId: 'notion.id' });
    });

    test('matches "figma"', () => {
      const result = resolveComputerUseTargetAppHint('check the design in Figma');
      expect(result).toEqual({ appName: 'Figma', bundleId: 'com.figma.Desktop' });
    });

    test('matches "finder"', () => {
      const result = resolveComputerUseTargetAppHint('browse files in Finder');
      expect(result).toEqual({ appName: 'Finder', bundleId: 'com.apple.finder' });
    });
  });

  // ── Apple apps (context-required) ──────────────────────────────────
  describe('Apple apps (context-required)', () => {
    test('"open Notes and write" returns Notes', () => {
      const result = resolveComputerUseTargetAppHint('open Notes and write something');
      expect(result).toEqual({ appName: 'Notes', bundleId: 'com.apple.Notes' });
    });

    test('"in Notes" returns Notes', () => {
      const result = resolveComputerUseTargetAppHint('create a list in notes');
      expect(result).toEqual({ appName: 'Notes', bundleId: 'com.apple.Notes' });
    });

    test('"test Notes" returns Notes', () => {
      const result = resolveComputerUseTargetAppHint('test notes search feature');
      expect(result).toEqual({ appName: 'Notes', bundleId: 'com.apple.Notes' });
    });

    test('"Notes app" returns Notes', () => {
      const result = resolveComputerUseTargetAppHint('check the notes app');
      expect(result).toEqual({ appName: 'Notes', bundleId: 'com.apple.Notes' });
    });

    test('"iMessage" returns Messages', () => {
      const result = resolveComputerUseTargetAppHint('send a text via iMessage');
      expect(result).toEqual({ appName: 'Messages', bundleId: 'com.apple.MobileSMS' });
    });

    test('"open Messages" returns Messages', () => {
      const result = resolveComputerUseTargetAppHint('open messages and reply');
      expect(result).toEqual({ appName: 'Messages', bundleId: 'com.apple.MobileSMS' });
    });

    test('"open Mail" returns Mail', () => {
      const result = resolveComputerUseTargetAppHint('open mail and check inbox');
      expect(result).toEqual({ appName: 'Mail', bundleId: 'com.apple.mail' });
    });

    test('"Mail app" returns Mail', () => {
      const result = resolveComputerUseTargetAppHint('use the mail app');
      expect(result).toEqual({ appName: 'Mail', bundleId: 'com.apple.mail' });
    });

    test('"System Settings" returns System Settings', () => {
      const result = resolveComputerUseTargetAppHint('open system settings');
      expect(result).toEqual({ appName: 'System Settings', bundleId: 'com.apple.systempreferences' });
    });

    test('"System Preferences" returns System Settings', () => {
      const result = resolveComputerUseTargetAppHint('check system preferences');
      expect(result).toEqual({ appName: 'System Settings', bundleId: 'com.apple.systempreferences' });
    });

    test('"check Settings" returns System Settings', () => {
      const result = resolveComputerUseTargetAppHint('check settings for accessibility');
      expect(result).toEqual({ appName: 'System Settings', bundleId: 'com.apple.systempreferences' });
    });

    test('"Settings app" returns System Settings', () => {
      const result = resolveComputerUseTargetAppHint('open the settings app');
      expect(result).toEqual({ appName: 'System Settings', bundleId: 'com.apple.systempreferences' });
    });
  });

  // ── False-positive prevention ──────────────────────────────────────
  describe('false positives', () => {
    test('"take notes about the meeting" does NOT return Notes', () => {
      const result = resolveComputerUseTargetAppHint('take notes about the meeting');
      expect(result).toBeUndefined();
    });

    test('"write notes for the class" does NOT return Notes', () => {
      const result = resolveComputerUseTargetAppHint('write notes for the class');
      expect(result).toBeUndefined();
    });

    test('"send mail to Bob" does NOT return Mail', () => {
      const result = resolveComputerUseTargetAppHint('send mail to Bob');
      expect(result).toBeUndefined();
    });

    test('"read the messages carefully" does NOT return Messages', () => {
      const result = resolveComputerUseTargetAppHint('read the messages carefully');
      expect(result).toBeUndefined();
    });

    test('"change the settings in the config file" does NOT return System Settings', () => {
      const result = resolveComputerUseTargetAppHint('change the settings in the config file');
      expect(result).toBeUndefined();
    });

    test('"terminal velocity" does NOT return Terminal', () => {
      const result = resolveComputerUseTargetAppHint('terminal velocity of the object');
      expect(result).toBeUndefined();
    });

    test('empty string returns undefined', () => {
      const result = resolveComputerUseTargetAppHint('');
      expect(result).toBeUndefined();
    });

    test('generic text returns undefined', () => {
      const result = resolveComputerUseTargetAppHint('do something for me please');
      expect(result).toBeUndefined();
    });
  });

  // ── Contextual task patterns ───────────────────────────────────────
  describe('contextual task patterns', () => {
    test('"test slack typing" returns Slack', () => {
      const result = resolveComputerUseTargetAppHint('test slack typing');
      expect(result).toEqual({ appName: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' });
    });

    test('"QA the discord voice chat" returns Discord', () => {
      const result = resolveComputerUseTargetAppHint('QA the discord voice chat');
      expect(result).toEqual({ appName: 'Discord', bundleId: 'com.hnc.Discord' });
    });

    test('"check chrome rendering" returns Chrome', () => {
      const result = resolveComputerUseTargetAppHint('check chrome rendering');
      expect(result).toEqual({ appName: 'Google Chrome', bundleId: 'com.google.Chrome' });
    });

    test('"launch terminal and run tests" returns Terminal', () => {
      const result = resolveComputerUseTargetAppHint('launch terminal and run tests');
      expect(result).toEqual({ appName: 'Terminal', bundleId: 'com.apple.Terminal' });
    });

    test('"use the terminal app to debug" returns Terminal', () => {
      const result = resolveComputerUseTargetAppHint('use the terminal app to debug');
      expect(result).toEqual({ appName: 'Terminal', bundleId: 'com.apple.Terminal' });
    });
  });
});
