import React, { useState } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Highlighter, ShieldAlert, Download, QrCode, Loader2, Quote, X } from 'lucide-react';
import { fetchSepaQr } from '../services/api';

interface PDFViewerProps {
  documentId: string;
  title: string;
  defaultAmount?: number | string;
  /**
   * Ticket #18 (RAG chat assistant) — optional citation snippet text to
   * surface as a floating hint banner when this viewer was opened by
   * clicking a chat citation.
   *
   * LIMITATION: the PDF itself is rendered via a plain
   * `<iframe src=".../file#toolbar=0">`, i.e. the browser's native/built-in
   * PDF viewer. That native viewer does not expose any scriptable API to
   * the parent page for searching, scrolling to, or highlighting specific
   * text — it's opaque, sandboxed content from the parent document's
   * point of view. True "jump to and highlight this exact passage"
   * behavior would require replacing the iframe with a custom PDF.js-based
   * renderer (e.g. `react-pdf` / `pdfjs-dist`) that renders each page's
   * text layer as real, scriptable DOM nodes — a larger, separate
   * architectural change out of scope here. This prop is therefore the
   * best feasible approximation: it shows the cited snippet text to the
   * user and nudges them to use the PDF viewer's own Ctrl/Cmd+F search.
   */
  highlightHint?: string;
}

export const PDFViewer: React.FC<PDFViewerProps> = ({ documentId, title, defaultAmount, highlightHint }) => {
  const [hintDismissed, setHintDismissed] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [redactMode, setRedactMode] = useState(false);
  const [sepaPanelOpen, setSepaPanelOpen] = useState(false);
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [amount, setAmount] = useState(defaultAmount ? String(defaultAmount) : '');
  const [sepaQr, setSepaQr] = useState<string | null>(null);
  const [sepaError, setSepaError] = useState<string | null>(null);
  const [sepaLoading, setSepaLoading] = useState(false);

  const fileUrl = `/api/documents/${documentId}/file`;

  const handleGenerateSepaQr = async () => {
    setSepaLoading(true);
    setSepaError(null);
    try {
      const result = await fetchSepaQr(documentId, {
        iban: iban || undefined,
        bic: bic || undefined,
        amount: amount || undefined,
      });
      setSepaQr(result.qrCodeDataUrl);
    } catch (err: any) {
      setSepaError(err?.response?.data?.error || 'QR-Code konnte nicht erzeugt werden.');
      setSepaQr(null);
    } finally {
      setSepaLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 rounded-xl overflow-hidden border border-slate-800">
      {/* PDF Controls Toolbar */}
      <div className="h-12 bg-slate-900/90 border-b border-slate-800 px-4 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom(Math.max(50, zoom - 25))}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="font-mono text-slate-400 w-12 text-center">{zoom}%</span>
          <button
            onClick={() => setZoom(Math.min(200, zoom + 25))}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setRotation((rotation + 90) % 360)}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 ml-2"
            title="Rotate"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        {/* Tools: Highlight & Redact */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSepaPanelOpen(!sepaPanelOpen)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-all ${
              sepaPanelOpen
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="SEPA-Überweisungs-QR-Code erzeugen"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>SEPA-QR</span>
          </button>

          <button
            onClick={() => setRedactMode(!redactMode)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-all ${
              redactMode
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
            <span>Schwärzen (Redact)</span>
          </button>

          <a
            href={fileUrl}
            download={title}
            className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1 px-3 font-medium"
          >
            <Download className="w-4 h-4" />
            <span>Download</span>
          </a>
        </div>
      </div>

      {/* PDF View Container */}
      <div className="flex-1 bg-slate-900 overflow-auto p-4 flex justify-center items-start relative">
        {redactMode && (
          <div className="absolute top-6 z-10 bg-rose-950/90 border border-rose-500/40 text-rose-200 px-4 py-2 rounded-xl text-xs flex items-center gap-2 backdrop-blur-md shadow-xl">
            <ShieldAlert className="w-4 h-4 text-rose-400" />
            <span>Schwärzungsmodus aktiv: Wähle Bereiche im Dokument aus, um sensible Daten irreversibel zu entfernen.</span>
          </div>
        )}

        {highlightHint && !hintDismissed && (
          <div className="absolute top-6 z-10 max-w-xl bg-indigo-950/90 border border-indigo-500/40 text-indigo-200 px-4 py-2.5 rounded-xl text-xs flex items-start gap-2 backdrop-blur-md shadow-xl">
            <Quote className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <p>
                Zitierter Ausschnitt: <span className="italic text-indigo-100">"{highlightHint}"</span>
              </p>
              <p className="text-indigo-400 mt-1">
                Nutze Strg+F / Cmd+F im PDF, um die Textstelle zu finden (automatisches Springen/Hervorheben ist im
                eingebetteten PDF-Viewer technisch nicht möglich).
              </p>
            </div>
            <button
              onClick={() => setHintDismissed(true)}
              className="ml-1 text-indigo-400 hover:text-indigo-200 shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {sepaPanelOpen && (
          <div className="absolute top-6 right-6 z-10 w-72 bg-slate-950/95 border border-emerald-500/30 rounded-xl p-4 backdrop-blur-md shadow-xl space-y-3">
            <div className="flex items-center gap-2 text-emerald-300 text-xs font-semibold">
              <QrCode className="w-4 h-4" />
              <span>SEPA-Überweisung (EPC-QR)</span>
            </div>

            <div className="space-y-2">
              <input
                type="text"
                value={iban}
                onChange={(e) => setIban(e.target.value)}
                placeholder="IBAN (erforderlich)"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500 outline-none"
              />
              <input
                type="text"
                value={bic}
                onChange={(e) => setBic(e.target.value)}
                placeholder="BIC (optional)"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500 outline-none"
              />
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Betrag (€)"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500 outline-none"
              />
            </div>

            <button
              onClick={handleGenerateSepaQr}
              disabled={sepaLoading || !iban || !amount}
              className="w-full flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium py-1.5 rounded-lg"
            >
              {sepaLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
              <span>{sepaLoading ? 'Erzeuge...' : 'QR-Code erzeugen'}</span>
            </button>

            {sepaError && <p className="text-rose-300 text-xs">{sepaError}</p>}

            {sepaQr && (
              <div className="flex flex-col items-center gap-2 pt-1">
                <img src={sepaQr} alt="SEPA EPC-QR Code" className="w-40 h-40 rounded-lg border border-slate-800 bg-white p-1" />
                <p className="text-[11px] text-slate-500 text-center">
                  Mit der Banking-App scannen, um die Überweisung vorauszufüllen.
                </p>
              </div>
            )}
          </div>
        )}

        <iframe
          src={`${fileUrl}#toolbar=0`}
          title={title}
          className="w-full h-full min-h-[500px] rounded-lg border border-slate-800 bg-white"
          style={{
            transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
            transformOrigin: 'top center',
            transition: 'transform 0.2s ease',
          }}
        />
      </div>
    </div>
  );
};
