import { describe, expect, it } from 'bun:test';
import { extractKeyphrases } from '../lib/text/keyphrases';
import { extractiveSummary, pagerank, rankSentences } from '../lib/text/textrank';
import { sentences } from '../lib/text/tokenize';
import { heuristicSynthesis, summarizeWindow } from '../sdk/chat/summarize';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import type { ChatConversation, ChatWindowMessage } from '../sdk/chat/types';

const TRANSCRIPT = `We should migrate the SQLite database to WAL mode before the release.
WAL mode makes concurrent reads much faster in SQLite.
The migration script needs a backup first. I will write the backup step for the SQLite migration.
Sounds good, the Docker image must include the new migration script.
Let's schedule the release for Friday after the backup is verified.
lol ok
I'll update the Docker image tonight.`;

const conversation: ChatConversation = { conversationId: 'c1', title: 'general', kind: 'channel', uri: 'discord://channel/c1' };
const message = (i: number, authorName: string, text: string): ChatWindowMessage =>
  ({ conversationId: 'c1', messageId: `m${i}`, authorId: authorName, authorName, sentAt: Date.UTC(2026, 0, 2, 10, i), text, attachments: [] });
const messages = TRANSCRIPT.split('\n').map((text, i) => message(i, i % 2 ? 'Bob' : 'Alice', text));

describe('extractive text algorithms', () => {
  it('splits sentences on terminal punctuation and lines but not abbreviations or decimals', () => {
    expect(sentences('Dr. Smith arrived at 3.5 p.m. today. He left!\nNew line here')).toEqual(['Dr. Smith arrived at 3.5 p.m. today.', 'He left!', 'New line here']);
  });

  it('runs PageRank to a distribution that favours well-connected nodes', () => {
    const rank = pagerank([[0, 1, 1], [1, 0, 0], [1, 0, 0]]);
    expect(rank.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(rank[0]!).toBeGreaterThan(rank[1]!);
    expect(rank[1]!).toBeCloseTo(rank[2]!, 6);
    // A node without edges keeps a share instead of draining the distribution.
    expect(pagerank([[0, 0], [0, 0]])).toEqual([0.5, 0.5]);
  });

  it('ranks central sentences first and returns a non-redundant summary in document order', () => {
    const ranked = rankSentences(TRANSCRIPT);
    expect(ranked[0]!.text).toContain('SQLite');
    expect(ranked.some(sentence => sentence.text === 'lol ok')).toBe(false);
    const summary = extractiveSummary(TRANSCRIPT, { sentences: 3 });
    expect(summary).toHaveLength(3);
    const positions = summary.map(sentence => TRANSCRIPT.indexOf(sentence));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(extractiveSummary('ok')).toEqual([]);
  });

  it('extracts YAKE keyphrases, preferring capitalised and repeated terms, without stop words or excluded names', () => {
    const phrases = extractKeyphrases(TRANSCRIPT, { max: 6, exclude: ['alice', 'bob'] }).map(p => p.phrase);
    expect(phrases).toContain('SQLite');
    expect(phrases).toContain('WAL mode');
    expect(phrases.some(phrase => /^(?:the|and|lol|ok)$/i.test(phrase))).toBe(false);
    expect(extractKeyphrases('Bob met Bob.', { exclude: ['bob'] })).toEqual([]);
    // Deterministic output for identical input.
    expect(extractKeyphrases(TRANSCRIPT)).toEqual(extractKeyphrases(TRANSCRIPT));
  });
});

describe('chat window synthesis', () => {
  it('keeps the descriptive one-liner without topics for short windows', () => {
    const synthesis = heuristicSynthesis(conversation, [message(0, 'Alice', 'hi')]);
    expect(synthesis).toMatchObject({ method: 'heuristic', topics: [] });
    expect(synthesis.summary).toContain('Opens with: "hi"');
  });

  it('summarises substantial windows extractively and maps keyphrases onto known registry topics', () => {
    const synthesis = heuristicSynthesis(conversation, messages, { knownTopic: phrase => phrase.toLowerCase() === 'docker' ? 'Docker (software)' : undefined });
    expect(synthesis.method).toBe('heuristic');
    expect(synthesis.summary).toContain('7 message(s) in general');
    expect(synthesis.summary).toContain('Key points:');
    expect(synthesis.topics[0]).toBe('Docker (software)');
    expect(synthesis.topics).toContain('SQLite');
    expect(synthesis.topics.map(topic => topic.toLowerCase())).not.toContain('alice');
  });

  it('extractive mode never calls the model; llm mode records the extractive result as a shadow', async () => {
    const db = createTestDatabase();
    try {
      const sdk = createExtensionSDK('discord', { database: db });
      let calls = 0;
      sdk.queryLLM = (async (_prompt: string) => { calls++; return JSON.stringify({ title: 'Release planning', summary: 'They planned the WAL migration.', topics: ['SQLite'] }); }) as typeof sdk.queryLLM;
      const extractive = await summarizeWindow(sdk, conversation, messages, TRANSCRIPT, { mode: 'extractive', subject: 'w1' });
      expect(calls).toBe(0);
      expect(extractive.method).toBe('heuristic');
      expect(extractive.topics.length).toBeGreaterThan(0);
      const llm = await summarizeWindow(sdk, conversation, messages, TRANSCRIPT, { subject: 'w1' });
      expect(calls).toBe(1);
      expect(llm).toMatchObject({ method: 'llm', topics: ['SQLite'] });
      const row = db.query<{ method: string; verdict_json: string; llm_verdict_json: string }, []>(
        "SELECT method,verdict_json,llm_verdict_json FROM graph_shadow_decisions WHERE kind='summary' AND subject_key='w1'").get()!;
      expect(row.method).toBe('textrank-yake');
      expect(JSON.parse(row.verdict_json).topics).toEqual(extractive.topics);
      expect(JSON.parse(row.llm_verdict_json)).toMatchObject({ summary: 'They planned the WAL migration.' });
    } finally { db.close(); }
  });
});
