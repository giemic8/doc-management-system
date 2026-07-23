import React from 'react';
import { Files, FolderSync, GitMerge, ShieldCheck, Tag, Settings, LayoutDashboard } from 'lucide-react';

interface SidebarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onTabChange }) => {
  const navItems = [
    { id: 'documents', label: 'Alle Dokumente', icon: Files },
    { id: 'watchfolder', label: 'Inbound Scan Folder', icon: FolderSync },
    { id: 'workflows', label: 'Workflows & Regeln', icon: GitMerge },
    { id: 'audit', label: 'Audit Log & Revisions', icon: ShieldCheck },
  ];

  return (
    <aside className="w-64 border-r border-slate-800/80 bg-slate-950/40 p-4 flex flex-col justify-between shrink-0 min-h-[calc(100vh-4rem)]">
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
            </button>
          );
        })}
      </div>

      {/* Storage info card */}
      <div className="glass-card p-4 space-y-2 text-xs">
        <div className="flex justify-between text-slate-400">
          <span>Speicherplatz</span>
          <span className="font-semibold text-slate-200">1.2 GB / 100 GB</span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div className="bg-indigo-500 h-full w-[1.2%]" />
        </div>
        <div className="text-[11px] text-slate-500">
          Dual-Storage: Originale auf NAS / Local Storage erhalten.
        </div>
      </div>
    </aside>
  );
};
