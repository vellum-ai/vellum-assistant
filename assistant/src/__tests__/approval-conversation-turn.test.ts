import { describe, test, expect } from 'bun:test';
import { runApprovalConversationTurn } from '../runtime/approval-conversation-turn.js';
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalConversationResult,
} from '../runtime/http-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ApprovalConversationContext> = {}): ApprovalConversationContext {
  return {
    toolName: 'execute_shell',
    allowedActions: ['approve_once', 'approve_always', 'reject'],
    role: 'guardian',
    pendingApprovals: [{ runId: 'run-1', toolName: 'execute_shell' }],
    userMessage: 'yes, go ahead',
    ...overrides,
  };
}

function makeGenerator(result: ApprovalConversationResult): ApprovalConversationGenerator {
  return async () => result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runApprovalConversationTurn', () => {
  test('successful keep_pending response (non-decision message)', async () => {
    const result = await runApprovalConversationTurn(
      makeContext({ userMessage: 'what does this tool do?' }),
      makeGenerator({
        disposition: 'keep_pending',
        replyText: 'This tool runs shell commands. Would you like to approve it?',
      }),
    );
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toBe('This tool runs shell commands. Would you like to approve it?');
    expect(result.targetRunId).toBeUndefined();
  });

  test('successful approve_once response', async () => {
    const result = await runApprovalConversationTurn(
      makeContext(),
      makeGenerator({
        disposition: 'approve_once',
        replyText: 'Approved! Running the command now.',
        targetRunId: 'run-1',
      }),
    );
    expect(result.disposition).toBe('approve_once');
    expect(result.replyText).toBe('Approved! Running the command now.');
    expect(result.targetRunId).toBe('run-1');
  });

  test('successful reject response', async () => {
    const result = await runApprovalConversationTurn(
      makeContext(),
      makeGenerator({
        disposition: 'reject',
        replyText: 'Request denied.',
        targetRunId: 'run-1',
      }),
    );
    expect(result.disposition).toBe('reject');
    expect(result.replyText).toBe('Request denied.');
  });

  test('fail-closed on generator throwing an error', async () => {
    const throwingGenerator: ApprovalConversationGenerator = async () => {
      throw new Error('provider timeout');
    };
    const result = await runApprovalConversationTurn(makeContext(), throwingGenerator);
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toContain("couldn't process");
  });

  test('fail-closed on generator returning malformed output', async () => {
    const malformedGenerator: ApprovalConversationGenerator = async () => {
      // Return an object missing the required replyText
      return { disposition: 'approve_once', replyText: '' } as ApprovalConversationResult;
    };
    const result = await runApprovalConversationTurn(makeContext(), malformedGenerator);
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toContain("couldn't process");
  });

  test('fail-closed on invalid disposition', async () => {
    const badDisposition: ApprovalConversationGenerator = async () => {
      return { disposition: 'yolo' as 'approve_once', replyText: 'Sure!' };
    };
    const result = await runApprovalConversationTurn(makeContext(), badDisposition);
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toContain("couldn't process");
  });

  test('fail-closed when disposition is not in allowedActions', async () => {
    // Context only allows approve_once and reject (no approve_always)
    const restrictedContext = makeContext({
      allowedActions: ['approve_once', 'reject'],
    });

    const result = await runApprovalConversationTurn(
      restrictedContext,
      makeGenerator({
        disposition: 'approve_always',
        replyText: 'Approved permanently!',
        targetRunId: 'run-1',
      }),
    );
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toContain("couldn't process");
  });

  test('keep_pending is always allowed regardless of allowedActions', async () => {
    const restrictedContext = makeContext({
      allowedActions: ['approve_once', 'reject'],
    });

    const result = await runApprovalConversationTurn(
      restrictedContext,
      makeGenerator({
        disposition: 'keep_pending',
        replyText: 'Can you tell me more about this request?',
      }),
    );
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toBe('Can you tell me more about this request?');
  });

  test('fail-closed when targetRunId does not match any pending approval', async () => {
    const contextWithMultiple = makeContext({
      pendingApprovals: [
        { runId: 'run-1', toolName: 'execute_shell' },
        { runId: 'run-2', toolName: 'file_write' },
      ],
    });

    // Hallucinated run ID that doesn't match any pending approval
    const result = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: 'approve_once',
        replyText: 'Approved!',
        targetRunId: 'run-nonexistent',
      }),
    );
    expect(result.disposition).toBe('keep_pending');
    expect(result.replyText).toContain("couldn't process");
  });

  test('targetRunId validation when multiple pending approvals', async () => {
    const contextWithMultiple = makeContext({
      pendingApprovals: [
        { runId: 'run-1', toolName: 'execute_shell' },
        { runId: 'run-2', toolName: 'file_write' },
      ],
    });

    // Decision-bearing disposition without targetRunId should fail-close
    const resultWithoutTarget = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: 'approve_once',
        replyText: 'Approved!',
        // no targetRunId
      }),
    );
    expect(resultWithoutTarget.disposition).toBe('keep_pending');
    expect(resultWithoutTarget.replyText).toContain("couldn't process");

    // Decision-bearing disposition with targetRunId should succeed
    const resultWithTarget = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: 'approve_once',
        replyText: 'Approved!',
        targetRunId: 'run-1',
      }),
    );
    expect(resultWithTarget.disposition).toBe('approve_once');
    expect(resultWithTarget.targetRunId).toBe('run-1');

    // Non-decision disposition without targetRunId should pass through fine
    const resultKeepPending = await runApprovalConversationTurn(
      contextWithMultiple,
      makeGenerator({
        disposition: 'keep_pending',
        replyText: 'Which request would you like to approve?',
      }),
    );
    expect(resultKeepPending.disposition).toBe('keep_pending');
  });
});
