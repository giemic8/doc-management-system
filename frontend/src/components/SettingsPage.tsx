import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, KeyRound, Loader2, RefreshCw, Copy, Check } from 'lucide-react';
import { User } from '../types';
import {
  fetchMfaStatus,
  startMfaSetup,
  confirmMfaSetup,
  disableMfa,
  regenerateBackupCodes,
  fetchOrgMfaRequirement,
  setOrgMfaRequirement,
} from '../services/api';

interface SettingsPageProps {
  user: User;
}

type SetupPhase = 'idle' | 'awaiting-code' | 'showing-backup-codes';

export const SettingsPage: React.FC<SettingsPageProps> = ({ user }) => {
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [backupCodesRemaining, setBackupCodesRemaining] = useState(0);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [setupPhase, setSetupPhase] = useState<SetupPhase>('idle');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [manualSecret, setManualSecret] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const [passwordPrompt, setPasswordPrompt] = useState<'disable' | 'regenerate' | null>(null);
  const [passwordInput, setPasswordInput] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [orgMfaRequired, setOrgMfaRequired] = useState<boolean | null>(null);

  const loadStatus = async () => {
    setLoadingStatus(true);
    try {
      const status = await fetchMfaStatus();
      setMfaEnabled(status.mfaEnabled);
      setBackupCodesRemaining(status.backupCodesRemaining);
    } catch {
      setError('MFA-Status konnte nicht geladen werden.');
    } finally {
      setLoadingStatus(false);
    }
  };

  const loadOrgSetting = async () => {
    if (user.role !== 'admin') return;
    try {
      const { required } = await fetchOrgMfaRequirement();
      setOrgMfaRequired(required);
    } catch {
      // Non-fatal: admin section just won't render a known state.
    }
  };

  useEffect(() => {
    loadStatus();
    loadOrgSetting();
  }, []);

  const handleStartSetup = async () => {
    setError(null);
    setIsBusy(true);
    try {
      const { qrCodeDataUrl, secret } = await startMfaSetup();
      setQrCodeDataUrl(qrCodeDataUrl);
      setManualSecret(secret);
      setSetupPhase('awaiting-code');
    } catch {
      setError('MFA-Einrichtung konnte nicht gestartet werden.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      const { backupCodes } = await confirmMfaSetup(confirmCode.trim());
      setBackupCodes(backupCodes);
      setSetupPhase('showing-backup-codes');
      setConfirmCode('');
      await loadStatus();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Ungültiger Code.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleFinishSetup = () => {
    setSetupPhase('idle');
    setQrCodeDataUrl(null);
    setManualSecret(null);
    setBackupCodes([]);
  };

  const handlePasswordConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      if (passwordPrompt === 'disable') {
        await disableMfa(passwordInput);
        await loadStatus();
        setPasswordPrompt(null);
        setPasswordInput('');
      } else if (passwordPrompt === 'regenerate') {
        const { backupCodes } = await regenerateBackupCodes(passwordInput);
        setBackupCodes(backupCodes);
        setSetupPhase('showing-backup-codes');
        setPasswordPrompt(null);
        setPasswordInput('');
        await loadStatus();
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Falsches Passwort.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopySecret = () => {
    if (!manualSecret) return;
    navigator.clipboard.writeText(manualSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleOrgRequirement = async () => {
    if (orgMfaRequired === null) return;
    setError(null);
    setIsBusy(true);
    try {
      await setOrgMfaRequirement(!orgMfaRequired);
      setOrgMfaRequired(!orgMfaRequired);
    } catch {
      setError('Einstellung konnte nicht geändert werden.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-100">Profil & Sicherheit</h1>
        <p className="text-xs text-slate-400">
          Angemeldet als <span className="text-slate-300 font-medium">{user.name}</span> ({user.email})
        </p>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      )}

      <section className="glass-panel p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {mfaEnabled ? (
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            ) : (
              <ShieldOff className="w-5 h-5 text-slate-500" />
            )}
            <div>
              <h2 className="font-bold text-slate-200 text-sm">Multi-Faktor-Authentifizierung (MFA)</h2>
              {loadingStatus ? (
                <p className="text-xs text-slate-500">Lädt...</p>
              ) : (
                <p className="text-xs text-slate-500">
                  {mfaEnabled
                    ? `Aktiviert · ${backupCodesRemaining} Backup-Codes verbleibend`
                    : 'Nicht aktiviert'}
                </p>
              )}
            </div>
          </div>

          {!loadingStatus && mfaEnabled === false && setupPhase === 'idle' && (
            <button onClick={handleStartSetup} disabled={isBusy} className="btn-primary text-xs py-2 px-3">
              {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Aktivieren'}
            </button>
          )}

          {!loadingStatus && mfaEnabled === true && setupPhase === 'idle' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPasswordPrompt('regenerate')}
                className="btn-secondary text-xs py-2 px-3"
                title="Backup-Codes neu generieren"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Codes erneuern
              </button>
              <button
                onClick={() => setPasswordPrompt('disable')}
                className="btn-secondary text-xs py-2 px-3 hover:border-red-500/50 hover:text-red-400"
              >
                Deaktivieren
              </button>
            </div>
          )}
        </div>

        {setupPhase === 'awaiting-code' && qrCodeDataUrl && (
          <div className="border-t border-slate-800 pt-4 space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-center">
              <img src={qrCodeDataUrl} alt="MFA QR Code" className="w-40 h-40 rounded-lg border border-slate-800" />
              <div className="space-y-2 text-xs text-slate-400">
                <p>Scannen Sie diesen QR-Code mit Google Authenticator, Bitwarden oder 1Password.</p>
                <p className="font-medium text-slate-300">Oder manuell eingeben:</p>
                <button
                  onClick={handleCopySecret}
                  className="font-mono text-indigo-300 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 flex items-center gap-2 hover:border-indigo-500/50 transition-colors"
                >
                  {manualSecret}
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <form onSubmit={handleConfirmSetup} className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <label htmlFor="confirm-code" className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" /> Code aus der App eingeben, um zu bestätigen
                </label>
                <input
                  id="confirm-code"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  required
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 tracking-widest"
                  placeholder="123456"
                />
              </div>
              <button type="submit" disabled={isBusy} className="btn-primary text-sm py-2.5 px-4">
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Bestätigen'}
              </button>
            </form>
          </div>
        )}

        {setupPhase === 'showing-backup-codes' && (
          <div className="border-t border-slate-800 pt-4 space-y-3">
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              Speichern Sie diese Backup-Codes sicher ab. Sie werden nur einmal angezeigt und ermöglichen die
              Anmeldung, falls Sie Ihr Gerät verlieren.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {backupCodes.map((code) => (
                <code key={code} className="font-mono text-sm text-slate-200 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-center">
                  {code}
                </code>
              ))}
            </div>
            <button onClick={handleFinishSetup} className="btn-primary w-full justify-center py-2.5 text-sm">
              Ich habe die Codes gespeichert
            </button>
          </div>
        )}

        {passwordPrompt && (
          <form onSubmit={handlePasswordConfirm} className="border-t border-slate-800 pt-4 space-y-3">
            <p className="text-xs text-slate-400">
              Bitte bestätigen Sie Ihr Passwort, um{' '}
              {passwordPrompt === 'disable' ? 'MFA zu deaktivieren' : 'die Backup-Codes zu erneuern'}.
            </p>
            <input
              type="password"
              autoFocus
              required
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all"
              placeholder="Aktuelles Passwort"
            />
            <div className="flex gap-2">
              <button type="submit" disabled={isBusy} className="btn-primary text-sm py-2 px-4">
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Bestätigen'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPasswordPrompt(null);
                  setPasswordInput('');
                }}
                className="btn-secondary text-sm py-2 px-4"
              >
                Abbrechen
              </button>
            </div>
          </form>
        )}
      </section>

      {user.role === 'admin' && (
        <section className="glass-panel p-6 space-y-3">
          <h2 className="font-bold text-slate-200 text-sm">Org-weite Sicherheitsrichtlinie</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-400">MFA für alle Editoren verpflichtend machen</p>
              <p className="text-[11px] text-slate-500">
                Betrifft nur Konten mit der Rolle „Editor“ — Admin-Konten sind ausgenommen.
              </p>
            </div>
            {orgMfaRequired !== null && (
              <button
                onClick={handleToggleOrgRequirement}
                disabled={isBusy}
                className={`w-11 h-6 rounded-full transition-colors relative ${
                  orgMfaRequired ? 'bg-indigo-500' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    orgMfaRequired ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};
