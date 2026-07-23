import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Loader2, Sparkles, FileText } from 'lucide-react';
import { Citation, ChatMessage, Tag as TagType } from '../types';
import { sendChatQuery, fetchTags } from '../services/api';

interface ChatDrawerProps {
  onClose: () => void;
  /** Ticket #18 — opens the given document (by id) in the existing DocumentDetailModal,
   * optionally passing a citation snippet along so the PDF viewer can surface it. */
  onOpenDocument: (documentId: string, highlightHint?: string) => void;
}

type ScopeMode = 'all' | 'tag' | 'daterange';

/**
 * Parses an assistant answer string for `[n]` citation markers and
 * replaces them with clickable inline buttons, matching each marker back
 * to its `Citation` entry by `citation.marker` (e.g. "[1]").
 *
 * Returns an array of React nodes (mixed strings + buttons) suitable for
 * dropping directly into JSX via a fragment/array.
 */
export function renderAnswerWithCitations(
  answer: string,
  citations: Citation[],
  onCitationClick: (citation: Citation) => void
): React.ReactNode[] {
  const markerPattern = /\[(\d+)\]/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = markerPattern.exec(answer)) !== null) {
    const marker = match[0]; // e.g. "[1]"
    const citation = citations.find((c) => c.marker === marker);

    if (match.index > lastIndex) {
      nodes.push(answer.slice(lastIndex, match.index));
    }

    if (citation) {
      nodes.push(
        <button
          key={`citation-${key++}`}
          onClick={() => onCitationClick(citation)}
          className="inline-flex items-center justify-center align-super text-[10px] font-bold text-indigo-300 hover:text-white bg-indigo-500/20 hover:bg-indigo-500/60 border border-indigo-500/40 rounded-full w-4 h-4 mx-0.5 transition-colors"
          title={`Quelle: ${citation.documentTitle}`}
        >
          {match[1]}
        </button>
      );
    } else {
      // No matching citation found (shouldn't normally happen) — render as plain text.
      nodes.push(marker);
    }

    lastIndex = match.index + marker.length;
  }

  if (lastIndex < answer.length) {
    nodes.push(answer.slice(lastIndex));
  }

  return nodes;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ onClose, onOpenDocument }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [tags, setTags] = useState<TagType[]>([]);
  const [selectedTagId, setSelectedTagId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTags()
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const buildScope = () => {
    if (scopeMode === 'tag' && selectedTagId) {
      return { tagId: selectedTagId };
    }
    if (scopeMode === 'daterange' && (dateFrom || dateTo)) {
      return { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined };
    }
    return undefined;
  };

  const handleSend = async () => {
    const question = input.trim();
    if (!question || loading) return;

    const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: question };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const result = await sendChatQuery(question, buildScope());
      const assistantMessage: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: result.answer,
        citations: result.citations,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Die Anfrage konnte nicht verarbeitet werden.');
    } finally {
      setLoading(false);
    }
  };

  const handleCitationClick = (citation: Citation) => {
    // See PDFViewer.tsx `highlightHint` prop for the documented limitation:
    // the native iframe-based PDF viewer cannot be scripted to scroll to
    // or highlight arbitrary text, so we open the document and surface
    // the cited snippet as a hint banner instead of a true text-jump.
    onOpenDocument(citation.documentId, citation.snippet);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-fade-in">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-lg h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="h-16 border-b border-slate-800 px-5 flex items-center justify-between shrink-0 bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-indigo-400" />
            <h3 className="font-bold text-slate-100 text-base">Dokumenten-Assistent</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scope Selector */}
        <div className="px-5 py-3 border-b border-slate-800 space-y-2 bg-slate-950/30">
          <div className="flex items-center gap-1.5">
            {(['all', 'tag', 'daterange'] as ScopeMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setScopeMode(mode)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                  scopeMode === mode ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                }`}
              >
                {mode === 'all' ? 'Alle Dokumente' : mode === 'tag' ? 'Nach Tag' : 'Nach Zeitraum'}
              </button>
            ))}
          </div>

          {scopeMode === 'tag' && (
            <select
              value={selectedTagId}
              onChange={(e) => setSelectedTagId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 outline-none"
            >
              <option value="">Tag auswählen...</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          )}

          {scopeMode === 'daterange' && (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 outline-none"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 outline-none"
              />
            </div>
          )}
        </div>

        {/* Message Thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-slate-500 text-xs py-8">
              <Sparkles className="w-8 h-8 text-slate-700 mx-auto mb-3" />
              Stelle eine Frage zu deinen Dokumenten — z.B. "Wie hoch war meine letzte Stromrechnung?"
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'glass-card text-slate-200'
                }`}
              >
                {msg.role === 'assistant' && msg.citations
                  ? renderAnswerWithCitations(msg.content, msg.citations, handleCitationClick)
                  : msg.content}

                {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-700/60 space-y-1.5">
                    {msg.citations.map((c) => (
                      <button
                        key={c.marker}
                        onClick={() => handleCitationClick(c)}
                        className="w-full flex items-start gap-1.5 text-left text-[11px] text-slate-400 hover:text-indigo-300 transition-colors"
                      >
                        <FileText className="w-3 h-3 mt-0.5 shrink-0 text-indigo-400" />
                        <span>
                          <span className="font-semibold text-slate-300">
                            {c.marker} {c.documentTitle}
                          </span>
                          <span className="block text-slate-500 italic truncate">"{c.snippet}"</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="glass-card px-3.5 py-2.5 flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Analysiere Dokumente...</span>
              </div>
            </div>
          )}

          {error && <p className="text-rose-400 text-xs text-center">{error}</p>}
        </div>

        {/* Input */}
        <div className="border-t border-slate-800 p-4 flex items-center gap-2 shrink-0 bg-slate-950/50">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            disabled={loading}
            placeholder="Frage zu deinen Dokumenten stellen..."
            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 focus:border-indigo-500 outline-none disabled:opacity-50"
          />
          <button onClick={handleSend} disabled={loading || !input.trim()} className="btn-primary text-xs py-2.5 px-4">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>Senden</span>
          </button>
        </div>
      </div>
    </div>
  );
};
