import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { registerServiceWorker, registerBackgroundSyncOrFallback } from './services/offlineSync';
import { PublicSharePage } from './pages/PublicSharePage';

// Pragmatic client-side routing: this app has no routing library, and the
// public /share/:token page (Ticket #16) is the first route that must be
// rendered OUTSIDE the normal AuthGate/Navbar/Sidebar shell, since guests
// are never logged in. Rather than pull in react-router for a single
// route, we just inspect window.location.pathname once at startup. If the
// app grows more standalone public routes, introducing a proper router at
// that point would be worth it.
const shareMatch = window.location.pathname.match(/^\/share\/([a-f0-9]{64})\/?$/);

const rootElement = shareMatch ? <PublicSharePage token={shareMatch[1]} /> : <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{rootElement}</React.StrictMode>
);

if (!shareMatch) {
  registerServiceWorker().then(() => registerBackgroundSyncOrFallback());
}

