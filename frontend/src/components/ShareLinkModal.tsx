import React, { useEffect, useState } from 'react';
import { X, Link2, Copy, Check, Trash2, Loader2, ShieldCheck } from 'lucide-react';
import { DocumentItem, ShareLinkSummary } from '../types';
import { createShareLink, fetchShareLinks, revokeShareLink } from '../services/api';

interface ShareLinkModalProps {
  document: DocumentItem;
  onClose: () => void;
}

export const ShareLinkModal: React.FC<ShareLinkModalProps> = ({ document, onClose }) => {
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<ShareLinkSummary[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);

  const loadLinks = async () => {
    setLoadingLinks(true);
    try {
      const result = await fetchShareLinks(document.id);
      setLinks(result);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingLinks(false);
    }
  };

  useEffect(() => {
    loadLinks();
  }, [document.id]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await createShareLink(document.id, {
        password: password || undefined,
        expiresInDays: expiresInDays ? parseInt(expiresInDays, 10) : undefined,
        maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : undefined,
      });
      const fullUrl = `${window.location.origin}${result.shareUrl}`;
      setGeneratedUrl(fullUrl);
      setPassword('');
      loadLinks();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Link konnte nicht erstellt werden.');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedUrl) return;
    await navigator.clipboard.writeText(generatedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async (linkId: string) => {
    if (!window.confirm('Diesen Freigabe-Link wirklich widerrufen?')) return;
    try {
      await revokeShareLink(document.id, linkId);
      loadLinks();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="h-14 border-b border-slate-800 px-5 flex items-center justify-between shrink-0 bg-slate-950/50">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-400" />
            <h3 className="font-bold text-slate-100 text-sm">Freigabe-Link erstellen</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          <p className="text-xs text-slate-400">
            Erstelle einen sicheren Link für <span className="text-slate-200 font-semibold">{document.title}</span>, um ihn
            mit externen Personen (Steuerberater, Bank, Familie) zu teilen.
          </p>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Passwort (optional)</label>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leer lassen für keinen Passwortschutz"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-400">Ablauf (Tage)</label>
                <input
                  type="number"
                  min="1"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-400">Max. Downloads</label>
                <input
                  type="number"
                  min="1"
                  value={maxDownloads}
                  onChange={(e) => setMaxDownloads(e.target.value)}
                  placeholder="Unbegrenzt"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
                />
              </div>
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
            )}

            <button onClick={handleCreate} disabled={creating} className="btn-primary w-full justify-center py-2.5 text-sm">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Link erstellen'}
            </button>

            {generatedUrl && (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-xs text-emerald-200 font-mono truncate flex-1">{generatedUrl}</span>
                <button onClick={handleCopy} className="text-emerald-300 hover:text-emerald-100 shrink-0">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-2">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Aktive Links</h4>
            {loadingLinks ? (
              <p className="text-xs text-slate-500">Lade...</p>
            ) : links.length === 0 ? (
              <p className="text-xs text-slate-500">Keine aktiven Freigabe-Links.</p>
            ) : (
              <div className="space-y-2">
                {links.map((link) => (
                  <div
                    key={link.id}
                    className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs"
                  >
                    <div className="text-slate-400 space-y-0.5">
                      <div>
                        Läuft ab: {link.expires_at ? new Date(link.expires_at).toLocaleDateString() : 'Nie'}
                      </div>
                      <div>
                        Downloads: {link.download_count}
                        {link.max_downloads !== null ? ` / ${link.max_downloads}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRevoke(link.id)}
                      className="text-slate-500 hover:text-red-400 flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Widerrufen
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
