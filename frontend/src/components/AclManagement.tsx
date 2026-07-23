import React, { useEffect, useState } from 'react';
import { ShieldCheck, Plus, Trash2, Users, Tag as TagIcon, Loader2, Check, X } from 'lucide-react';
import { AccessGroup, AccessGroupMember, GroupTagPermission, Tag as TagType } from '../types';
import {
  fetchAccessGroups,
  createAccessGroup,
  deleteAccessGroup,
  fetchAccessGroupMembers,
  updateAccessGroupMembers,
  fetchAccessGroupTagPermissions,
  setAccessGroupTagPermission,
  removeAccessGroupTagPermission,
  fetchAllUsers,
  fetchTags,
} from '../services/api';

/**
 * Admin-only "Access Groups & Tag ACLs" management UI (Ticket #19).
 * Lets an admin create groups, assign members, and grant per-tag
 * read/write/delete permissions to each group. Enforcement of these
 * grants happens entirely server-side (see backend/src/services/acl.service.ts) —
 * this page is purely the configuration surface.
 */
export const AclManagement: React.FC = () => {
  const [groups, setGroups] = useState<AccessGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [members, setMembers] = useState<AccessGroupMember[]>([]);
  const [allUsers, setAllUsers] = useState<AccessGroupMember[]>([]);
  const [allTags, setAllTags] = useState<TagType[]>([]);
  const [permissions, setPermissions] = useState<GroupTagPermission[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadGroups = async () => {
    try {
      const [groupsData, usersData, tagsData] = await Promise.all([
        fetchAccessGroups(),
        fetchAllUsers().catch(() => []),
        fetchTags().catch(() => []),
      ]);
      setGroups(groupsData);
      setAllUsers(usersData);
      setAllTags(tagsData);
    } catch (err) {
      console.error('Failed to load access groups:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGroups();
  }, []);

  const loadGroupDetail = async (groupId: string) => {
    setSelectedGroupId(groupId);
    const [memberData, permData] = await Promise.all([
      fetchAccessGroupMembers(groupId),
      fetchAccessGroupTagPermissions(groupId),
    ]);
    setMembers(memberData);
    setPermissions(permData);
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    setBusy(true);
    try {
      await createAccessGroup(newGroupName.trim());
      setNewGroupName('');
      await loadGroups();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Gruppe konnte nicht erstellt werden.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!window.confirm('Diese Zugriffsgruppe wirklich löschen?')) return;
    await deleteAccessGroup(groupId);
    if (selectedGroupId === groupId) setSelectedGroupId(null);
    await loadGroups();
  };

  const toggleMember = async (userId: string) => {
    if (!selectedGroupId) return;
    const isMember = members.some((m) => m.id === userId);
    const nextMemberIds = isMember
      ? members.filter((m) => m.id !== userId).map((m) => m.id)
      : [...members.map((m) => m.id), userId];
    await updateAccessGroupMembers(selectedGroupId, nextMemberIds);
    await loadGroupDetail(selectedGroupId);
    await loadGroups();
  };

  const togglePermission = async (tag: TagType, field: 'can_read' | 'can_write' | 'can_delete') => {
    if (!selectedGroupId) return;
    const existing = permissions.find((p) => p.tag_id === tag.id);
    const next = {
      canRead: field === 'can_read' ? !(existing?.can_read ?? false) : existing?.can_read ?? false,
      canWrite: field === 'can_write' ? !(existing?.can_write ?? false) : existing?.can_write ?? false,
      canDelete: field === 'can_delete' ? !(existing?.can_delete ?? false) : existing?.can_delete ?? false,
    };

    if (!next.canRead && !next.canWrite && !next.canDelete && existing) {
      await removeAccessGroupTagPermission(selectedGroupId, tag.id);
    } else {
      await setAccessGroupTagPermission(selectedGroupId, tag.id, next);
    }
    await loadGroupDetail(selectedGroupId);
    await loadGroups();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-100 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-indigo-400" />
          Zugriffsgruppen & Tag-Berechtigungen
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Steuere, welche Dokument-Tags für welche Nutzergruppen sichtbar/bearbeitbar sind. Admins sehen
          weiterhin alle Dokumente unabhängig von diesen Regeln. Solange keine Gruppe konfiguriert ist,
          bleiben alle Dokumente für alle Nutzer sichtbar (rückwärtskompatibel).
        </p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Groups list */}
        <div className="glass-panel p-4 space-y-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Gruppen</h3>

          <div className="flex gap-2">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Neue Gruppe..."
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 outline-none"
              onKeyDown={(e) => e.key === 'Enter' && handleCreateGroup()}
            />
            <button onClick={handleCreateGroup} disabled={busy} className="btn-primary text-xs py-2 px-3">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1">
            {groups.map((group) => (
              <div
                key={group.id}
                onClick={() => loadGroupDetail(group.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-all ${
                  selectedGroupId === group.id
                    ? 'bg-gradient-to-r from-indigo-600/20 to-purple-600/10 text-indigo-300 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <div>
                  <div className="font-medium">{group.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {group.member_count} Mitglieder &middot; {group.granted_tag_count} Tags
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteGroup(group.id);
                  }}
                  className="text-slate-500 hover:text-rose-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="text-xs text-slate-500 py-4 text-center">Noch keine Zugriffsgruppen angelegt.</p>
            )}
          </div>
        </div>

        {/* Group detail: members + tag permission matrix */}
        <div className="col-span-2 glass-panel p-4 space-y-6">
          {!selectedGroupId ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              Wähle links eine Gruppe aus, um Mitglieder und Tag-Berechtigungen zu verwalten.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Mitglieder
                </h3>
                <div className="flex flex-wrap gap-2">
                  {allUsers.map((u) => {
                    const isMember = members.some((m) => m.id === u.id);
                    return (
                      <button
                        key={u.id}
                        onClick={() => toggleMember(u.id)}
                        className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${
                          isMember
                            ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        {isMember ? <Check className="w-3 h-3" /> : null}
                        {u.name} ({u.email})
                      </button>
                    );
                  })}
                  {allUsers.length === 0 && <p className="text-xs text-slate-500">Keine Nutzer gefunden.</p>}
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <TagIcon className="w-3.5 h-3.5" /> Tag-Berechtigungen
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 text-left">
                      <th className="py-2 font-medium">Tag</th>
                      <th className="py-2 font-medium text-center">Lesen</th>
                      <th className="py-2 font-medium text-center">Bearbeiten</th>
                      <th className="py-2 font-medium text-center">Löschen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allTags.map((tag) => {
                      const perm = permissions.find((p) => p.tag_id === tag.id);
                      return (
                        <tr key={tag.id} className="border-t border-slate-800">
                          <td className="py-2">
                            <span
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                              style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                            >
                              {tag.name}
                            </span>
                          </td>
                          {(['can_read', 'can_write', 'can_delete'] as const).map((field) => (
                            <td key={field} className="py-2 text-center">
                              <button onClick={() => togglePermission(tag, field)} className="inline-flex">
                                {perm?.[field] ? (
                                  <Check className="w-4 h-4 text-emerald-400" />
                                ) : (
                                  <X className="w-4 h-4 text-slate-600" />
                                )}
                              </button>
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    {allTags.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-4 text-center text-slate-500">
                          Keine Tags vorhanden.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
