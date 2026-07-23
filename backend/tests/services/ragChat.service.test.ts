import { describe, it, expect } from 'vitest';
import {
  buildChatPrompt,
  parseCitations,
  CHAT_SYSTEM_PROMPT,
  RetrievedChunk,
} from '../../src/services/ragChat.service';

const mockChunks: RetrievedChunk[] = [
  {
    documentId: 'doc-1',
    chunkIndex: 0,
    chunkText: 'Die Versicherungsprämie für 2025 betrug 450 EUR.',
    documentTitle: 'Versicherungspolice 2025.pdf',
    score: 0.92,
  },
  {
    documentId: 'doc-2',
    chunkIndex: 3,
    chunkText: 'Zusätzliche Zahlung für die Hausratversicherung: 120 EUR.',
    documentTitle: 'Hausrat Vertrag.pdf',
    score: 0.81,
  },
];

describe('buildChatPrompt', () => {
  it('includes the system prompt verbatim', () => {
    const { systemPrompt } = buildChatPrompt('Wie viel habe ich für Versicherungen bezahlt?', mockChunks);
    expect(systemPrompt).toBe(CHAT_SYSTEM_PROMPT);
  });

  it('numbers each retrieved chunk with a matching [n] citation marker in order', () => {
    const { userMessage } = buildChatPrompt('Wie viel habe ich für Versicherungen bezahlt?', mockChunks);

    expect(userMessage).toContain('[1] (Dokument: "Versicherungspolice 2025.pdf", Abschnitt 0)');
    expect(userMessage).toContain('Die Versicherungsprämie für 2025 betrug 450 EUR.');
    expect(userMessage).toContain('[2] (Dokument: "Hausrat Vertrag.pdf", Abschnitt 3)');
    expect(userMessage).toContain('Zusätzliche Zahlung für die Hausratversicherung: 120 EUR.');
  });

  it('includes the raw question text', () => {
    const { userMessage } = buildChatPrompt('Wie viel habe ich für Versicherungen bezahlt?', mockChunks);
    expect(userMessage).toContain('Wie viel habe ich für Versicherungen bezahlt?');
  });

  it('handles an empty chunk list without throwing', () => {
    const { userMessage } = buildChatPrompt('Irrelevante Frage', []);
    expect(userMessage).toContain('(keine Dokumentenausschnitte gefunden)');
  });
});

describe('parseCitations', () => {
  it('builds a citation entry for each [n] marker referenced in the answer', () => {
    const answer = 'Die Gesamtkosten für Versicherungen betrugen 570 EUR [1][2].';
    const citations = parseCitations(answer, mockChunks);

    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({
      marker: '[1]',
      documentId: 'doc-1',
      chunkIndex: 0,
      snippet: 'Die Versicherungsprämie für 2025 betrug 450 EUR.',
      documentTitle: 'Versicherungspolice 2025.pdf',
    });
    expect(citations[1]).toEqual({
      marker: '[2]',
      documentId: 'doc-2',
      chunkIndex: 3,
      snippet: 'Zusätzliche Zahlung für die Hausratversicherung: 120 EUR.',
      documentTitle: 'Hausrat Vertrag.pdf',
    });
  });

  it('deduplicates repeated markers and sorts by marker number', () => {
    const answer = 'Laut [2] und erneut laut [2] sowie [1] betrugen die Kosten insgesamt 570 EUR.';
    const citations = parseCitations(answer, mockChunks);

    expect(citations.map((c) => c.marker)).toEqual(['[1]', '[2]']);
  });

  it('ignores markers that do not correspond to a retrieved chunk', () => {
    const answer = 'Laut [1] und [99] betrugen die Kosten 450 EUR.';
    const citations = parseCitations(answer, mockChunks);

    expect(citations).toHaveLength(1);
    expect(citations[0].marker).toBe('[1]');
  });

  it('returns an empty array when the answer cites nothing', () => {
    const answer = 'Ich habe dazu keine ausreichenden Informationen in den vorliegenden Dokumenten gefunden.';
    expect(parseCitations(answer, mockChunks)).toEqual([]);
  });
});
