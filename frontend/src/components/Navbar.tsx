import React, { useState } from 'react';
import { Search, Upload, Camera, FileText, Settings, LogOut, MessageSquare } from 'lucide-react';
import { User } from '../types';
import { OfflineQueueIndicator } from './OfflineQueueIndicator';

interface NavbarProps {
  user: User | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onUploadClick: () => void;
  onCameraClick: () => void;
  onSettingsClick: () => void;
  onLogout: () => void;
  onChatClick?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  user,
  searchQuery,
  onSearchChange,
  onUploadClick,
  onCameraClick,
  onSettingsClick,
  onLogout,
  onChatClick,
}) => {
  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40 px-3 sm:px-6 flex items-center justify-between gap-2">
      {/* Brand */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
          <FileText className="w-5 h-5 text-white" />
        </div>
        <div className="hidden sm:block">
          <span className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-300 bg-clip-text text-transparent">
            DocVault
          </span>
          <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            Enterprise
          </span>
        </div>
      </div>

      {/* Global Search */}
      <div className="hidden md:block flex-1 max-w-xl mx-4 lg:mx-8 relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Suche in allen Dokumenten, OCR-Texten, Absendern..."
          className="w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 rounded-xl pl-10 pr-4 py-2 outline-none transition-all placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-1 sm:gap-3">
        <OfflineQueueIndicator />

        {/* AI Document Assistant (Ticket #18) */}
        {onChatClick && (
          <div className="hidden xl:block">
            <button
              onClick={onChatClick}
              className="btn-secondary text-sm py-2 px-3 hover:border-indigo-500/50 hover:text-indigo-400"
              title="Dokumenten-Assistent (KI-Chat)"
            >
              <MessageSquare className="w-4 h-4 text-indigo-400" />
              <span>Assistent</span>
            </button>
          </div>
        )}

        {/* Mobile Camera Scan */}
        <button
          onClick={onCameraClick}
          className="btn-secondary text-sm py-2 px-3 hover:border-purple-500/50 hover:text-purple-400"
          title="Dokument mit Smartphone scannen"
        >
          <Camera className="w-4 h-4 text-purple-400" />
          <span className="hidden sm:inline">Kamera Scan</span>
        </button>

        {/* Upload Button */}
        <button onClick={onUploadClick} className="btn-primary text-sm py-2 px-4">
          <Upload className="w-4 h-4" />
          <span className="hidden sm:inline">Upload</span>
        </button>

        {/* User Badge */}
        <div className="hidden sm:block h-8 w-px bg-slate-800 mx-1" />
        <button
          onClick={onSettingsClick}
          className="w-8 h-8 rounded-full bg-indigo-950 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xs hover:border-indigo-400 transition-colors"
          title="Profileinstellungen"
        >
          {user ? user.name.substring(0, 2).toUpperCase() : 'AD'}
        </button>
        <button
          onClick={onSettingsClick}
          className="hidden sm:inline-flex p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
          title="Einstellungen"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          onClick={onLogout}
          className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-900 transition-colors"
          title="Abmelden"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
