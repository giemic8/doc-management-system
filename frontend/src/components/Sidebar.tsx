import React, { useEffect, useState } from 'react';
import { Activity, ClipboardCheck, Files, FolderSync, GitMerge, ShieldCheck, Tag, Settings, LayoutDashboard, BarChart3, FileClock, HardDriveDownload, Lock, Trash2, Users } from 'lucide-react';
import { OpsCapacity } from '../types';
import { fetchOpsCapacity, fetchReviewCount } from '../services/api';
import { formatBytes } from './OpsDashboard';

interface SidebarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  userRole?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onTabChange, userRole }) => {
  // Ticket #35 -- an inbox nobody notices is not an inbox. The count is
  // refreshed on a slow interval rather than on every render: it is a
  // nudge, not live data, and a failed poll simply leaves it hidden.
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchReviewCount()
        .then((count) => {
          if (!cancelled) setReviewCount(count);
        })
        .catch(() => {
          if (!cancelled) setReviewCount(null);
        });
    };
    load();
    const handle = window.setInterval(load, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [currentTab]);

  // Ticket #37 -- the storage card reads measured capacity instead of a
  // hardcoded figure. Only admins may read it (the endpoint is admin-only),
  // so everyone else sees an explicit "not available" rather than a number
  // that was never true for anybody.
  const [capacity, setCapacity] = useState<OpsCapacity | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);

  useEffect(() => {
    if (userRole !== 'admin') {
      setCapacityError('Speicherbelegung nur für Administratoren sichtbar.');
      return;
    }
    let cancelled = false;
    fetchOpsCapacity()
      .then((data) => {
        if (!cancelled) setCapacity(data);
      })
      .catch(() => {
        if (!cancelled) setCapacityError('Speicherbelegung nicht verfügbar.');
      });
    return () => {
      cancelled = true;
    };
  }, [userRole]);

  const totalBytes = Number(capacity?.metrics?.originalsTotalBytes ?? 0);
  const usedBytes = Number(capacity?.metrics?.originalsUsedBytes ?? 0);
  const usedPercent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : null;

  const navItems = [
    { id: 'documents', label: 'Alle Dokumente', icon: Files },
    // Visible to every role (Ticket #35): the inbox is a document list, so
    // the backend shows each user only the questions about documents they
    // may read, and the badge counts exactly those.
    { id: 'review', label: 'Prüfen', icon: ClipboardCheck },
    // Visible to every role (Ticket #34): the backend decides which spaces a
    // user may see, and shows private ones they cannot read as `accessible: false`.
    { id: 'spaces', label: 'Familienbereiche', icon: Users },
    // Visible to every role (Ticket #33): the trash listing is ACL-filtered
    // server-side, and only the purge actions inside it are admin-gated.
    { id: 'trash', label: 'Papierkorb', icon: Trash2 },
    { id: 'watchfolder', label: 'Inbound Scan Folder', icon: FolderSync },
    { id: 'workflows', label: 'Workflows & Regeln', icon: GitMerge },
    { id: 'audit', label: 'Audit Log & Revisions', icon: ShieldCheck },
    { id: 'analytics', label: 'Kostenanalyse', icon: BarChart3 },
    { id: 'contracts', label: 'Verträge', icon: FileClock },
    // Admin-only: backup health is sensitive infra data (Ticket #17), so we
    // hide the nav item entirely for non-admins rather than relying solely
    // on the backend's 403 fallback.
    ...(userRole === 'admin' ? [{ id: 'backup', label: 'Backup & Recovery', icon: HardDriveDownload }] : []),
    // Admin-only: access-group / tag-ACL management (Ticket #19), same
    // client-side hiding pattern as the Backup tab above.
    ...(userRole === 'admin' ? [{ id: 'acl', label: 'Zugriffsgruppen (ACL)', icon: Lock }] : []),
    // Admin-only (Ticket #37): component health, incidents and alert
    // thresholds are infrastructure data, hidden the same way as Backup.
    ...(userRole === 'admin' ? [{ id: 'ops', label: 'Betrieb & Alarme', icon: Activity }] : []),
    { id: 'settings', label: 'Profil & Sicherheit', icon: Settings },
  ];

  return (
    <aside className="hidden md:flex w-64 border-r border-slate-800/80 bg-slate-950/40 p-4 flex-col justify-between shrink-0 min-h-[calc(100vh-4rem)]">
      <div className="space-y-1">
        <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Navigation
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-indigo-600/20 to-purple-600/10 text-indigo-300 border border-indigo-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
              <span>{item.label}</span>
              {item.id === 'review' && reviewCount !== null && reviewCount > 0 && (
                <span className="ml-auto rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                  {reviewCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Storage info card -- Ticket #37: measured, not decorative. The old
          "1.2 GB / 100 GB" was a hardcoded illustration that stayed
          reassuring while a volume filled up. Numbers now come from statfs
          on the originals volume via GET /api/ops/capacity; for non-admins
          (who may not read infrastructure data) the card states what it
          cannot show instead of inventing a figure. */}
      <div className="glass-card p-4 space-y-2 text-xs">
        <div className="flex justify-between text-slate-400">
          <span>Speicherplatz</span>
          <span className="font-semibold text-slate-200">
            {usedPercent === null
              ? '—'
              : `${formatBytes(capacity?.metrics?.originalsUsedBytes)} / ${formatBytes(
                  capacity?.metrics?.originalsTotalBytes
                )}`}
          </span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full ${usedPercent !== null && usedPercent >= 90 ? 'bg-rose-500' : 'bg-indigo-500'}`}
            style={{ width: `${usedPercent ?? 0}%` }}
          />
        </div>
        <div className="text-[11px] text-slate-500">
          {usedPercent === null
            ? capacityError ?? 'Speichermessung wird geladen...'
            : `${capacity?.metrics?.originalsFreePercent ?? '—'} % frei · Dual-Storage: Originale zusätzlich als Zweitkopie.`}
        </div>
      </div>
    </aside>
  );
};
