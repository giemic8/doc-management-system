import React, { useEffect, useState } from 'react';
import { LoginScreen } from './LoginScreen';
import { MfaChallengeScreen } from './MfaChallengeScreen';
import { getStoredToken, clearStoredToken, fetchCurrentUser } from '../services/api';
import { User } from '../types';

interface AuthGateProps {
  children: (user: User, onLogout: () => void) => React.ReactNode;
}

type AuthPhase =
  | { kind: 'loading' }
  | { kind: 'loggedOut' }
  | { kind: 'mfaChallenge'; challengeToken: string; mode: 'verify' | 'setup' }
  | { kind: 'loggedIn'; user: User };

/**
 * Owns the top-level authentication state machine: on mount, checks for a
 * stored session token and validates it against the backend. Renders the
 * login screen, the MFA challenge/setup screen, or the authenticated app
 * shell (via the `children` render prop) accordingly.
 */
export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [phase, setPhase] = useState<AuthPhase>({ kind: 'loading' });

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setPhase({ kind: 'loggedOut' });
      return;
    }

    fetchCurrentUser()
      .then((user) => setPhase({ kind: 'loggedIn', user }))
      .catch(() => {
        clearStoredToken();
        setPhase({ kind: 'loggedOut' });
      });
  }, []);

  const handleLoginSuccess = async () => {
    try {
      const user = await fetchCurrentUser();
      setPhase({ kind: 'loggedIn', user });
    } catch {
      clearStoredToken();
      setPhase({ kind: 'loggedOut' });
    }
  };

  const handleMfaChallenge = (challengeToken: string, mode: 'verify' | 'setup') => {
    setPhase({ kind: 'mfaChallenge', challengeToken, mode });
  };

  const handleMfaVerified = async () => {
    await handleLoginSuccess();
  };

  const handleLogout = () => {
    clearStoredToken();
    setPhase({ kind: 'loggedOut' });
  };

  if (phase.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (phase.kind === 'loggedOut') {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} onMfaChallenge={handleMfaChallenge} />;
  }

  if (phase.kind === 'mfaChallenge') {
    return (
      <MfaChallengeScreen
        challengeToken={phase.challengeToken}
        mode={phase.mode}
        onVerified={handleMfaVerified}
        onCancel={handleLogout}
      />
    );
  }

  return <>{children(phase.user, handleLogout)}</>;
};
