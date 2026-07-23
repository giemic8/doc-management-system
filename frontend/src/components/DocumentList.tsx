import React from 'react';
import { FileText, Calendar, Building, DollarSign, Tag, CheckCircle2, Clock, AlertCircle, Eye } from 'lucide-react';
import { DocumentItem } from '../types';

interface DocumentListProps {
  documents: DocumentItem[];
  onSelectDocument: (doc: DocumentItem) => void;
}

export const DocumentList: React.FC<DocumentListProps> = ({ documents, onSelectDocument }) => {
  if (documents.length === 0) {
    return (
      <div className="glass-panel p-12 text-center space-y-4 my-6">
        <FileText className="w-12 h-12 text-slate-600 mx-auto" />
        <h3 className="text-lg font-semibold text-slate-300">Keine Dokumente gefunden</h3>
        <p className="text-slate-500 text-sm max-w-md mx-auto">
          Lade ein neues Dokument hoch oder lege eine Datei in den <code>storage/input/</code> Watchfolder.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {documents.map((doc) => {
        const isProcessed = doc.status === 'processed';

        return (
          <div
            key={doc.id}
            onClick={() => onSelectDocument(doc)}
            className="glass-card p-5 cursor-pointer flex flex-col justify-between group"
          >
            <div className="space-y-3">
              {/* Header: Title & Status */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 overflow-hidden">
                  <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <h4 className="font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors truncate text-sm">
                    {doc.title}
                  </h4>
                </div>

                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 flex items-center gap-1 ${
                    isProcessed
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}
                >
                  {isProcessed ? <CheckCircle2 className="w-3 h-3" /> : <Clock className="w-3 h-3 animate-spin" />}
                  {doc.status}
                </span>
              </div>

              {/* AI Summary / OCR snippet */}
              <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed font-normal">
                {doc.summary || doc.ocr_text || 'Wird analysiert...'}
              </p>

              {/* Metadata Pills */}
              <div className="grid grid-cols-2 gap-2 text-[12px] pt-1 text-slate-400">
                {doc.sender && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Building className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="truncate">{doc.sender}</span>
                  </div>
                )}

                {doc.document_date && (
                  <div className="flex items-center gap-1.5 truncate">
                    <Calendar className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span>{doc.document_date}</span>
                  </div>
                )}

                {doc.amount != null && (
                  <div className="flex items-center gap-1.5 font-medium text-emerald-400">
                    <DollarSign className="w-3.5 h-3.5 shrink-0" />
                    <span>{Number(doc.amount).toFixed(2)} {doc.currency || 'EUR'}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer Tags */}
            <div className="pt-4 border-t border-slate-800/60 mt-4 flex items-center justify-between">
              <div className="flex flex-wrap gap-1">
                {doc.tags && doc.tags.map((t) => (
                  <span
                    key={t.id}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700"
                    style={{ borderColor: t.color ? `${t.color}40` : undefined }}
                  >
                    #{t.name}
                  </span>
                ))}
              </div>

              <div className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-xs">
                <span>Details</span>
                <Eye className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
