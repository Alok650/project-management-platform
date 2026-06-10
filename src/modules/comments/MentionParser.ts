/**
 * Parses @mention handles from comment content.
 * A mention is the pattern @word (word = alphanumeric + underscore + hyphen).
 */
export class MentionParser {
  private static readonly MENTION_RE = /@([\w-]+)/g;

  /**
   * Extract all unique mention handles from content text.
   * @param content - Raw comment content
   * @returns Deduplicated lowercase handle strings
   */
  static extract(content: string): string[] {
    const handles: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = MentionParser.MENTION_RE.exec(content)) !== null) {
      if (match[1]) handles.push(match[1].toLowerCase());
    }
    MentionParser.MENTION_RE.lastIndex = 0;
    return [...new Set(handles)];
  }
}
