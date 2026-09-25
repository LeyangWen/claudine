import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsp from 'fs/promises';
import { ConversationParser } from '../providers/ConversationParser';
import { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from '../constants';
import * as fixtures from './fixtures/sample-conversations';

// Mock fs/promises module
vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  readFile: vi.fn().mockResolvedValue(''),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  open: vi.fn(),
}));

const mockStat = vi.mocked(fsp.stat);
const mockReadFile = vi.mocked(fsp.readFile);

describe('ConversationParser', () => {
  let parser: ConversationParser;

  beforeEach(() => {
    parser = new ConversationParser();
    vi.clearAllMocks();
    // Restore default mock behavior after clearAllMocks
    vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));
  });

  function parseContent(content: string, filePath = '/home/user/.claude/projects/test-project/abc123.jsonl') {
    const bytes = Buffer.byteLength(content, 'utf-8');
    mockStat.mockResolvedValue({ size: bytes } as any);
    mockReadFile.mockResolvedValue(content);
    return parser.parseFile(filePath);
  }

  describe('parseFile', () => {
    it('returns null for non-jsonl files', async () => {
      const result = await parser.parseFile('/path/to/file.txt');
      expect(result).toBeNull();
    });

    it('returns null for empty content', async () => {
      const result = await parseContent(fixtures.emptyContent);
      expect(result).toBeNull();
    });

    it('returns null for content with only metadata entries', async () => {
      const result = await parseContent(fixtures.onlyMetadataContent);
      expect(result).toBeNull();
    });

    it('skips malformed JSON lines gracefully', async () => {
      const content = [
        'not valid json',
        fixtures.userMessage('Valid message after bad line', 10),
        '{also broken',
        fixtures.assistantMessage('Valid assistant response', 9),
      ].join('\n');
      const result = await parseContent(content);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Valid message after bad line');
    });

    it('extracts session ID from file path', async () => {
      const result = await parseContent(fixtures.completedConversation, '/path/to/abc-123-def.jsonl');
      expect(result!.id).toBe('abc-123-def');
    });
  });

  describe('title extraction', () => {
    it('extracts title from first user message', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.title).toBe('Fix the login bug in auth.ts');
    });

    it(`truncates long titles to ${MAX_TITLE_LENGTH} characters`, async () => {
      const longText = 'A'.repeat(100);
      const content = [
        fixtures.userMessage(longText, 10),
        fixtures.assistantMessage('OK', 9),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      expect(result!.title).toMatch(/\.\.\.$/);
    });

    it('strips markup tags from title', async () => {
      const result = await parseContent(fixtures.markupConversation);
      expect(result!.title).toBe('Fix the typo in the header');
      expect(result!.title).not.toContain('ide_opened_file');
    });

    it('prefers the session title Claude Code recorded, last record wins', async () => {
      const content = [
        fixtures.userMessage('please look at the flaky login test', 10),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Investigate flaky login test', sessionId: 's1' }),
        fixtures.assistantMessage('Looking now.', 9),
        JSON.stringify({ type: 'custom-title', customTitle: '  Fix flaky login test  ', sessionId: 's1' }),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.title).toBe('Fix flaky login test');
    });

    it('falls back to the first user message when no title record exists', async () => {
      const content = [
        JSON.stringify({ type: 'ai-title', aiTitle: '   ', sessionId: 's1' }),
        fixtures.userMessage('Rename the config loader', 10),
        fixtures.assistantMessage('Done.', 9),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.title).toBe('Rename the config loader');
    });

    it('returns "Untitled Conversation" when no user text', async () => {
      const content = [
        fixtures.assistantMessage('Hello!', 10),
      ].join('\n');
      // Assistant-only won't produce a conversation (no user message with text)
      // But an assistant message still counts as a message
      const result = await parseContent(content);
      expect(result!.title).toBe('Untitled Conversation');
    });
  });

  describe('description extraction', () => {
    it('extracts description from first assistant message', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.description).toContain('fixed the login bug');
    });

    it(`truncates long descriptions to ${MAX_DESCRIPTION_LENGTH} characters`, async () => {
      const content = [
        fixtures.userMessage('Do something', 10),
        fixtures.assistantMessage('B'.repeat(300), 9),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    });
  });

  describe('status detection', () => {
    it('detects todo status (no assistant response)', async () => {
      const result = await parseContent(fixtures.todoConversation);
      expect(result!.status).toBe('todo');
    });

    it('detects in-review from completion phrases', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.status).toBe('in-review');
    });

    it('detects needs-input from question patterns', async () => {
      const result = await parseContent(fixtures.needsInputConversation);
      expect(result!.status).toBe('needs-input');
    });

    it('detects needs-input from AskUserQuestion tool use', async () => {
      const result = await parseContent(fixtures.askUserQuestionConversation);
      expect(result!.status).toBe('needs-input');
    });

    it('detects in-progress when last message is from user', async () => {
      const result = await parseContent(fixtures.inProgressConversation);
      expect(result!.status).toBe('in-progress');
    });

    it('detects needs-input when recent messages have errors', async () => {
      const result = await parseContent(fixtures.errorConversation);
      expect(result!.status).toBe('needs-input');
    });
  });

  describe('agent detection', () => {
    it('always includes main Claude agent', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.agents).toHaveLength(1);
      expect(result!.agents[0].id).toBe('claude-main');
      expect(result!.agents[0].name).toBe('Claude');
    });

    it('detects sub-agents from Task tool uses', async () => {
      const result = await parseContent(fixtures.subAgentConversation);
      expect(result!.agents.length).toBeGreaterThanOrEqual(3);
      const agentIds = result!.agents.map(a => a.id);
      expect(agentIds).toContain('agent-Explore');
      expect(agentIds).toContain('agent-Plan');
    });

    it('deduplicates sub-agents by type', async () => {
      const content = [
        fixtures.userMessage('Do work', 30),
        fixtures.assistantMessage('', 28, [
          { name: 'Task', input: { subagent_type: 'Explore', description: 'First explore' } },
        ]),
        fixtures.assistantMessage('', 25, [
          { name: 'Task', input: { subagent_type: 'Explore', description: 'Second explore' } },
        ]),
        fixtures.assistantMessage('Done!', 20),
      ].join('\n');
      const result = await parseContent(content);
      const exploreAgents = result!.agents.filter(a => a.id === 'agent-Explore');
      expect(exploreAgents).toHaveLength(1);
    });
  });

  describe('git branch detection', () => {
    it('extracts git branch from entry metadata', async () => {
      const result = await parseContent(fixtures.gitBranchConversation);
      expect(result!.gitBranch).toBe('feature/dark-mode');
    });
  });

  describe('error detection', () => {
    it('detects errors in conversations', async () => {
      const result = await parseContent(fixtures.errorConversation);
      expect(result!.hasError).toBe(true);
    });

    it('marks clean conversations as error-free', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.hasError).toBe(false);
    });
  });

  describe('interruption detection', () => {
    it('detects interrupted conversations via toolUseResult', async () => {
      const result = await parseContent(fixtures.interruptedConversation);
      expect(result!.isInterrupted).toBe(true);
    });

    it('marks uninterrupted conversations correctly', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.isInterrupted).toBe(false);
    });
  });

  describe('question detection', () => {
    it('detects questions from AskUserQuestion tool', async () => {
      const result = await parseContent(fixtures.askUserQuestionConversation);
      expect(result!.hasQuestion).toBe(true);
    });

    it('no question in completed conversations', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.hasQuestion).toBe(false);
    });
  });

  describe('category classification', () => {
    it('classifies based on conversation content', async () => {
      const result = await parseContent(fixtures.completedConversation);
      // "Fix the login bug" → should be classified as bug
      expect(result!.category).toBe('bug');
    });
  });

  describe('timestamps', () => {
    it('uses JSONL timestamps for createdAt and updatedAt', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
      expect(result!.updatedAt.getTime()).toBeGreaterThanOrEqual(result!.createdAt.getTime());
    });
  });

  // ── BUG regression tests ──────────────────────────────────────────

  describe('BUG1 — sidechain filtering', () => {
    it('returns null for conversations where all messages are sidechain', async () => {
      const result = await parseContent(fixtures.sidechainOnlyConversation);
      expect(result).toBeNull();
    });

    it('ignores sidechain messages when extracting title/description', async () => {
      const result = await parseContent(fixtures.mixedSidechainConversation);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Implement the login page');
      expect(result!.description).not.toContain('Sidechain noise');
    });
  });

  describe('BUG3 — empty/meaningless conversations', () => {
    it('returns null for conversations with only system-reminder content', async () => {
      const result = await parseContent(fixtures.emptyMeaninglessConversation);
      expect(result).toBeNull();
    });

    it('returns null for conversations with only assistant tool-use and no user text', async () => {
      const result = await parseContent(fixtures.noUserTextConversation);
      // No user text, no assistant text → empty conversation
      expect(result).toBeNull();
    });
  });

  describe('rate limit detection', () => {
    it('detects rate limit in assistant text', async () => {
      const result = await parseContent(fixtures.rateLimitConversation);
      expect(result).not.toBeNull();
      expect(result!.isRateLimited).toBe(true);
      expect(result!.rateLimitResetDisplay).toBe('10am (Europe/Zurich)');
      expect(result!.rateLimitResetTime).toBeDefined();
    });

    it('detects rate limit in tool_result text', async () => {
      const result = await parseContent(fixtures.rateLimitToolResultConversation);
      expect(result).not.toBeNull();
      expect(result!.isRateLimited).toBe(true);
      expect(result!.rateLimitResetDisplay).toBe('2:30pm (America/New_York)');
    });

    it('does not flag resolved rate limits (new activity after limit)', async () => {
      const result = await parseContent(fixtures.rateLimitResolvedConversation);
      expect(result).not.toBeNull();
      expect(result!.isRateLimited).toBe(false);
    });

    it('marks rate-limited conversations as needs-input', async () => {
      const result = await parseContent(fixtures.rateLimitConversation);
      expect(result!.status).toBe('needs-input');
    });

    it('clean conversations are not rate-limited', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result!.isRateLimited).toBe(false);
      expect(result!.rateLimitResetDisplay).toBeUndefined();
      expect(result!.rateLimitResetTime).toBeUndefined();
    });
  });

  describe('parseResetTime', () => {
    it('parses "10am" in a valid timezone', () => {
      const result = ConversationParser.parseResetTime('10am', 'Europe/Zurich');
      expect(result).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(result!).toISOString()).toBe(result);
    });

    it('parses "2:30pm" format', () => {
      const result = ConversationParser.parseResetTime('2:30pm', 'America/New_York');
      expect(result).toBeDefined();
      const d = new Date(result!);
      // Should be in the future
      expect(d.getTime()).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
    });

    it('returns undefined for invalid time format', () => {
      const result = ConversationParser.parseResetTime('invalid', 'UTC');
      expect(result).toBeUndefined();
    });

    it('returns undefined for invalid timezone', () => {
      const result = ConversationParser.parseResetTime('10am', 'Not/A/Timezone');
      expect(result).toBeUndefined();
    });
  });

  // ── BUG5 — False "needs input" while agent is working ────────────

  describe('BUG5 — active tool execution should not trigger needs-input', () => {
    it('detects in-progress (not needs-input) when Read tool is executing', async () => {
      const result = await parseContent(fixtures.activeToolExecutingConversation);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('in-progress');
      expect(result!.hasQuestion).toBe(false);
    });

    it('detects in-progress (not needs-input) when Task sub-agent is executing', async () => {
      const result = await parseContent(fixtures.activeSubAgentConversation);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('in-progress');
      expect(result!.hasQuestion).toBe(false);
    });

    it('detects in-progress (not needs-input) when Bash tool is executing', async () => {
      const result = await parseContent(fixtures.activeBashConversation);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('in-progress');
      expect(result!.hasQuestion).toBe(false);
    });

    it('detects in-progress (not needs-input) when TodoWrite is executing', async () => {
      const result = await parseContent(fixtures.activeTodoWriteConversation);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('in-progress');
      expect(result!.hasQuestion).toBe(false);
    });

    it('still detects needs-input for AskUserQuestion (not a false positive)', async () => {
      const result = await parseContent(fixtures.askUserQuestionConversation);
      expect(result!.status).toBe('needs-input');
      expect(result!.hasQuestion).toBe(true);
    });

    it('still detects needs-input for question text patterns', async () => {
      const result = await parseContent(fixtures.needsInputConversation);
      expect(result!.status).toBe('needs-input');
    });

    it('does NOT trigger needs-input for "should implement" (BUG5b regex false positive)', async () => {
      const result = await parseContent(fixtures.shouldImplementConversation);
      expect(result).not.toBeNull();
      // "should implement" must not match "should i" pattern
      expect(result!.status).not.toBe('needs-input');
    });

    it('does NOT trigger needs-input when a question was already answered (BUG5b)', async () => {
      const result = await parseContent(fixtures.answeredQuestionConversation);
      expect(result).not.toBeNull();
      // User responded after the question → conversation moved on
      expect(result!.status).not.toBe('needs-input');
    });
  });

  describe('sidechain activity dots', () => {
    it('collects sidechain steps with correct statuses', async () => {
      const result = await parseContent(fixtures.sidechainActivityConversation);
      expect(result).not.toBeNull();
      expect(result!.sidechainSteps).toBeDefined();
      expect(result!.sidechainSteps).toHaveLength(3);
      // running (assistant tool_use), completed (tool_result ok), failed (tool_result error)
      expect(result!.sidechainSteps![0].status).toBe('running');
      expect(result!.sidechainSteps![0].toolName).toBe('Bash');
      expect(result!.sidechainSteps![1].status).toBe('completed');
      expect(result!.sidechainSteps![2].status).toBe('failed');
    });

    it('keeps only the last 3 sidechain steps', async () => {
      const result = await parseContent(fixtures.manySidechainStepsConversation);
      expect(result).not.toBeNull();
      expect(result!.sidechainSteps).toHaveLength(3);
      // Last 3 of 5 entries: Tool2, Tool3, Tool4
      expect(result!.sidechainSteps![0].toolName).toBe('Tool2');
      expect(result!.sidechainSteps![1].toolName).toBe('Tool3');
      expect(result!.sidechainSteps![2].toolName).toBe('Tool4');
    });

    it('returns undefined sidechainSteps when no sidechain entries', async () => {
      const result = await parseContent(fixtures.completedConversation);
      expect(result).not.toBeNull();
      expect(result!.sidechainSteps).toBeUndefined();
    });
  });

  describe('BUG6 — cards bounce between In Review and In Progress', () => {
    it('stays in-progress when the turn ends while a background command runs (BUG6)', async () => {
      const result = await parseContent(fixtures.backgroundBashPendingConversation);
      expect(result!.status).toBe('in-progress');
      expect(result!.backgroundTasks).toBe(1);
    });

    it('stays in-progress while a background agent runs, even if the text says "completed" (BUG6)', async () => {
      const result = await parseContent(fixtures.backgroundAgentPendingConversation);
      expect(result!.status).toBe('in-progress');
      expect(result!.backgroundTasks).toBe(1);
    });

    it('goes to in-review once the task notification arrives and the turn ends (BUG6)', async () => {
      const content = [
        fixtures.backgroundBashPendingConversation,
        fixtures.taskNotification('b1abc', 'completed', 5),
        fixtures.assistantTurn('Benchmark finished: 41/41 pass.', 4, 'end_turn'),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-review');
      expect(result!.backgroundTasks).toBe(0);
    });

    it('counts a notification queued mid-turn as finished (BUG6)', async () => {
      for (const as of ['queue', 'attachment'] as const) {
        parser = new ConversationParser();
        const content = [
          fixtures.userMessage('Run it and keep working', 20),
          fixtures.assistantMessage('', 19, [{ name: 'Bash' }]),
          fixtures.toolResult('Command running in background with ID: b2def.', 19, { backgroundTaskId: 'b2def' }),
          fixtures.taskNotification('b2def', 'failed', 10, as),
          fixtures.assistantTurn('The run failed; see above.', 9, 'end_turn'),
        ].join('\n');
        const result = await parseContent(content);
        expect(result!.status, as).toBe('in-review');
        expect(result!.backgroundTasks, as).toBe(0);
      }
    });

    it('keeps waiting through Monitor events that carry no status (BUG6)', async () => {
      const content = [
        fixtures.userMessage('Watch the deploy', 20),
        fixtures.assistantMessage('', 19, [{ name: 'Monitor' }]),
        fixtures.toolResult('Monitor started.', 19, { taskId: 'bmon1', timeoutMs: 900000, persistent: false }),
        fixtures.assistantTurn('Watching the deploy.', 18, 'end_turn'),
        fixtures.taskNotification('bmon1', undefined, 10),
        fixtures.assistantTurn('Still deploying.', 9, 'end_turn'),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-progress');
    });

    it('treats a stopped task as finished (BUG6)', async () => {
      const content = [
        fixtures.backgroundBashPendingConversation,
        fixtures.userMessage('Stop it', 10),
        fixtures.assistantMessage('', 9, [{ name: 'TaskStop' }]),
        fixtures.toolResult('Successfully stopped task: b1abc', 9, { message: 'Successfully stopped task: b1abc', task_id: 'b1abc', task_type: 'local_bash' }),
        fixtures.assistantTurn('Stopped.', 8, 'end_turn'),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-review');
    });

    it('stops waiting after an hour with no transcript writes (BUG6)', async () => {
      const content = [
        fixtures.userMessage('Run the full benchmark', 200),
        fixtures.assistantMessage('', 199, [{ name: 'Bash' }]),
        fixtures.toolResult('Command running in background with ID: b3old.', 199, { backgroundTaskId: 'b3old' }),
        fixtures.assistantTurn("It's running.", 198, 'end_turn'),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-review');
      expect(result!.backgroundTasks).toBe(0);
    });

    it('still asks for input when a question ends the turn with work pending (BUG6)', async () => {
      const content = [
        fixtures.backgroundBashPendingConversation,
        fixtures.assistantMessage('', 17, [{ name: 'AskUserQuestion', input: { question: 'Which sheet?' } }]),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('needs-input');
    });

    it('does not keep a new prompt in review because the last answer said "completed" (BUG6b)', async () => {
      const content = [
        fixtures.userMessage('Fix the parser', 20),
        fixtures.assistantTurn('All done — the fix is completed and tests pass successfully.', 18, 'end_turn'),
        fixtures.userMessage('Now add a test for the empty file case', 1),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-progress');
    });

    it('treats text written before its tool call as in-progress (BUG6b)', async () => {
      const content = [
        fixtures.userMessage('Fix the parser', 20),
        fixtures.assistantTurn('The first part completed successfully; now running the tests.', 1, 'tool_use'),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-progress');
    });

    it('ignores a local slash command run after the turn ended (BUG6c)', async () => {
      const content = [
        fixtures.completedConversation,
        fixtures.localCommand('model', 'Set model to `claude-opus-5-5`', 5),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-review');
    });

    it('ignores a local command whose output has not landed yet (BUG6c)', async () => {
      const [caveat, invocation] = fixtures.localCommand('model', 'Set model to `claude-opus-5-5`', 5).split('\n');
      for (const tail of [[caveat], [caveat, invocation]]) {
        parser = new ConversationParser();
        const result = await parseContent([fixtures.completedConversation, ...tail].join('\n'));
        expect(result!.status).toBe('in-review');
      }
    });

    it('ignores two local commands in a row (BUG6c)', async () => {
      const content = [
        fixtures.completedConversation,
        fixtures.localCommand('model', 'Set model to `claude-opus-5-5`', 5),
        fixtures.localCommand('usage', 'Usage: 12%', 4),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-review');
    });

    it('still shows a prompt-style slash command as in-progress (BUG6c)', async () => {
      const content = [
        fixtures.completedConversation,
        fixtures.userMessage('<command-message>code-review</command-message>\n<command-name>/code-review</command-name>', 1),
      ].join('\n');
      const result = await parseContent(content);
      expect(result!.status).toBe('in-progress');
    });
  });
});
