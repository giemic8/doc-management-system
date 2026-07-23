import React, { useState } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Highlighter, ShieldAlert, Download } from 'lucide-react';

interface PDFViewerProps {
  documentId: string;
  title: string;
}

export const PDFViewer: React.FC<PDFViewerProps> = ({ documentId, title }) => {
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [redactMode, setRedactMode] = useState(false);

  const fileUrl = `/api/documents/${documentId}/file`;

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
