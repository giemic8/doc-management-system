import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Calendar, Building, DollarSign, Tag, History, Shield, Cpu, RefreshCw } from 'lucide-react';
import { DocumentItem, Tag as TagType } from '../types';
import { PDFViewer } from './PDFViewer';
import { updateDocumentMetadata, fetchTags } from '../services/api';

interface DocumentDetailModalProps {
  document: DocumentItem;
  onClose: () => void;
  onUpdate: () => void;
}

export const DocumentDetailModal: React.FC<DocumentDetailModalProps> = ({
  document,
  onClose,
  onUpdate,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'ocr' | 'audit'>('preview');
  const [title, setTitle] = useState(document.title);
  const [docType, setDocType] = useState(document.doc_type || '');
  const [sender, setSender] = useState(document.sender || '');
  const [amount, setAmount] = useState(document.amount ? String(document.amount) : '');
  const [docDate, setDocDate] = useState(document.document_date || '');
  const [summary, setSummary] = useState(document.summary || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateDocumentMetadata(document.id, {
        title,
        doc_type: docType,
        sender,
        amount: amount ? parseFloat(amount) : null,
        document_date: docDate || null,
        summary,
      });
      onUpdate();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div className="h-16 border-b border-slate-800 px-6 flex items-center justify-between shrink-0 bg-slate-950/50">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-indigo-400" />
            <h3 className="font-bold text-slate-100 text-lg truncate max-w-md">{document.title}</h3>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
              v{document.version}.0
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={handleSave} disabled={saving} className="btn-primary text-xs py-2 px-4">
              <Save className="w-4 h-4" />
              <span>{saving ? 'Speichere...' : 'Metadaten Speichern'}</span>
            </button>
            <button onClick={onClose} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel: Preview & OCR Tabs */}
          <div className="w-3/5 border-r border-slate-800 flex flex-col p-4 bg-slate-950/30">
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setActiveTab('preview')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  activeTab === 'preview' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                }`}
              >
                PDF Vorschau
              </button>
              <button
                onClick={() => setActiveTab('ocr')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  activeTab === 'ocr' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                }`}
              >
                Volltext / OCR Text
              </button>
            </div>

            <div className="flex-1 overflow-hidden">
              {activeTab === 'preview' ? (
                <PDFViewer documentId={document.id} title={document.title} />
              ) : (
                <div className="h-full bg-slate-950 p-4 rounded-xl border border-slate-800 overflow-auto text-xs font-mono text-slate-300 leading-relaxed whitespace-pre-wrap select-text">
                  {document.ocr_text || 'Kein OCR Text extrahiert.'}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: AI & Editable Metadata */}
          <div className="w-2/5 p-6 overflow-auto space-y-6 bg-slate-900/60">
            {/* AI Summary Banner */}
            <div className="glass-card p-4 space-y-2 border-indigo-500/30 bg-gradient-to-br from-indigo-950/30 to-purple-950/20">
              <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold">
                <Cpu className="w-4 h-4" />
                <span>KI-Zusammenfassung</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed font-normal">
                {document.summary || 'Metadaten werden noch von der KI analysiert...'}
              </p>
            </div>

            {/* Editable Fields Form */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Dokumenten Metadaten
              </h4>

              <div className="space-y-1">
                <label className="text-xs text-slate-400">Titel</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Dokumententyp</label>
                  <input
                    type="text"
                    value={docType}
                    onChange={(e) => setDocType(e.target.value)}
                    placeholder="Rechnung, Vertrag..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Absender / Partner</label>
                  <input
                    type="text"
                    value={sender}
                    onChange={(e) => setSender(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Betrag (€)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Dokumenten-Datum</label>
                  <input
                    type="date"
                    value={docDate}
                    onChange={(e) => setDocDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-400">Zusammenfassung</label>
                <textarea
                  rows={3}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 focus:border-indigo-500 outline-none resize-none"
                />
              </div>
            </div>

            {/* Technical Info */}
            <div className="pt-4 border-t border-slate-800 space-y-2 text-xs text-slate-500">
              <div className="flex justify-between">
                <span>Dateiname:</span>
                <span className="font-mono text-slate-400">{document.original_filename}</span>
              </div>
              <div className="flex justify-between">
                <span>SHA-256 Hash:</span>
                <span className="font-mono text-slate-400 truncate max-w-[180px]">{document.file_hash}</span>
              </div>
              <div className="flex justify-between">
                <span>Erstellt am:</span>
                <span className="text-slate-400">{new Date(document.created_at).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
