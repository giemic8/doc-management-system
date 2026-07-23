import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { DocumentList } from './components/DocumentList';
import { DocumentDetailModal } from './components/DocumentDetailModal';
import { MobileScanner } from './components/MobileScanner';
import { WorkflowEditor } from './components/WorkflowEditor';
import { AuditLogView } from './components/AuditLogView';
import { SettingsPage } from './components/SettingsPage';
import { AuthGate } from './components/AuthGate';
import { BatchUploadQueue } from './components/BatchUploadQueue';
import { DocumentItem, User } from './types';
import { fetchDocuments, uploadDocument, bulkAddTag, bulkSetDocType, bulkDeleteDocuments, fetchTags } from './services/api';
import { FolderSync, ListChecks, X, Tag as TagIcon, Trash2, FolderInput } from 'lucide-react';

const AppShell: React.FC<{ user: User; onLogout: () => void }> = ({ user, onLogout }) => {
  const [currentTab, setCurrentTab] = useState('documents');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDoc, setSelectedDoc] = useState<DocumentItem | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadDocs = async () => {
    try {
      const data = await fetchDocuments({ search: searchQuery });
      setDocuments(data || []);
    } catch (err) {
      console.warn('API connection offline / using demo data', err);
      // Demo dataset if backend is launching
      setDocuments([
        {
          id: 'demo-1',
          title: 'Rechnung_Server_Hardware_2026.pdf',
          original_filename: 'Rechnung_Server_Hardware_2026.pdf',
          file_path: '/storage/originals/2026/07/demo1.pdf',
          file_size: 458920,
          mime_type: 'application/pdf',
          file_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          status: 'processed',
          doc_type: 'Rechnung',
          sender: 'Dell Technologies GmbH',
          document_date: '2026-07-15',
          amount: 1499.00,
          currency: 'EUR',
          summary: 'Rechnung über PowerEdge Server & 64GB RAM Riegel für Heimlabor / Docker Host.',
          ocr_text: 'RECHNUNG Nr. 982341\nDatum: 15.07.2026\nDell Technologies\nGesamtsumme: 1.499,00 EUR',
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [{ id: 't1', name: 'Finanzen', color: '#10B981' }, { id: 't2', name: 'Rechnung', color: '#EF4444' }],
        },
        {
          id: 'demo-2',
          title: 'Mietvertrag_Wohnung_Signed.pdf',
          original_filename: 'Mietvertrag_Wohnung_Signed.pdf',
          file_path: '/storage/originals/2026/07/demo2.pdf',
          file_size: 1204000,
          mime_type: 'application/pdf',
          file_hash: 'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e',
          status: 'processed',
          doc_type: 'Vertrag',
          sender: 'Hausverwaltung Immobilien GmbH',
          document_date: '2026-01-01',
          summary: 'Unterschriebener Mietvertrag inkl. Nebenkostenaufstellung und Kautionsvereinbarung.',
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [{ id: 't3', name: 'Vertrag', color: '#8B5CF6' }, { id: 't4', name: 'Wichtig', color: '#EC4899' }],
        }
      ]);
    }
  };

  useEffect(() => {
    loadDocs();
  }, [searchQuery]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setIsUploading(true);
      try {
        await uploadDocument(e.target.files[0]);
        loadDocs();
      } catch (err) {
        console.error(err);
      } finally {
        setIsUploading(false);
      }
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkAddTag = async () => {
    const tags = await fetchTags().catch(() => []);
    if (tags.length === 0) return;
    const tagId = window.prompt(
      `Tag hinzufügen zu ${selectedIds.size} Dokumenten. Verfügbare Tags:\n${tags.map((t: any) => `${t.name} (${t.id})`).join('\n')}\n\nTag-ID eingeben:`
    );
    if (!tagId) return;
    await bulkAddTag(Array.from(selectedIds), tagId);
    setSelectedIds(new Set());
    loadDocs();
  };

  const handleBulkSetDocType = async () => {
    const docType = window.prompt(`Dokumenttyp setzen für ${selectedIds.size} Dokumente:`);
    if (!docType) return;
    await bulkSetDocType(Array.from(selectedIds), docType);
    setSelectedIds(new Set());
    loadDocs();
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`${selectedIds.size} Dokumente wirklich löschen?`)) return;
    await bulkDeleteDocuments(Array.from(selectedIds));
    setSelectedIds(new Set());
    loadDocs();
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Navbar
        user={user}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onUploadClick={() => document.getElementById('file-upload-input')?.click()}
        onCameraClick={() => setShowScanner(true)}
        onSettingsClick={() => setCurrentTab('settings')}
        onLogout={onLogout}
      />

      <input
        type="file"
        id="file-upload-input"
        className="hidden"
        accept="application/pdf,image/*"
        onChange={handleFileUpload}
      />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentTab={currentTab} onTabChange={setCurrentTab} />

        <main className="flex-1 p-6 overflow-auto">
          {currentTab === 'documents' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-2xl font-extrabold text-slate-100">Dokumenten Bibliothek</h1>
                  <p className="text-xs text-slate-400">Automatische OCR, KI-Verschlagwortung und Volltextsuche.</p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl font-medium">
                    {documents.length} Dokumente indiziert
                  </span>
                  <button
                    onClick={() => {
                      setBulkMode((v) => !v);
                      setSelectedIds(new Set());
                    }}
                    className={`btn-secondary text-xs py-2 px-3 ${bulkMode ? 'border-indigo-500 text-indigo-300' : ''}`}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                    {bulkMode ? 'Auswahl beenden' : 'Mehrfachauswahl'}
                  </button>
                </div>
              </div>

              {bulkMode && selectedIds.size > 0 && (
                <div className="glass-panel p-3 flex items-center justify-between">
                  <span className="text-xs text-slate-300 font-medium">{selectedIds.size} ausgewählt</span>
                  <div className="flex items-center gap-2">
                    <button onClick={handleBulkAddTag} className="btn-secondary text-xs py-1.5 px-3">
                      <TagIcon className="w-3.5 h-3.5" /> Tag hinzufügen
                    </button>
                    <button onClick={handleBulkSetDocType} className="btn-secondary text-xs py-1.5 px-3">
                      <FolderInput className="w-3.5 h-3.5" /> Typ ändern
                    </button>
                    <button onClick={handleBulkDelete} className="btn-secondary text-xs py-1.5 px-3 hover:border-red-500/50 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" /> Löschen
                    </button>
                    <button onClick={() => setSelectedIds(new Set())} className="text-slate-500 hover:text-slate-300">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              <DocumentList
                documents={documents}
                onSelectDocument={setSelectedDoc}
                bulkMode={bulkMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
              />
            </div>
          )}

          {currentTab === 'watchfolder' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-2xl font-extrabold text-slate-100">Inbound Watchfolder</h1>
                <p className="text-xs text-slate-400">Dateien in <code className="text-indigo-400 font-mono">storage/input/</code> werden automatisch verarbeitet.</p>
              </div>

              <div className="glass-panel p-8 text-center space-y-4">
                <FolderSync className="w-12 h-12 text-indigo-400 mx-auto animate-pulse" />
                <h3 className="font-bold text-slate-200 text-lg">Watchfolder Listener ist aktiv</h3>
                <p className="text-slate-400 text-xs max-w-md mx-auto">
                  Lege eingescannte Dokumente oder Netzwerk-Scans direkt im Dateisystem ab. Sie erscheinen in Echtzeit in deiner Bibliothek.
                </p>
              </div>
            </div>
          )}

          {currentTab === 'workflows' && <WorkflowEditor />}
          {currentTab === 'audit' && <AuditLogView />}
          {currentTab === 'settings' && <SettingsPage user={user} />}
        </main>
      </div>

      {/* Modals */}
      {selectedDoc && (
        <DocumentDetailModal
          document={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onUpdate={loadDocs}
        />
      )}

      {showScanner && (
        <MobileScanner
          onClose={() => setShowScanner(false)}
          onUploadSuccess={loadDocs}
        />
      )}

      <BatchUploadQueue onAllComplete={loadDocs} />
    </div>
  );
};

export const App: React.FC = () => (
  <AuthGate>{(user, onLogout) => <AppShell user={user} onLogout={onLogout} />}</AuthGate>
);
