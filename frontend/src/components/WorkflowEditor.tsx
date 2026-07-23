import React, { useState, useEffect } from 'react';
import { GitMerge, Plus, CheckCircle2, Play, Settings } from 'lucide-react';
import { fetchWorkflows } from '../services/api';
import { Workflow } from '../types';

export const WorkflowEditor: React.FC = () => {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  useEffect(() => {
    fetchWorkflows().then(setWorkflows).catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Automatisierungs-Workflows</h2>
          <p className="text-xs text-slate-400">Regelbasierte Aktionen beim Ingestieren von Dokumenten.</p>
        </div>
        <button className="btn-primary text-xs py-2 px-3">
          <Plus className="w-4 h-4" />
          <span>Neuer Workflow</span>
        </button>
      </div>

      <div className="space-y-3">
        {workflows.length === 0 ? (
          <div className="glass-card p-6 text-center text-slate-400 text-sm">
            Standard-Regeln aktiviert: Automatische Erstellung von Fälligkeits-Erinnerungen für Rechnungen.
          </div>
        ) : (
          workflows.map((wf) => (
            <div key={wf.id} className="glass-card p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400">
                  <GitMerge className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-semibold text-sm text-slate-200">{wf.name}</h4>
                  <p className="text-xs text-slate-400">Event: {wf.trigger_event}</p>
                </div>
              </div>
              <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Aktiv
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
