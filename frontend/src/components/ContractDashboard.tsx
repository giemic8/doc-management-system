import React, { useEffect, useState } from 'react';
import { FileClock, ShieldAlert, ShieldCheck, AlertTriangle, Loader2, Save, FileDown } from 'lucide-react';
import { fetchContracts, updateContractDetails, downloadCancellationLetter } from '../services/api';

type ContractStatus = 'active' | 'notice_deadline_nearing' | 'expired';

interface Contract {
  document_id: string;
  title: string;
  sender?: string;
  document_date?: string;
  due_date?: string;
  customer_number?: string;
  vendor_address?: string;
  notice_period_days?: number;
  cancellation_deadline?: string;
  contract_end_date?: string;
  alert_sent_at?: string;
  status: ContractStatus;
}

interface EditState {
  customer_number: string;
  vendor_address: string;
  notice_period_days: number;
  contract_end_date: string;
}

const STATUS_LABELS: Record<ContractStatus, string> = {
  active: 'Aktiv',
  notice_deadline_nearing: 'Kündigungsfrist naht',
  expired: 'Abgelaufen',
};

const STATUS_CLASSES: Record<ContractStatus, string> = {
  active: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
  notice_deadline_nearing: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
  expired: 'bg-rose-500/20 text-rose-300 border border-rose-500/40',
};

const STATUS_ICONS: Record<ContractStatus, React.ComponentType<{ className?: string }>> = {
  active: ShieldCheck,
  notice_deadline_nearing: AlertTriangle,
  expired: ShieldAlert,
};

const emptyEditState = (): EditState => ({
  customer_number: '',
  vendor_address: '',
  notice_period_days: 30,
  contract_end_date: '',
});

export const ContractDashboard: React.FC = () => {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>(emptyEditState());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  const loadContracts = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchContracts();
      setContracts(data || []);
    } catch (err) {
      setError('Verträge konnten nicht geladen werden.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadContracts();
  }, []);

  const startEdit = (contract: Contract) => {
    setEditingId(contract.document_id);
    setEditState({
      customer_number: contract.customer_number || '',
      vendor_address: contract.vendor_address || '',
      notice_period_days: contract.notice_period_days ?? 30,
      contract_end_date: contract.contract_end_date ? contract.contract_end_date.slice(0, 10) : '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditState(emptyEditState());
  };

  const saveEdit = async (documentId: string) => {
    setSavingId(documentId);
    try {
      await updateContractDetails(documentId, {
        customer_number: editState.customer_number || undefined,
        vendor_address: editState.vendor_address || undefined,
        notice_period_days: Number(editState.notice_period_days) || 30,
        contract_end_date: editState.contract_end_date || undefined,
      });
      setEditingId(null);
      await loadContracts();
    } catch (err) {
      setError('Vertragsdetails konnten nicht gespeichert werden.');
      console.error(err);
    } finally {
      setSavingId(null);
    }
  };

  const handleGenerateLetter = async (documentId: string) => {
    setGeneratingId(documentId);
    try {
      await downloadCancellationLetter(documentId);
    } catch (err) {
      setError('Kündigungsschreiben konnte nicht erzeugt werden.');
      console.error(err);
    } finally {
      setGeneratingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <FileClock className="w-5 h-5 text-indigo-400" />
          Vertragsverwaltung
        </h2>
        <p className="text-xs text-slate-400">
          Behalte Kündigungsfristen und Vertragslaufzeiten im Blick und generiere Kündigungsschreiben mit einem Klick.
        </p>
      </div>

      {error && (
        <div className="glass-panel border border-rose-500/30 bg-rose-950/40 text-rose-200 px-4 py-2 rounded-xl text-xs">
          {error}
        </div>
      )}

      <div className="glass-panel overflow-hidden border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
            <tr>
              <th className="p-3 font-semibold">Vertrag</th>
              <th className="p-3 font-semibold">Anbieter</th>
              <th className="p-3 font-semibold">Kundennummer</th>
              <th className="p-3 font-semibold">Kündigungsfrist</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3 font-semibold">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                  Lade Verträge…
                </td>
              </tr>
            ) : contracts.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  Keine Verträge gefunden.
                </td>
              </tr>
            ) : (
              contracts.map((contract) => {
                const StatusIcon = STATUS_ICONS[contract.status];
                const isEditing = editingId === contract.document_id;
                return (
                  <React.Fragment key={contract.document_id}>
                    <tr className="hover:bg-slate-900/40">
                      <td className="p-3 text-slate-200 font-medium max-w-xs truncate">{contract.title}</td>
                      <td className="p-3 text-slate-300">{contract.sender || '-'}</td>
                      <td className="p-3 text-slate-400 font-mono">{contract.customer_number || '-'}</td>
                      <td className="p-3 text-slate-400 font-mono whitespace-nowrap">
                        {contract.cancellation_deadline
                          ? new Date(contract.cancellation_deadline).toLocaleDateString('de-DE')
                          : '-'}
                      </td>
                      <td className="p-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${STATUS_CLASSES[contract.status]}`}>
                          <StatusIcon className="w-3 h-3" />
                          {STATUS_LABELS[contract.status]}
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => (isEditing ? cancelEdit() : startEdit(contract))}
                            className="btn-secondary text-[11px] py-1 px-2"
                          >
                            {isEditing ? 'Abbrechen' : 'Bearbeiten'}
                          </button>
                          <button
                            onClick={() => handleGenerateLetter(contract.document_id)}
                            disabled={generatingId === contract.document_id}
                            className="btn-secondary text-[11px] py-1 px-2 hover:border-indigo-500/50 hover:text-indigo-300 disabled:opacity-50"
                          >
                            {generatingId === contract.document_id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <FileDown className="w-3 h-3" />
                            )}
                            Kündigungsschreiben generieren
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isEditing && (
                      <tr className="bg-slate-950/60">
                        <td colSpan={6} className="p-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="space-y-1">
                              <label className="text-[11px] text-slate-400">Kundennummer</label>
                              <input
                                type="text"
                                value={editState.customer_number}
                                onChange={(e) => setEditState((s) => ({ ...s, customer_number: e.target.value }))}
                                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-500 outline-none"
                              />
                            </div>
                            <div className="space-y-1 col-span-2">
                              <label className="text-[11px] text-slate-400">Anbieteradresse</label>
                              <input
                                type="text"
                                value={editState.vendor_address}
                                onChange={(e) => setEditState((s) => ({ ...s, vendor_address: e.target.value }))}
                                placeholder="Straße, PLZ Ort"
                                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-500 outline-none"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-slate-400">Kündigungsfrist (Tage)</label>
                              <input
                                type="number"
                                min={0}
                                value={editState.notice_period_days}
                                onChange={(e) => setEditState((s) => ({ ...s, notice_period_days: Number(e.target.value) }))}
                                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-500 outline-none"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-slate-400">Vertragsende</label>
                              <input
                                type="date"
                                value={editState.contract_end_date}
                                onChange={(e) => setEditState((s) => ({ ...s, contract_end_date: e.target.value }))}
                                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-500 outline-none"
                              />
                            </div>
                            <div className="flex items-end">
                              <button
                                onClick={() => saveEdit(contract.document_id)}
                                disabled={savingId === contract.document_id}
                                className="w-full flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium py-1.5 rounded-lg"
                              >
                                {savingId === contract.document_id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Save className="w-3.5 h-3.5" />
                                )}
                                Speichern
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
