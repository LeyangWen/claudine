import { describe, it, expect } from 'vitest';
import { CategoryClassifier } from '../services/CategoryClassifier';
import { ParsedMessage } from '../types';

function msg(text: string, role: 'user' | 'assistant' = 'user'): ParsedMessage {
  return {
    role,
    textContent: text,
    toolUses: [],
    timestamp: new Date().toISOString(),
    hasError: false,
    isInterrupted: false,
    hasQuestion: false,
    isRateLimited: false,
  };
}

describe('CategoryClassifier', () => {
  const classifier = new CategoryClassifier();

  describe('classify', () => {
    it('classifies bug-related conversations', () => {
      expect(classifier.classify('Fix the login bug', '', [])).toBe('bug');
      expect(classifier.classify('Error in auth module', '', [])).toBe('bug');
      expect(classifier.classify('App crashes on startup', '', [])).toBe('bug');
      expect(classifier.classify('Button not working', '', [])).toBe('bug');
    });

    it('classifies report conversations', () => {
      expect(classifier.classify('Benchmark the new parser', '', [])).toBe('report');
      expect(classifier.classify('Investigate slow startup and write up findings', '', [])).toBe('report');
      expect(classifier.classify('Summarize the audit results', '', [])).toBe('report');
    });

    it('lets an explicit label at the head of the title win', () => {
      expect(classifier.classify('Report - fix rate by week', '', [])).toBe('report');
      expect(classifier.classify('[Bug] optimize the cache', '', [])).toBe('bug');
      expect(classifier.classify('Task: benchmark the parser', '', [])).toBe('task');
      expect(classifier.classify('#improvement crash reporting', '', [])).toBe('improvement');
      expect(classifier.classify('Bugs | login', '', [])).toBe('bug');
    });

    it('does not read a label out of a longer word', () => {
      expect(classifier.classify('Taskbar icon setup', '', [])).toBe('task');
      expect(classifier.classify('Reporter crashes on startup', '', [])).toBe('bug');
    });

    it('classifies improvement conversations', () => {
      expect(classifier.classify('Improve performance of queries', '', [])).toBe('improvement');
      expect(classifier.classify('Optimize the database', '', [])).toBe('improvement');
      expect(classifier.classify('Refactor the auth module', '', [])).toBe('improvement');
      expect(classifier.classify('Clean up the codebase', '', [])).toBe('improvement');
    });

    it('classifies task conversations', () => {
      expect(classifier.classify('Setup CI pipeline', '', [])).toBe('task');
      expect(classifier.classify('Write the documentation', '', [])).toBe('task');
      expect(classifier.classify('Add tests for the parser', '', [])).toBe('task');
      expect(classifier.classify('Configure linting', '', [])).toBe('task');
    });

    it('defaults to task for ambiguous input', () => {
      expect(classifier.classify('Hello world', '', [])).toBe('task');
      expect(classifier.classify('', '', [])).toBe('task');
    });

    it('uses description for classification', () => {
      expect(classifier.classify('', 'Fix the bug in the login form', [])).toBe('bug');
    });

    it('uses messages for classification', () => {
      const messages = [msg('Fix the crash when clicking submit')];
      expect(classifier.classify('Untitled', '', messages)).toBe('bug');
    });

    it('considers first 5 messages only', () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i < 5 ? 'setup the config' : 'fix the critical bug crash error')
      );
      // Only first 5 ("setup the config") are used — should be task, not bug
      expect(classifier.classify('', '', messages)).toBe('task');
    });

    it('higher-weight categories win ties', () => {
      // "fix" is a bug keyword (weight 10); nothing else matches
      expect(classifier.classify('fix something', '', [])).toBe('bug');
    });

    it('pattern matches score higher than keywords', () => {
      // Pattern match adds 2 per pattern vs 1 per keyword
      const result = classifier.classify('fix the bug in the login form', '', []);
      expect(result).toBe('bug');
    });
  });

  describe('getCategoryColor', () => {
    it('returns correct colors for each category', () => {
      expect(classifier.getCategoryColor('bug')).toBe('#ef4444');
      expect(classifier.getCategoryColor('improvement')).toBe('#f59e0b');
      expect(classifier.getCategoryColor('report')).toBe('#3b82f6');
      expect(classifier.getCategoryColor('task')).toBe('#6b7280');
      // categories from older saved boards fall back to task
      expect(classifier.getCategoryColor('feature' as never)).toBe('#6b7280');
    });
  });

  describe('getCategoryIcon', () => {
    it('returns correct icons for each category', () => {
      expect(classifier.getCategoryIcon('bug')).toBe('\u{1F41B}');
      expect(classifier.getCategoryIcon('improvement')).toBe('\u{1F4C8}');
      expect(classifier.getCategoryIcon('report')).toBe('\u{1F4CA}');
      expect(classifier.getCategoryIcon('task')).toBe('\u{1F4CB}');
    });
  });
});
