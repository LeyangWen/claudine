import { ConversationCategory, ParsedMessage } from '../types';
import { CATEGORY_CLASSIFICATION_MESSAGE_LIMIT } from '../constants';

interface ClassificationRule {
  category: ConversationCategory;
  keywords: string[];
  patterns: RegExp[];
  weight: number;
}

/** A category name at the head of a title, optionally bracketed and followed
 *  by a separator: "Bug - ...", "[Report] ...", "(task) ...", "#improvement". */
const EXPLICIT_LABEL = /^\s*[\[(#]?\s*(bug|improvement|report|task)s?\s*[\])]?\s*(?:[:\-–—|\/]|\s|$)/i;

export class CategoryClassifier {
  private _rules: ClassificationRule[] = [
    {
      category: 'bug',
      keywords: [
        'fix', 'bug', 'error', 'broken', 'issue', 'problem', 'crash',
        'not working', 'fails', 'failing', 'wrong', 'incorrect', 'debug'
      ],
      patterns: [
        /fix\s+(the\s+)?bug/i,
        /error\s+(in|with|when)/i,
        /not\s+working/i,
        /broken\s+\w+/i,
        /crash(es|ing)?/i
      ],
      weight: 10
    },
    {
      category: 'report',
      keywords: [
        'report', 'analysis', 'analyze', 'investigate', 'investigation',
        'benchmark', 'benchmarking', 'summary', 'summarize', 'write-up',
        'writeup', 'findings', 'survey', 'audit', 'metrics', 'comparison'
      ],
      patterns: [
        /\breport\b/i,
        /write[\s-]?up/i,
        /(analy[sz]e|analysis)\b/i,
        /investigat(e|ion)\b/i,
        /benchmark(ing|s)?\b/i,
        /summar(y|ize|ise)\b/i,
        /\bfindings\b/i
      ],
      weight: 9
    },
    {
      category: 'improvement',
      keywords: [
        'improve', 'optimize', 'refactor', 'enhance', 'better',
        'performance', 'clean up', 'simplify', 'update', 'upgrade'
      ],
      patterns: [
        /improve\s+(the\s+)?/i,
        /optimize\s+/i,
        /refactor\s+/i,
        /make\s+\w+\s+better/i,
        /clean\s*up/i,
        /performance/i
      ],
      weight: 7
    },
    {
      category: 'task',
      keywords: [
        'setup', 'configure', 'install', 'update', 'change',
        'move', 'rename', 'delete', 'remove', 'documentation',
        'docs', 'readme', 'test', 'tests', 'chore'
      ],
      patterns: [
        /set\s*up/i,
        /configure\s+/i,
        /update\s+(the\s+)?/i,
        /write\s+(the\s+)?(docs|documentation)/i,
        /add\s+tests/i
      ],
      weight: 5
    }
  ];

  public classify(
    title: string,
    description: string,
    messages: ParsedMessage[]
  ): ConversationCategory {
    // An explicit label at the head of the title wins: "Report - ...",
    // "[Bug] ...", "Task: ...", "#improvement ...".
    const explicit = EXPLICIT_LABEL.exec(title || '');
    if (explicit) return explicit[1].toLowerCase() as ConversationCategory;

    const text = this.extractText(title, description, messages);
    const scores = this.calculateScores(text);

    // Find the category with the highest score
    let maxScore = 0;
    let bestCategory: ConversationCategory = 'task';

    for (const [category, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        bestCategory = category as ConversationCategory;
      }
    }

    return bestCategory;
  }

  private extractText(
    title: string,
    description: string,
    messages: ParsedMessage[]
  ): string {
    const parts = [title, description];

    // Add first few messages for context
    for (const message of messages.slice(0, CATEGORY_CLASSIFICATION_MESSAGE_LIMIT)) {
      if (message.textContent) {
        parts.push(message.textContent);
      }
    }

    return parts.join(' ').toLowerCase();
  }

  private calculateScores(text: string): Record<ConversationCategory, number> {
    const scores: Record<ConversationCategory, number> = {
      'bug': 0,
      'improvement': 0,
      'report': 0,
      'task': 0
    };

    for (const rule of this._rules) {
      let ruleScore = 0;

      // Check keywords
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          ruleScore += 1;
        }
      }

      // Check patterns
      for (const pattern of rule.patterns) {
        if (pattern.test(text)) {
          ruleScore += 2;
        }
      }

      // Apply weight
      scores[rule.category] += ruleScore * rule.weight;
    }

    return scores;
  }

  public getCategoryColor(category: ConversationCategory): string {
    const colors: Record<ConversationCategory, string> = {
      'bug': '#ef4444',         // Red
      'improvement': '#f59e0b', // Yellow/Amber
      'report': '#3b82f6',      // Blue
      'task': '#6b7280'         // Gray
    };
    // Saved boards can still hold categories this version no longer has
    return colors[category] || colors.task;
  }

  public getCategoryIcon(category: ConversationCategory): string {
    const icons: Record<ConversationCategory, string> = {
      'bug': '🐛',
      'improvement': '📈',
      'report': '📊',
      'task': '📋'
    };
    return icons[category] || icons.task;
  }
}
