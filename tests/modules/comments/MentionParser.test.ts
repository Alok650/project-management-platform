/**
 * Unit tests for MentionParser.extract()
 *
 * MentionParser is a pure static utility — no mocks required.
 * The regex is /@([\w-]+)/g, matching @ followed by word chars and hyphens.
 */

import { MentionParser } from '../../../src/modules/comments/MentionParser';

describe('MentionParser.extract', () => {
  it('single mention — returns array with one handle', () => {
    expect(MentionParser.extract('hello @alice')).toEqual(['alice']);
  });

  it('multiple unique mentions — returns handles in order of appearance', () => {
    const result = MentionParser.extract('@bob and @alice');
    expect(result).toEqual(['bob', 'alice']);
  });

  it('duplicate mention — deduped to a single entry', () => {
    expect(MentionParser.extract('@alice @alice')).toEqual(['alice']);
  });

  it('no mentions — returns empty array', () => {
    expect(MentionParser.extract('no mentions here')).toEqual([]);
  });

  it('handles with hyphens and underscores are matched', () => {
    const result = MentionParser.extract('@john-doe and @jane_doe');
    expect(result).toEqual(['john-doe', 'jane_doe']);
  });

  it('email address — @ inside an email still extracts the part after @ as a mention', () => {
    // The regex /@([\w-]+)/g has no word-boundary requirement before @, so
    // "email@domain.com" matches and captures "domain" (stops before ".").
    // This test documents the actual behaviour rather than asserting it should
    // be excluded.
    const result = MentionParser.extract('email@domain.com');
    expect(result).toEqual(['domain']);
  });

  it('empty string — returns empty array', () => {
    expect(MentionParser.extract('')).toEqual([]);
  });

  it('case normalisation — uppercase handle is lower-cased', () => {
    expect(MentionParser.extract('@Alice')).toEqual(['alice']);
  });

  it('mixed case duplicates are deduped after normalisation', () => {
    expect(MentionParser.extract('@Alice @alice @ALICE')).toEqual(['alice']);
  });

  it('mentions surrounded by punctuation are still extracted', () => {
    const result = MentionParser.extract('Thanks @bob! Ping @alice.');
    expect(result).toEqual(['bob', 'alice']);
  });

  it('regex lastIndex is reset between calls — no statefulness between invocations', () => {
    // Calling extract twice on the same content must return the same result.
    const first  = MentionParser.extract('@alice');
    const second = MentionParser.extract('@alice');
    expect(first).toEqual(['alice']);
    expect(second).toEqual(['alice']);
  });
});
