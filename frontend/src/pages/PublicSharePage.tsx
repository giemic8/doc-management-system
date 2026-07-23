import React, { useEffect, useState } from 'react';
import { FileText, ShieldCheck, Loader2, Download, Lock } from 'lucide-react';
import { fetchPublicShareInfo, verifyPublicSharePassword, getPublicShareDownloadUrl } from '../services/api';
import { PublicShareInfo } from '../types';

interface PublicSharePageProps {
  token: string;
}

const REASON_MESSAGES: Record<string, string> = {
  expired: 'Dieser Freigabe-Link ist abgelaufen.',
  revoked: 'Dieser Freigabe-Link wurde widerrufen.',
  limit_exceeded: 'Das Download-Limit für diesen Link wurde erreicht.',
  locked: 'Zu viele fehlgeschlagene Versuche. Bitte versuche es später erneut.',
  invalid_password: 'Falsches Passwort.',
};

/**
 * Standalone public page for guest access to a shared document — rendered
 * outside the app's normal AuthGate/Navbar/Sidebar shell (see main.tsx),
 * since anonymous guests never log in to this system.
 */
export const PublicSharePage: React.FC<PublicSharePageProps> = ({ token }) => {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<PublicShareInfo | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [downloadReady, setDownloadReady] = useState(false);

  useEffect(() => {
    fetchPublicShareInfo(token)
      .then((result) => {
        setInfo(result);
        if (result.valid && !result.requiresPassword) {
          setDownloadReady(true);
        }
      })
      .catch(() => setError('Link konnte nicht geladen werden.'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyPublicSharePassword(token, password);
      if (result.valid) {
        setDownloadReady(true);
      } else {
        setError(REASON_MESSAGES[result.reason || ''] || 'Zugriff verweigert.');
      }
    } catch (err) {
      setError('Passwort konnte nicht überprüft werden.');
    } finally {
      setVerifying(false);
    }
  };

  const handleDownload = () => {
    window.location.href = getPublicShareDownloadUrl(token, password || undefined);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
            <FileText className="w-6 h-6 text-white" />
          </div>
          <div className="text-center">
            <h1 className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-300 bg-clip-text text-transparent">
              DocVault
            </h1>
            <p className="text-xs text-slate-500 mt-1 flex items-center gap-1 justify-center">
              <ShieldCheck className="w-3 h-3" /> Freigegebenes Dokument
            </p>
          </div>
        </div>

        <div className="glass-panel p-6 space-y-4">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
            </div>
          ) : !info || !info.valid ? (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {REASON_MESSAGES[info?.reason || ''] || 'Dieser Link ist nicht gültig.'}
            </p>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-slate-200 truncate">{info.documentTitle}</h2>

              {info.requiresPassword && !downloadReady && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label htmlFor="share-password" className="text-xs font-medium text-slate-400 flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Passwort erforderlich
                    </label>
                    <input
                      id="share-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/20"
                      placeholder="••••••••"
                    />
                  </div>

                  {error && (
                    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
                  )}

                  <button
                    onClick={handleVerify}
                    disabled={verifying || !password}
                    className="btn-primary w-full justify-center py-2.5 text-sm"
                  >
                    {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Entsperren'}
                  </button>
                </div>
              )}

              {downloadReady && (
                <div className="space-y-3">
                  {error && (
                    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
                  )}
                  <button onClick={handleDownload} className="btn-primary w-full justify-center py-2.5 text-sm">
                    <Download className="w-4 h-4" /> Herunterladen
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
