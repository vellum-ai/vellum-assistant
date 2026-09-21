import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DESKTOP_ACCESSIBILITY_SCRIPT } from "./desktop-accessibility-script.js";
import {
  DESKTOP_DISPLAY,
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
} from "./desktop-display.js";

interface AccessibleElement {
  bus: string;
  path: string;
  name: string;
  role: string;
  depth: number;
  states: string[];
  bounds: [number, number, number, number];
}
interface Snapshot {
  busId: string;
  nodes: AccessibleElement[];
  truncated: boolean;
}
type Query = (
  request: object,
  address: string,
  signal: AbortSignal,
) => Promise<unknown>;
const exec = promisify(execFile);
const query: Query = async (request, address, signal) => {
  const { stdout } = await exec(
    "/usr/bin/python3",
    ["-c", DESKTOP_ACCESSIBILITY_SCRIPT, JSON.stringify(request)],
    {
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        DISPLAY: DESKTOP_DISPLAY,
        DBUS_SESSION_BUS_ADDRESS: address,
      },
      signal,
      timeout: 3_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
};

function center(
  bounds: AccessibleElement["bounds"],
): { x: number; y: number } | undefined {
  const [x, y, width, height] = bounds;
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(DESKTOP_WIDTH, x + width);
  const bottom = Math.min(DESKTOP_HEIGHT, y + height);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return {
    x: Math.floor((left + right - 1) / 2),
    y: Math.floor((top + bottom - 1) / 2),
  };
}

export class DesktopAccessibility {
  private elements = new Map<number, AccessibleElement>();
  private observationId?: string;
  private busId?: string;
  private address?: string;

  constructor(private readonly run: Query = query) {}

  async observe(
    address: string,
    signal: AbortSignal,
  ): Promise<{ axTree?: string; userGuidance?: string }> {
    signal.throwIfAborted();
    this.elements.clear();
    this.busId = undefined;
    this.observationId = undefined;
    this.address = address;
    try {
      const snapshot = (await this.run(
        { operation: "observe" },
        address,
        signal,
      )) as Snapshot;
      signal.throwIfAborted();
      this.busId = snapshot.busId;
      const lines: string[] = [];
      for (const node of snapshot.nodes) {
        if (!center(node.bounds)) {
          continue;
        }
        const id = this.elements.size + 1;
        this.elements.set(id, node);
        lines.push(
          `${"  ".repeat(Math.min(node.depth, 20))}[${id}] ${node.role} ${JSON.stringify(node.name)} ${node.states.join(" ")}`.trimEnd(),
        );
      }
      return {
        axTree: lines.length ? lines.join("\n") : undefined,
        ...(!lines.length || snapshot.truncated
          ? {
              userGuidance:
                "Accessibility information is incomplete. Use screenshot coordinates for elements not listed.",
            }
          : {}),
      };
    } catch {
      signal.throwIfAborted();
      this.elements.clear();
      return {
        userGuidance:
          "Accessibility is unavailable. Use screenshot coordinates for this observation.",
      };
    }
  }

  bindObservation(id: string): void {
    this.observationId = id;
  }

  async resolve(
    id: number,
    observationId: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    signal.throwIfAborted();
    const target = this.elements.get(id);
    if (
      !target ||
      observationId !== this.observationId ||
      !this.address ||
      !this.busId
    ) {
      throw new Error(
        "Accessibility element ID is missing or stale. Observe again before acting.",
      );
    }
    try {
      const current = (await this.run(
        { operation: "resolve", busId: this.busId, target },
        this.address,
        signal,
      )) as AccessibleElement;
      signal.throwIfAborted();
      const point = center(current.bounds);
      if (point) {
        return point;
      }
    } catch {
      signal.throwIfAborted();
    }
    throw new Error(
      "Accessibility element is unavailable or outside the screen. Observe again before acting.",
    );
  }
}
