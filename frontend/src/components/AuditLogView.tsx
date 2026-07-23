import React, { useState, useEffect } from 'react';
import { ShieldCheck, User, Clock, FileText } from 'lucide-react';
import { fetchAuditLogs } from '../services/api';
import { AuditLog } from '../types';

export const AuditLogView: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    fetchAuditLogs().then(setLogs).catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Audit-Log & Revisionssicherheit</h2>
        <p className="text-xs text-slate-400">Vollständiger Lückenloser Verlauf aller Aktionen und Dokumentenänderungen.</p>
      </div>

      <div className="glass-panel overflow-hidden border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
            <tr>
              <th className="p-3 font-semibold">Zeitpunkt</th>
              <th className="p-3 font-semibold">Benutzer</th>
              <th className="p-3 font-semibold">Aktion</th>
              <th className="p-3 font-semibold">Dokument</th>
              <th className="p-3 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Keine Audit-Logs vorhanden.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-900/40">
                  <td className="p-3 text-slate-400 font-mono whitespace-nowrap">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="p-3 text-slate-300 font-medium">{log.user_name || 'System'}</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      {log.action}
                    </span>
                  </td>
                  <td className="p-3 text-slate-300 truncate max-w-xs">{log.document_title || '-'}</td>
                  <td className="p-3 text-slate-400 font-mono truncate max-w-xs">
                    {log.details ? JSON.stringify(log.details) : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
