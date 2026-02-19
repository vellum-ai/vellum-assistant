import { useState, type ReactElement } from "react";
import { basename } from "node:path";
import { Box, render as inkRender, Text, useInput } from "ink";
import { getSocketPath, getWorkspaceDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";

const LEFT_PANEL_WIDTH = 36;

const VELLY_ART = [
  "    ,___,",
  "   ( O O )",
  "    /)V(\\",
  "   //   \\\\",
  '  /"     "\\',
  "  ^       ^",
];

export interface MainScreenLayout {
  height: number;
  statusLine: number;
  statusCol: number;
}

function DefaultMainScreen(): ReactElement {
  const socketPath = getSocketPath();
  const workspace = getWorkspaceDir();
  const dirName = basename(workspace);

  const tips = [
    "Send a message to start chatting",
    "Use /help to see available commands",
  ];

  const leftLines = [
    " ",
    "    Meet your Assistant!",
    " ",
    ...VELLY_ART.map((l) => `  ${l}`),
    " ",
    `  ${socketPath}`,
    `  ~/${dirName}`,
  ];

  const rightLines = [
    " ",
    "Tips for getting started",
    ...tips,
    " ",
    "Daemon",
    "connecting...",
    "Version",
    APP_VERSION,
    "Status",
    "checking...",
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <Box flexDirection="column" width={72}>
      <Text dimColor>{"── Vellum " + "─".repeat(62)}</Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width={LEFT_PANEL_WIDTH}>
          {Array.from({ length: maxLines }, (_, i) => {
            const line = leftLines[i] ?? " ";
            if (i === 1) {
              return (
                <Text key={i} bold>
                  {line}
                </Text>
              );
            }
            if (i > 2 && i <= 2 + VELLY_ART.length) {
              return (
                <Text key={i} color="magenta">
                  {line}
                </Text>
              );
            }
            if (i > 2 + VELLY_ART.length) {
              return (
                <Text key={i} dimColor>
                  {line}
                </Text>
              );
            }
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
        <Box flexDirection="column">
          {Array.from({ length: maxLines }, (_, i) => {
            const line = rightLines[i] ?? " ";
            const isHeading = i === 1 || i === 6;
            const isDim = i === 5 || i === 7 || i === 9;
            if (isHeading) {
              return (
                <Text key={i} color="magenta">
                  {line}
                </Text>
              );
            }
            if (isDim) {
              return (
                <Text key={i} dimColor>
                  {line}
                </Text>
              );
            }
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
      </Box>
      <Text dimColor>{"─".repeat(72)}</Text>
      <Text> </Text>
      <Text dimColor> ? for shortcuts</Text>
      <Text> </Text>
    </Box>
  );
}

export function renderMainScreen(): MainScreenLayout {
  const leftLineCount = 3 + VELLY_ART.length + 3;
  const rightLineCount = 11;
  const maxLines = Math.max(leftLineCount, rightLineCount);

  const { unmount } = inkRender(<DefaultMainScreen />, {
    exitOnCtrlC: false,
  });
  unmount();

  const statusCanvasLine = rightLineCount + 1;
  const statusCol = LEFT_PANEL_WIDTH + 1;
  const height = 1 + maxLines + 4;

  return { height, statusLine: statusCanvasLine, statusCol };
}

export function updateStatusText(
  layout: MainScreenLayout,
  text: string,
): void {
  process.stdout.write(
    `\x1b7\x1b[${layout.statusLine};${layout.statusCol}H\x1b[K${text}\x1b8`,
  );
}

export function updateDaemonText(
  layout: MainScreenLayout,
  text: string,
): void {
  const daemonLine = layout.statusLine - 4;
  process.stdout.write(
    `\x1b7\x1b[${daemonLine};${layout.statusCol}H\x1b[K\x1b[35m${text}\x1b[0m\x1b8`,
  );
}

interface SelectionWindowProps {
  title: string;
  options: string[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}

function SelectionWindow({ title, options, onSelect, onCancel }: SelectionWindowProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev + 1) % options.length);
    } else if (key.return) {
      onSelect(selectedIndex);
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
    }
  });

  const windowWidth = 60;
  const borderH = "\u2500".repeat(Math.max(0, windowWidth - title.length - 4));

  return (
    <Box flexDirection="column" width={windowWidth}>
      <Text>{"\u250C\u2500 " + title + " " + borderH + "\u2510"}</Text>
      {options.map((option, i) => {
        const marker = i === selectedIndex ? "\u276F" : " ";
        const padding = " ".repeat(Math.max(0, windowWidth - option.length - 6));
        return (
          <Text key={i}>
            {"\u2502 "}
            <Text color={i === selectedIndex ? "cyan" : undefined}>{marker}</Text>
            {" "}
            <Text bold={i === selectedIndex}>{option}</Text>
            {padding}
            {"\u2502"}
          </Text>
        );
      })}
      <Text>{"\u2514" + "\u2500".repeat(windowWidth - 2) + "\u2518"}</Text>
      <Text dimColor>{"  \u2191/\u2193 navigate  Enter select  Esc cancel"}</Text>
    </Box>
  );
}

export function showSelectionWindow(
  title: string,
  options: string[],
  rl: { pause: () => void; resume: () => void },
): Promise<number> {
  rl.pause();

  return new Promise<number>((resolve) => {
    let resolved = false;

    const instance = inkRender(
      <SelectionWindow
        title={title}
        options={options}
        onSelect={(index) => {
          if (resolved) {
            return;
          }
          resolved = true;
          instance.clear();
          instance.unmount();
          rl.resume();
          resolve(index);
        }}
        onCancel={() => {
          if (resolved) {
            return;
          }
          resolved = true;
          instance.clear();
          instance.unmount();
          rl.resume();
          resolve(-1);
        }}
      />,
      { exitOnCtrlC: false, patchConsole: false },
    );
  });
}
