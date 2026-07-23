import React, { useState } from 'react';
import { FileText, Loader2, ShieldCheck } from 'lucide-react';
import { login } from '../services/api';
import { LoginResult } from '../types';

interface LoginScreenProps {
  onLoginSuccess: (token: string) => void;
  onMfaChallenge: (challengeToken: string, mode: 'verify' | 'setup') => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess, onMfaChallenge }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result: LoginResult = await login(email, password);

      if (result.mfaRequired && result.challengeToken) {
        onMfaChallenge(result.challengeToken, 'verify');
        return;
      }

      if (result.mfaSetupRequired && result.challengeToken) {
        onMfaChallenge(result.challengeToken, 'setup');
        return;
      }

      if (result.token) {
        onLoginSuccess(result.token);
        return;
      }

      setError('Unerwartete Antwort vom Server.');
    } catch (err: any) {
      const message = err?.response?.data?.error || 'Anmeldung fehlgeschlagen.';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
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
              <ShieldCheck className="w-3 h-3" /> Enterprise Document Management
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="glass-panel p-6 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-xs font-medium text-slate-400">
              E-Mail
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="admin@dms.local"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-medium text-slate-400">
              Passwort
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button type="submit" disabled={isSubmitting} className="btn-primary w-full justify-center py-2.5 text-sm">
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
};
