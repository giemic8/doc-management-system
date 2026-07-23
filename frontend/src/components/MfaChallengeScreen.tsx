import React, { useState } from 'react';
import { Loader2, ShieldAlert, KeyRound } from 'lucide-react';
import { verifyMfaLogin } from '../services/api';

interface MfaChallengeScreenProps {
  challengeToken: string;
  /** 'verify': user already has MFA enabled, entering their code.
   *  'setup': org-wide enforcement requires this user to set up MFA before they can log in. */
  mode: 'verify' | 'setup';
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * Second step of login. In 'verify' mode, the user enters a TOTP or backup
 * code to exchange the challenge token for a session token. 'setup' mode
 * (org-wide enforcement routing a not-yet-enrolled editor here) is handled
 * by MFA enrollment ticket work — for now it explains the requirement and
 * lets the user cancel back to login.
 */
export const MfaChallengeScreen: React.FC<MfaChallengeScreenProps> = ({
  challengeToken,
  mode,
  onVerified,
  onCancel,
}) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await verifyMfaLogin(challengeToken, code.trim());
      onVerified();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Ungültiger Code.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center">
            <ShieldAlert className="w-6 h-6 text-indigo-400" />
          </div>
          <h1 className="font-bold text-lg text-slate-200 text-center">
            {mode === 'setup' ? 'MFA-Einrichtung erforderlich' : 'Zwei-Faktor-Authentifizierung'}
          </h1>
        </div>

        {mode === 'setup' ? (
          <div className="glass-panel p-6 space-y-4 text-center">
            <p className="text-sm text-slate-400">
              Ihr Administrator verlangt Multi-Faktor-Authentifizierung für Ihr Konto. Bitte richten Sie
              MFA über die Profileinstellungen ein, sobald Sie angemeldet sind.
            </p>
            <button onClick={onCancel} className="btn-secondary w-full justify-center py-2.5 text-sm">
              Zurück zur Anmeldung
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="glass-panel p-6 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="mfa-code" className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" /> Authenticator- oder Backup-Code
              </label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/20 tracking-widest text-center"
                placeholder="123456"
              />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={isSubmitting} className="btn-primary w-full justify-center py-2.5 text-sm">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Bestätigen'}
            </button>

            <button
              type="button"
              onClick={onCancel}
              className="w-full text-center text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Zurück zur Anmeldung
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
