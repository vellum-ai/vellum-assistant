/**
 * Computer-use tool definitions.
 *
 * These tools mirror the macOS client's ToolDefinitions.swift schemas, prefixed
 * with `cu_` to avoid collisions with existing daemon tools.  They are all
 * proxy tools — execution is forwarded to a connected macOS client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proxyExecute(): Promise<ToolExecutionResult> {
  throw new Error('Proxy tool: execution must be forwarded to the connected client');
}

function makeClickTool(name: string, verb: string): Tool {
  return {
    name,
    description: `${verb} on a UI element by its [ID] from the accessibility tree, or at raw screen coordinates as fallback.`,
    category: 'computer-use',
    defaultRiskLevel: RiskLevel.Low,
    executionMode: 'proxy',

    getDefinition(): ToolDefinition {
      return {
        name: this.name,
        description: this.description,
        input_schema: {
          type: 'object',
          properties: {
            element_id: {
              type: 'integer',
              description: 'The [ID] number of the element from the accessibility tree (preferred)',
            },
            x: {
              type: 'integer',
              description: 'X coordinate on screen (fallback when no element_id)',
            },
            y: {
              type: 'integer',
              description: 'Y coordinate on screen (fallback when no element_id)',
            },
            reasoning: {
              type: 'string',
              description: `Explanation of what you see and why you are ${verb.toLowerCase()}ing here`,
            },
          },
          required: ['reasoning'],
        },
      };
    },

    execute: proxyExecute,
  };
}

// ---------------------------------------------------------------------------
// Click variants
// ---------------------------------------------------------------------------

export const cuClickTool = makeClickTool('cu_click', 'Click');
export const cuDoubleClickTool = makeClickTool('cu_double_click', 'Double-click');
export const cuRightClickTool = makeClickTool('cu_right_click', 'Right-click');

// ---------------------------------------------------------------------------
// type_text
// ---------------------------------------------------------------------------

export const cuTypeTextTool: Tool = {
  name: 'cu_type_text',
  description: 'Type text at the current cursor position. The target field must already be focused (click it first).',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to type',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of what you are typing and why',
          },
        },
        required: ['text', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

export const cuKeyTool: Tool = {
  name: 'cu_key',
  description: 'Press a key or keyboard shortcut. Supported: enter, tab, escape, backspace, delete, up, down, left, right, space, cmd+a, cmd+c, cmd+v, cmd+z, cmd+tab, cmd+w, shift+tab, option+tab',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key or shortcut to press (e.g. enter, tab, cmd+c, cmd+v)',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of why you are pressing this key',
          },
        },
        required: ['key', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export const cuScrollTool: Tool = {
  name: 'cu_scroll',
  description: 'Scroll within an element by its [ID], or at raw screen coordinates as fallback.',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          element_id: {
            type: 'integer',
            description: 'The [ID] number of the element to scroll within (preferred)',
          },
          x: {
            type: 'integer',
            description: 'X coordinate on screen (fallback when no element_id)',
          },
          y: {
            type: 'integer',
            description: 'Y coordinate on screen (fallback when no element_id)',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction',
          },
          amount: {
            type: 'integer',
            description: 'Scroll amount (1-10)',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of why you are scrolling',
          },
        },
        required: ['direction', 'amount', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

export const cuDragTool: Tool = {
  name: 'cu_drag',
  description: 'Drag from one element or position to another. Use for moving files, resizing windows, rearranging items, or adjusting sliders.',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          element_id: {
            type: 'integer',
            description: 'The [ID] of the source element to drag from (preferred)',
          },
          x: {
            type: 'integer',
            description: 'Source X coordinate (fallback when no element_id)',
          },
          y: {
            type: 'integer',
            description: 'Source Y coordinate (fallback when no element_id)',
          },
          to_element_id: {
            type: 'integer',
            description: 'The [ID] of the destination element to drag to (preferred)',
          },
          to_x: {
            type: 'integer',
            description: 'Destination X coordinate (fallback when no to_element_id)',
          },
          to_y: {
            type: 'integer',
            description: 'Destination Y coordinate (fallback when no to_element_id)',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of what you are dragging and why',
          },
        },
        required: ['reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

export const cuWaitTool: Tool = {
  name: 'cu_wait',
  description: 'Wait for the UI to update',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'integer',
            description: 'Milliseconds to wait',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of what you are waiting for',
          },
        },
        required: ['duration_ms', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------

export const cuOpenAppTool: Tool = {
  name: 'cu_open_app',
  description: 'Open or switch to a macOS application by name. Preferred over cmd+tab for switching apps — more reliable and explicit.',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the application to open (e.g. "Slack", "Safari", "Google Chrome", "VS Code")',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of why you need to open or switch to this app',
          },
        },
        required: ['app_name', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// run_applescript
// ---------------------------------------------------------------------------

export const cuRunAppleScriptTool: Tool = {
  name: 'cu_run_applescript',
  description:
    'Execute an AppleScript to control applications via Apple\'s scripting bridge. ' +
    'Use this for operations that are more reliable through scripting than UI interaction: ' +
    'setting a browser URL directly, navigating Finder to a path, querying app state ' +
    '(tab count, window titles, document status), or clicking deeply nested menu items. ' +
    'The script\'s return value (if any) will be reported back. ' +
    'NEVER use "do shell script" — it is blocked for security. ' +
    'Keep scripts short and targeted to a single operation.',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'The AppleScript source code to execute',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of what this script does and why AppleScript is better than UI interaction for this step',
          },
        },
        required: ['script', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

export const cuDoneTool: Tool = {
  name: 'cu_done',
  description: 'Task is complete',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Human-readable summary of what was accomplished',
          },
        },
        required: ['summary'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export const cuRespondTool: Tool = {
  name: 'cu_respond',
  description: 'Respond directly to the user with a text answer. Use this when the user is asking a question (about their schedule, meetings, calendar, etc.) rather than asking you to control the computer.',
  category: 'computer-use',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            description: 'The text answer to display to the user',
          },
          reasoning: {
            type: 'string',
            description: 'Explanation of how you determined the answer',
          },
        },
        required: ['answer', 'reasoning'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const allComputerUseTools: Tool[] = [
  cuClickTool,
  cuDoubleClickTool,
  cuRightClickTool,
  cuTypeTextTool,
  cuKeyTool,
  cuScrollTool,
  cuDragTool,
  cuWaitTool,
  cuOpenAppTool,
  cuRunAppleScriptTool,
  cuDoneTool,
  cuRespondTool,
];
