import axios from 'axios';
import pgvector from 'pgvector';
import { query } from '../database/db';
import { config } from '../config';
import { computeEmbedding } from './embedding.service';

const DEFAULT_TOP_K = 8;

export interface ChatScope {
  tagId?: string;
  dateFrom?: string; // YYYY-MM-DD, filters documents.document_date >= dateFrom
  dateTo?: string; // YYYY-MM-DD, filters documents.document_date <= dateTo
}

export interface RetrievedChunk {
  documentId: string;
  chunkIndex: number;
  chunkText: string;
  documentTitle: string;
  score: number; // cosine similarity, higher = more relevant (1 - distance)
}

export interface Citation {
  marker: string; // e.g. "[1]"
  documentId: string;
  chunkIndex: number;
  snippet: string;
  documentTitle: string;
}

export interface ChatQueryResult {
  answer: string;
  citations: Citation[];
}

/**
 * Retrieval: embeds the question and runs a pgvector cosine-similarity
 * search over `document_chunks`, scoped by the optional tag / date-range
 * filters (joined against `documents` / `document_tags`).
 *
 * This intentionally reuses the same `document_chunks` table and
 * `pgvector` cosine-distance operator (`<=>`) as `search.routes.ts` /
 * hybridSearch.service.ts, but does NOT reuse the RRF keyword+vector
 * fusion from hybridSearch.service.ts as-is: RRF fuses two *document-level*
 * ranked ID lists to decide which whole documents to return, whereas the
 * chat feature needs individual *chunk-level* text with high enough
 * precision to quote directly in an LLM prompt (a document ranking
 * heuristic is the wrong granularity for "give me the 8 best passages").
 * A pure top-K nearest-neighbour chunk search is the simpler, more
 * appropriate retrieval primitive for RAG context-window construction.
 * (Documented here per the ticket's request to justify the retrieval
 * strategy design choice.)
 */
export async function retrieveRelevantChunks(
  question: string,
  scope: ChatScope = {},
  topK: number = DEFAULT_TOP_K
): Promise<RetrievedChunk[]> {
  const questionEmbedding = await computeEmbedding(question);

  const params: any[] = [pgvector.toSql(questionEmbedding)];
  const joins: string[] = [];
  const conditions: string[] = ['d.is_archived = FALSE'];

  if (scope.tagId) {
    joins.push('JOIN document_tags dtag ON dtag.document_id = d.id');
    params.push(scope.tagId);
    conditions.push(`dtag.tag_id = $${params.length}`);
  }
  if (scope.dateFrom) {
    params.push(scope.dateFrom);
    conditions.push(`d.document_date >= $${params.length}`);
  }
  if (scope.dateTo) {
    params.push(scope.dateTo);
    conditions.push(`d.document_date <= $${params.length}`);
  }

  params.push(topK);
  const topKParamIndex = params.length;

  const sql = `
    SELECT c.document_id, c.chunk_index, c.chunk_text, d.title AS document_title,
           c.embedding <=> $1 AS distance
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    ${joins.join('\n    ')}
    WHERE ${conditions.join(' AND ')}
    ORDER BY distance ASC
    LIMIT $${topKParamIndex};
  `;

  const res = await query(sql, params);

  return res.rows.map((r: any) => ({
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
    chunkText: r.chunk_text,
    documentTitle: r.document_title,
    // Cosine distance is in [0, 2]; convert to a similarity score in
    // (roughly) [0, 1] for a more intuitive "relevance" number.
    score: 1 - Number(r.distance) / 2,
  }));
}

export interface ChatPrompt {
  systemPrompt: string;
  userMessage: string;
}

/**
 * System prompt (German, matching worker/src/ai_extractor.py's
 * German-language convention for AI-facing prompts in this codebase).
 *
 * Full exact text — see final report for the verbatim copy required by
 * the tech lead's prompt-review policy.
 */
export const CHAT_SYSTEM_PROMPT = `Du bist ein präziser Dokumenten-Assistent für ein Dokumentenverwaltungssystem (DMS). Du beantwortest Fragen der Nutzerin oder des Nutzers AUSSCHLIESSLICH auf Basis der dir gelieferten Dokumentenausschnitte (KONTEXT). Halte dich an folgende Regeln:

1. Nutze NUR Informationen aus dem KONTEXT. Wenn die Antwort nicht im KONTEXT enthalten ist, sage klar: "Ich habe dazu keine ausreichenden Informationen in den vorliegenden Dokumenten gefunden." Erfinde KEINE Informationen.
2. Jeder Ausschnitt im KONTEXT ist mit einer Quellenmarkierung wie [1], [2], [3] usw. gekennzeichnet. Wenn du eine Information aus einem Ausschnitt verwendest, zitiere die passende Markierung direkt im Fließtext, z.B. "Die Versicherungsprämie betrug 450 € [2]."
3. Wenn mehrere Ausschnitte dieselbe Information belegen, zitiere alle relevanten Markierungen, z.B. [1][3].
4. Wenn die Frage mehrere Dokumente betrifft (z.B. eine Summe über mehrere Rechnungen), fasse die Werte aus allen relevanten Ausschnitten zusammen und zitiere jeden verwendeten Ausschnitt.
5. Antworte prägnant, sachlich und auf Deutsch, es sei denn die Frage ist eindeutig auf Englisch gestellt.
6. Gib NIEMALS Zitate für Informationen an, die nicht tatsächlich aus dem KONTEXT stammen.`;

/**
 * User message template. `{{CONTEXT}}` is replaced with the numbered,
 * citation-tagged chunk list; `{{QUESTION}}` with the user's raw question.
 */
export const CHAT_USER_MESSAGE_TEMPLATE = `KONTEXT:
{{CONTEXT}}

FRAGE:
{{QUESTION}}

Beantworte die FRAGE ausschließlich auf Basis des KONTEXT und zitiere jede verwendete Information mit der passenden Markierung in eckigen Klammern (z.B. [1]).`;

/**
 * Builds the full chat prompt (system + user message) from retrieved
 * chunks and the user's question. Pure function — no I/O — so it can be
 * unit-tested without a database or LLM.
 */
export function buildChatPrompt(question: string, chunks: RetrievedChunk[]): ChatPrompt {
  const contextBlock = chunks
    .map((chunk, i) => `[${i + 1}] (Dokument: "${chunk.documentTitle}", Abschnitt ${chunk.chunkIndex})\n${chunk.chunkText}`)
    .join('\n\n');

  const userMessage = CHAT_USER_MESSAGE_TEMPLATE.replace('{{CONTEXT}}', contextBlock || '(keine Dokumentenausschnitte gefunden)').replace(
    '{{QUESTION}}',
    question
  );

  return { systemPrompt: CHAT_SYSTEM_PROMPT, userMessage };
}

/**
 * Isolated LLM call, mirroring worker/src/ai_extractor.py's dual-provider
 * (Ollama / OpenAI) HTTP call pattern, but for open-ended chat generation
 * rather than structured JSON metadata extraction (so no `format: json` /
 * `response_format` forcing here — the answer is free-form prose with
 * inline [n] citation markers).
 *
 * Deliberately exported as its own function (not inlined into
 * `answerQuestion`) so tests can mock/stub it and exercise retrieval +
 * prompt-construction + citation-parsing without a real Ollama/OpenAI
 * server, per the ticket's testing requirements.
 */
export async function callChatLLM(prompt: ChatPrompt): Promise<string> {
  if (config.llmProvider === 'openai' && config.openaiApiKey) {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userMessage },
        ],
      },
      { headers: { Authorization: `Bearer ${config.openaiApiKey}` }, timeout: 60000 }
    );
    return res.data.choices[0].message.content as string;
  }

  // Default / fallback: Ollama.
  const res = await axios.post(
    `${config.ollamaHost}/api/generate`,
    {
      model: 'llama3',
      prompt: `${prompt.systemPrompt}\n\n${prompt.userMessage}`,
      stream: false,
    },
    { timeout: 60000 }
  );
  return res.data.response as string;
}

/**
 * Parses an LLM answer for `[n]` citation markers and maps each one back
 * to its source chunk, producing the structured citations array the
 * (out-of-scope) frontend will use to render clickable footnotes.
 *
 * Only markers that actually appear in the answer text are included
 * (unused retrieved chunks are silently dropped, since citing a chunk the
 * model never referenced would mislead the user about what was actually
 * used to construct the answer).
 */
export function parseCitations(answer: string, chunks: RetrievedChunk[]): Citation[] {
  const foundMarkers = new Set<number>();
  const markerPattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(answer)) !== null) {
    const n = parseInt(match[1], 10);
    if (n >= 1 && n <= chunks.length) {
      foundMarkers.add(n);
    }
  }

  return Array.from(foundMarkers)
    .sort((a, b) => a - b)
    .map((n) => {
      const chunk = chunks[n - 1];
      return {
        marker: `[${n}]`,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        snippet: chunk.chunkText.slice(0, 300),
        documentTitle: chunk.documentTitle,
      };
    });
}

/**
 * Full RAG pipeline: retrieve -> build prompt -> call LLM -> parse
 * citations. `llmCaller` is dependency-injected (defaults to
 * `callChatLLM`) purely so tests can stub the LLM call while still
 * exercising the route wiring end-to-end.
 */
export async function answerQuestion(
  question: string,
  scope: ChatScope = {},
  topK: number = DEFAULT_TOP_K,
  llmCaller: (prompt: ChatPrompt) => Promise<string> = callChatLLM
): Promise<ChatQueryResult> {
  const chunks = await retrieveRelevantChunks(question, scope, topK);
  const prompt = buildChatPrompt(question, chunks);
  const answer = await llmCaller(prompt);
  const citations = parseCitations(answer, chunks);
  return { answer, citations };
}
