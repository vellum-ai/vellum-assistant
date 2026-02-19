import { describe, test, expect } from 'bun:test';
import {
  allComputerUseTools,
  computerUseClickTool,
  computerUseDoubleClickTool,
  computerUseRightClickTool,
  computerUseTypeTextTool,
  computerUseKeyTool,
  computerUseScrollTool,
  computerUseDragTool,
  computerUseWaitTool,
  computerUseOpenAppTool,
  computerUseRunAppleScriptTool,
  computerUseDoneTool,
  computerUseRespondTool,
} from '../tools/computer-use/definitions.js';
import { requestComputerControlTool } from '../tools/computer-use/request-computer-control.js';
import { forwardComputerUseProxyTool } from '../tools/computer-use/skill-proxy-bridge.js';
import type { ToolContext } from '../tools/types.js';

const ctx: ToolContext = {
  workingDir: '/tmp',
  sessionId: 'test-session',
  conversationId: 'test-conversation',
};

// ── Tool definitions ────────────────────────────────────────────────

describe('computer-use tool definitions', () => {
  test('allComputerUseTools contains 12 tools', () => {
    expect(allComputerUseTools.length).toBe(12);
  });

  test('all tools have proxy execution mode', () => {
    for (const tool of allComputerUseTools) {
      expect(tool.executionMode).toBe('proxy');
    }
    expect(requestComputerControlTool.executionMode).toBe('proxy');
  });

  test('all tools belong to computer-use category', () => {
    for (const tool of allComputerUseTools) {
      expect(tool.category).toBe('computer-use');
    }
    expect(requestComputerControlTool.category).toBe('computer-use');
  });

  test('all tools have unique names', () => {
    const names = allComputerUseTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('all tools have descriptions', () => {
    for (const tool of allComputerUseTools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ── Click tool variants ─────────────────────────────────────────────

describe('click tool variants', () => {
  for (const [tool, label] of [
    [computerUseClickTool, 'click'],
    [computerUseDoubleClickTool, 'double_click'],
    [computerUseRightClickTool, 'right_click'],
  ] as const) {
    test(`${tool.name} has correct name`, () => {
      expect(tool.name).toBe(`computer_use_${label}`);
    });

    test(`${tool.name} schema requires reasoning`, () => {
      const def = tool.getDefinition();
      expect(def.input_schema.required).toContain('reasoning');
    });

    test(`${tool.name} schema supports element_id and coordinates`, () => {
      const props = tool.getDefinition().input_schema.properties as Record<string, { type: string }>;
      expect(props.element_id.type).toBe('integer');
      expect(props.x.type).toBe('integer');
      expect(props.y.type).toBe('integer');
    });

    test(`${tool.name} execute throws proxy error`, () => {
      expect(() => tool.execute({}, ctx)).toThrow('Proxy tool');
    });
  }
});

// ── type_text ───────────────────────────────────────────────────────

describe('computer_use_type_text', () => {
  test('requires text and reasoning', () => {
    const def = computerUseTypeTextTool.getDefinition();
    expect(def.input_schema.required).toContain('text');
    expect(def.input_schema.required).toContain('reasoning');
  });

  test('execute throws proxy error', () => {
    expect(() => computerUseTypeTextTool.execute({}, ctx)).toThrow('Proxy tool');
  });
});

// ── key ─────────────────────────────────────────────────────────────

describe('computer_use_key', () => {
  test('requires key and reasoning', () => {
    const def = computerUseKeyTool.getDefinition();
    expect(def.input_schema.required).toContain('key');
    expect(def.input_schema.required).toContain('reasoning');
  });

  test('execute throws proxy error', () => {
    expect(() => computerUseKeyTool.execute({}, ctx)).toThrow('Proxy tool');
  });
});

// ── scroll ──────────────────────────────────────────────────────────

describe('computer_use_scroll', () => {
  test('requires direction, amount, and reasoning', () => {
    const def = computerUseScrollTool.getDefinition();
    expect(def.input_schema.required).toContain('direction');
    expect(def.input_schema.required).toContain('amount');
    expect(def.input_schema.required).toContain('reasoning');
  });

  test('direction enum includes up, down, left, right', () => {
    const props = computerUseScrollTool.getDefinition().input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.direction.enum).toEqual(['up', 'down', 'left', 'right']);
  });
});

// ── drag ────────────────────────────────────────────────────────────

describe('computer_use_drag', () => {
  test('supports source and destination coordinates', () => {
    const props = computerUseDragTool.getDefinition().input_schema.properties as Record<string, { type: string }>;
    expect(props.element_id.type).toBe('integer');
    expect(props.to_element_id.type).toBe('integer');
    expect(props.x.type).toBe('integer');
    expect(props.y.type).toBe('integer');
    expect(props.to_x.type).toBe('integer');
    expect(props.to_y.type).toBe('integer');
  });

  test('requires reasoning only', () => {
    const def = computerUseDragTool.getDefinition();
    expect(def.input_schema.required).toEqual(['reasoning']);
  });
});

// ── wait ────────────────────────────────────────────────────────────

describe('computer_use_wait', () => {
  test('requires duration_ms and reasoning', () => {
    const def = computerUseWaitTool.getDefinition();
    expect(def.input_schema.required).toContain('duration_ms');
    expect(def.input_schema.required).toContain('reasoning');
  });
});

// ── open_app ────────────────────────────────────────────────────────

describe('computer_use_open_app', () => {
  test('requires app_name and reasoning', () => {
    const def = computerUseOpenAppTool.getDefinition();
    expect(def.input_schema.required).toContain('app_name');
    expect(def.input_schema.required).toContain('reasoning');
  });
});

// ── run_applescript ─────────────────────────────────────────────────

describe('computer_use_run_applescript', () => {
  test('requires script and reasoning', () => {
    const def = computerUseRunAppleScriptTool.getDefinition();
    expect(def.input_schema.required).toContain('script');
    expect(def.input_schema.required).toContain('reasoning');
  });

  test('description warns against do shell script', () => {
    expect(computerUseRunAppleScriptTool.description).toContain('do shell script');
    expect(computerUseRunAppleScriptTool.description).toContain('blocked');
  });
});

// ── done ────────────────────────────────────────────────────────────

describe('computer_use_done', () => {
  test('requires summary', () => {
    const def = computerUseDoneTool.getDefinition();
    expect(def.input_schema.required).toContain('summary');
  });
});

// ── respond ─────────────────────────────────────────────────────────

describe('computer_use_respond', () => {
  test('requires answer and reasoning', () => {
    const def = computerUseRespondTool.getDefinition();
    expect(def.input_schema.required).toContain('answer');
    expect(def.input_schema.required).toContain('reasoning');
  });
});

// ── request_computer_control ────────────────────────────────────────

describe('computer_use_request_control', () => {
  test('requires task parameter', () => {
    const def = requestComputerControlTool.getDefinition();
    expect(def.input_schema.required).toContain('task');
  });

  test('execute throws proxy error', () => {
    expect(() => requestComputerControlTool.execute({}, ctx)).toThrow('surfaceProxyResolver');
  });
});

// ── skill-proxy-bridge ──────────────────────────────────────────────

describe('forwardComputerUseProxyTool', () => {
  test('returns error when no proxy resolver available', async () => {
    const result = await forwardComputerUseProxyTool('computer_use_click', {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no proxy resolver available');
    expect(result.content).toContain('computer_use_click');
  });

  test('delegates to proxy resolver when available', async () => {
    const ctxWithProxy: ToolContext = {
      ...ctx,
      proxyToolResolver: async (name: string, input: Record<string, unknown>) => ({
        content: `Forwarded ${name} with ${JSON.stringify(input)}`,
        isError: false,
      }),
    };

    const result = await forwardComputerUseProxyTool(
      'computer_use_screenshot',
      { reasoning: 'test' },
      ctxWithProxy,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Forwarded computer_use_screenshot');
    expect(result.content).toContain('test');
  });
});
