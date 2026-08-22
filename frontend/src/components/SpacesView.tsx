import React, { useEffect, useMemo, useState } from 'react';
import {
  Users,
  FolderLock,
  Lock,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Plus,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  EyeOff,
  UserPlus,
  UserMinus,
  Clock,
  FileText,
  KeyRound,
  Ban,
  HeartHandshake,
} from 'lucide-react';
import {
  DirectoryUser,
  EmergencyRequest,
  EmergencyStatus,
  Space,
  SpaceDetail,
  SpaceKind,
  User,
} from '../types';
import {
  addSpaceMember,
  addTrustedContact,
  createSpace,
  decideEmergencyRequest,
  deleteSpace,
  fetchEmergencyRequests,
  fetchHouseholdDirectory,
  fetchSpaceDetail,
  fetchSpaces,
  removeSpaceMember,
  removeTrustedContact,
  requestEmergencyAccess,
} from '../services/api';

interface SpacesViewProps {
  user: User;
}

const FIELD_CLASS =
  'w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 ' +
  'rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500';

const KIND_LABELS: Record<SpaceKind, string> = {
  private: 'Privater Bereich',
  shared: 'Gemeinsamer Bereich',
};

const STATUS_LABELS: Record<EmergencyStatus, string> = {
  pending: 'Wartet auf Zweitfreigabe',
  approved: 'Genehmigt',
  denied: 'Abgelehnt',
  revoked: 'Widerrufen',
};

const STATUS_STYLES: Record<EmergencyStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  approved: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  denied: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  revoked: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
};

/**
 * German copy for the `reason` codes the space and emergency-access services
 * return; anything unmapped falls back to the server's own `error` string.
 */
const REASON_LABELS: Record<string, string> = {
  not_found: 'Nicht gefunden.',
  forbidden: 'Zugriff verweigert.',
  invalid_kind: 'Unbekannte Bereichsart.',
  invalid_name: 'Der Name muss zwischen 1 und 255 Zeichen lang sein.',
  duplicate_name: 'Ein Bereich mit diesem Namen existiert bereits.',
  unknown_user: 'Benutzer nicht gefunden.',
  space_not_empty: 'Der Bereich enthält noch Dokumente — bitte zuerst verschieben oder löschen.',
  private_space_is_single_member:
    'Ein privater Bereich hat genau ein Mitglied. Für geteilte Inhalte einen gemeinsamen Bereich anlegen.',
  owner_membership_is_permanent: 'Der Eigentümer kann nicht entfernt werden.',
  trusted_contacts_are_private_only:
    'Vertrauenspersonen gibt es nur für private Bereiche — ein gemeinsamer Bereich wird über Mitglieder geöffnet.',
  invalid_reason: 'Bitte eine Begründung mit mindestens 10 Zeichen angeben.',
  invalid_duration: 'Die gewünschte Dauer liegt außerhalb des erlaubten Bereichs.',
  shared_space: 'Ein gemeinsamer Bereich wird über Mitglieder geöffnet, nicht über einen Notfallzugriff.',
  not_trusted_contact: 'Nur eine benannte Vertrauensperson kann Notfallzugriff anfordern.',
  owner_has_access: 'Dieser Bereich gehört dir bereits.',
  already_pending: 'Für diesen Bereich ist bereits eine Anfrage offen.',
  not_pending: 'Diese Anfrage wurde bereits entschieden.',
  not_active: 'Nur eine genehmigte Freigabe kann widerrufen werden.',
  self_approval: 'Vier-Augen-Prinzip: Die eigene Anfrage darf nicht selbst genehmigt werden.',
};

/** Maps an axios failure onto a German message; never swallows it into demo data. */
function describeError(err: any, fallback: string): string {
  const status = err?.response?.status;
  const data = err?.response?.data || {};
  if (status === 401) return 'Nicht angemeldet.';
  if (data.reason && REASON_LABELS[data.reason]) return REASON_LABELS[data.reason];
  if (typeof data.error === 'string' && data.error.length > 0) return data.error;
  if (status === 403) return 'Zugriff verweigert.';
  if (status === 404) return 'Nicht gefunden.';
  return fallback;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('de-DE');
}

/** Live countdown to the automatic expiry of an approved grant. */
function countdownLabel(expiresAt: string | null, now: number): string {
  if (!expiresAt) return 'Ohne Ablauf';
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return expiresAt;
  const remaining = target - now;
  if (remaining <= 0) return 'Abgelaufen';
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `Läuft ab in ${hours} h ${minutes} min`;
  if (minutes > 0) return `Läuft ab in ${minutes} min ${seconds} s`;
  return `Läuft ab in ${seconds} s`;
}

function displayName(entry: { name: string | null; email: string | null; user_id: string }): string {
  return entry.name || entry.email || entry.user_id;
}

/**
 * Familienbereiche (Ticket #34). Two kinds of space, and the difference is
 * the whole point:
 *
 * - **privat** — exactly one member, the owner. Admins may see that the space
 *   exists (name, owner, counts) but get `accessible: false` and never read
 *   the documents. Getting in requires the two-person emergency unlock below.
 * - **gemeinsam** — household content with explicit members, administered by
 *   the owner and by admins.
 *
 * Every guard shown here is enforced server-side; this page is the
 * configuration surface. Like TrashView it never falls back to demo data —
 * a failed request renders a visible error, otherwise a broken backend would
 * look like "you simply have no spaces".
 */
export const SpacesView: React.FC<SpacesViewProps> = ({ user }) => {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SpaceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<SpaceKind>('private');

  const [memberUserId, setMemberUserId] = useState('');
  const [memberCanWrite, setMemberCanWrite] = useState(true);
  const [memberCanDelete, setMemberCanDelete] = useState(false);
  const [contactUserId, setContactUserId] = useState('');

  const [requests, setRequests] = useState<EmergencyRequest[]>([]);
  const [maxHours, setMaxHours] = useState(72);
  const [defaultHours, setDefaultHours] = useState(24);
  const [emergencyError, setEmergencyError] = useState<string | null>(null);
  const [emergencyLoading, setEmergencyLoading] = useState(true);
  const [requestSpaceId, setRequestSpaceId] = useState('');
  const [requestReason, setRequestReason] = useState('');
  // null = "untouched", so the form follows the server's defaultHours until
  // the user picks a duration of their own.
  const [requestHours, setRequestHours] = useState<number | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const isAdmin = user.role === 'admin';
  const effectiveHours = requestHours ?? defaultHours;

  const loadSpaces = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSpaces();
      setSpaces(data || []);
    } catch (err: any) {
      setSpaces([]);
      setError(
        describeError(err, 'Familienbereiche konnten nicht geladen werden. Backend nicht erreichbar?')
      );
      console.error('Failed to load spaces:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadEmergency = async () => {
    setEmergencyLoading(true);
    setEmergencyError(null);
    try {
      const data = await fetchEmergencyRequests();
      setRequests(data.requests || []);
      setMaxHours(data.maxHours ?? 72);
      setDefaultHours(data.defaultHours ?? 24);
    } catch (err: any) {
      setRequests([]);
      setEmergencyError(describeError(err, 'Notfallzugriffe konnten nicht geladen werden.'));
      console.error('Failed to load emergency access requests:', err);
    } finally {
      setEmergencyLoading(false);
    }
  };

  // The household directory feeds both pickers and is open to every role, so
  // a private-space owner can nominate a trusted contact without an admin. A
  // failure here is shown, never papered over with a blank picker.
  const loadDirectory = async () => {
    try {
      const data = await fetchHouseholdDirectory();
      setUsers(data || []);
      setUsersError(null);
    } catch (err: any) {
      setUsers([]);
      setUsersError(describeError(err, 'Verzeichnis der Haushaltsmitglieder nicht verfügbar.'));
      console.error('Failed to load the household directory:', err);
    }
  };

  const loadDetail = async (spaceId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await fetchSpaceDetail(spaceId));
    } catch (err: any) {
      setDetail(null);
      setDetailError(describeError(err, 'Bereich konnte nicht geladen werden.'));
      console.error('Failed to load space detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadSpaces();
    loadEmergency();
    loadDirectory();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setMemberUserId('');
    setContactUserId('');
    loadDetail(selectedId);
  }, [selectedId]);

  const hasLiveGrant = requests.some((request) => request.status === 'approved' && request.expires_at);

  useEffect(() => {
    if (!hasLiveGrant) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveGrant]);

  const refreshAll = async () => {
    await Promise.all([loadSpaces(), loadEmergency(), loadDirectory()]);
    if (selectedId) await loadDetail(selectedId);
  };

  /** Spaces this user may unlock: nominated as a trusted contact, but locked out today. */
  const unlockableSpaces = useMemo(
    () => spaces.filter((space) => space.trusted_contact && !space.accessible),
    [spaces]
  );

  useEffect(() => {
    if (unlockableSpaces.length > 0 && !unlockableSpaces.some((space) => space.id === requestSpaceId)) {
      setRequestSpaceId(unlockableSpaces[0].id);
    }
  }, [unlockableSpaces, requestSpaceId]);

  const canAdminister = (space: Space): boolean =>
    space.owner_id === user.id || (space.kind === 'shared' && isAdmin);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      const space = await createSpace(newName.trim(), newKind);
      setNotice(`Bereich „${space.name}“ wurde angelegt.`);
      setNewName('');
      setSelectedId(space.id);
      await loadSpaces();
    } catch (err: any) {
      setError(describeError(err, 'Bereich konnte nicht angelegt werden.'));
      console.error('Failed to create space:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteSpace = async (space: SpaceDetail) => {
    const confirmed = window.confirm(
      `Bereich „${space.name}“ löschen?\n\n` +
        'Das ist nur möglich, solange keine Dokumente mehr darin liegen.'
    );
    if (!confirmed) return;
    setBusy(`space:${space.id}`);
    setError(null);
    setNotice(null);
    try {
      await deleteSpace(space.id);
      setNotice(`Bereich „${space.name}“ wurde gelöscht.`);
      setSelectedId(null);
      await loadSpaces();
    } catch (err: any) {
      setError(describeError(err, 'Bereich konnte nicht gelöscht werden.'));
      console.error('Failed to delete space:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleAddMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    const userId = memberUserId.trim();
    if (!userId) {
      setError('Bitte eine Person auswählen.');
      return;
    }
    setBusy(`member:${userId}`);
    setError(null);
    setNotice(null);
    try {
      await addSpaceMember(detail.id, userId, {
        canWrite: memberCanWrite,
        canDelete: memberCanDelete,
      });
      setNotice('Mitglied wurde hinzugefügt.');
      setMemberUserId('');
      await Promise.all([loadDetail(detail.id), loadSpaces()]);
    } catch (err: any) {
      setError(describeError(err, 'Mitglied konnte nicht hinzugefügt werden.'));
      console.error('Failed to add space member:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveMember = async (spaceId: string, member: { user_id: string; name: string | null; email: string | null }) => {
    if (!window.confirm(`„${displayName(member)}“ aus dem Bereich entfernen?`)) return;
    setBusy(`member:${member.user_id}`);
    setError(null);
    setNotice(null);
    try {
      await removeSpaceMember(spaceId, member.user_id);
      setNotice('Mitglied wurde entfernt.');
      await Promise.all([loadDetail(spaceId), loadSpaces()]);
    } catch (err: any) {
      setError(describeError(err, 'Mitglied konnte nicht entfernt werden.'));
      console.error('Failed to remove space member:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleAddContact = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    const userId = contactUserId.trim();
    if (!userId) {
      setError('Bitte eine Person auswählen.');
      return;
    }
    setBusy(`contact:${userId}`);
    setError(null);
    setNotice(null);
    try {
      await addTrustedContact(detail.id, userId);
      setNotice('Vertrauensperson wurde benannt. Sie erhält dadurch noch keinen Zugriff.');
      setContactUserId('');
      await loadDetail(detail.id);
    } catch (err: any) {
      setError(describeError(err, 'Vertrauensperson konnte nicht benannt werden.'));
      console.error('Failed to add trusted contact:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveContact = async (spaceId: string, contact: { user_id: string; name: string | null; email: string | null }) => {
    if (!window.confirm(`Benennung von „${displayName(contact)}“ als Vertrauensperson zurücknehmen?`)) return;
    setBusy(`contact:${contact.user_id}`);
    setError(null);
    setNotice(null);
    try {
      await removeTrustedContact(spaceId, contact.user_id);
      setNotice('Vertrauensperson wurde entfernt.');
      await loadDetail(spaceId);
    } catch (err: any) {
      setError(describeError(err, 'Vertrauensperson konnte nicht entfernt werden.'));
      console.error('Failed to remove trusted contact:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleRequestEmergency = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!requestSpaceId) return;
    setBusy('emergency-request');
    setEmergencyError(null);
    setNotice(null);
    try {
      await requestEmergencyAccess(requestSpaceId, requestReason.trim(), effectiveHours);
      setNotice(
        'Notfallzugriff angefordert. Eine zweite Vertrauensperson oder der Eigentümer muss die Anfrage genehmigen.'
      );
      setRequestReason('');
      await loadEmergency();
    } catch (err: any) {
      setEmergencyError(describeError(err, 'Notfallzugriff konnte nicht angefordert werden.'));
      console.error('Failed to request emergency access:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleDecide = async (request: EmergencyRequest, decision: 'approve' | 'deny' | 'revoke') => {
    if (decision === 'revoke' && !window.confirm(`Freigabe für „${request.space_name}“ jetzt beenden?`)) {
      return;
    }
    setBusy(`request:${request.id}`);
    setEmergencyError(null);
    setNotice(null);
    try {
      const updated = await decideEmergencyRequest(request.id, decision);
      const label =
        decision === 'approve'
          ? `Notfallzugriff auf „${request.space_name}“ genehmigt — lesend, bis ${formatDateTime(updated.expires_at)}.`
          : decision === 'deny'
          ? `Notfallzugriff auf „${request.space_name}“ abgelehnt.`
          : `Freigabe für „${request.space_name}“ wurde widerrufen.`;
      setNotice(label);
      await loadEmergency();
    } catch (err: any) {
      setEmergencyError(describeError(err, 'Die Entscheidung konnte nicht gespeichert werden.'));
      console.error('Failed to decide emergency request:', err);
    } finally {
      setBusy(null);
    }
  };

  const renderUserPicker = (
    value: string,
    onChange: (next: string) => void,
    placeholder: string,
    excludedIds: string[]
  ) => {
    if (usersError) {
      return (
        <p className="text-[11px] text-rose-200 bg-rose-950/40 border border-rose-500/30 rounded-xl px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>Verzeichnis konnte nicht geladen werden: {usersError}</span>
        </p>
      );
    }
    const options = users.filter((candidate) => !excludedIds.includes(candidate.id));
    if (options.length === 0) {
      return <p className="text-[11px] text-slate-500">Keine weitere Person im Haushalt verfügbar.</p>;
    }
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} className={FIELD_CLASS}>
        <option value="">{placeholder}</option>
        {options.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name} ({candidate.email})
          </option>
        ))}
      </select>
    );
  };

  const renderRequestCard = (request: EmergencyRequest) => {
    const mine = request.requested_by === user.id;
    const mayRevoke =
      request.status === 'approved' &&
      (request.space_owner_id === user.id || request.approved_by === user.id || mine);
    const requestBusy = busy === `request:${request.id}`;

    return (
      <div key={request.id} className="glass-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-semibold text-slate-100 text-sm truncate">{request.space_name}</h4>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border flex items-center gap-1 ${
                  STATUS_STYLES[request.status]
                }`}
              >
                <ShieldAlert className="w-3 h-3" />
                {STATUS_LABELS[request.status]}
              </span>
              {request.active && (
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-emerald-500/10 text-emerald-300 border-emerald-500/30 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {countdownLabel(request.expires_at, now)}
                </span>
              )}
              {request.status === 'approved' && !request.active && (
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-slate-500/10 text-slate-300 border-slate-500/30 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Abgelaufen
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {mine ? 'Von dir angefordert' : `Angefordert von ${request.requested_by_name || request.requested_by}`}
              {' · '}
              {formatDateTime(request.created_at)}
              {' · '}
              {request.requested_hours} Std. beantragt
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {request.can_decide && (
              <>
                <button
                  onClick={() => handleDecide(request, 'approve')}
                  disabled={requestBusy}
                  className="btn-secondary text-[11px] py-1.5 px-3 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50"
                >
                  {requestBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                  Genehmigen
                </button>
                <button
                  onClick={() => handleDecide(request, 'deny')}
                  disabled={requestBusy}
                  className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                >
                  <ShieldX className="w-3 h-3" />
                  Ablehnen
                </button>
              </>
            )}
            {mayRevoke && (
              <button
                onClick={() => handleDecide(request, 'revoke')}
                disabled={requestBusy}
                className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
              >
                {requestBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                Freigabe beenden
              </button>
            )}
          </div>
        </div>

        <p className="text-xs text-slate-300 bg-slate-900/60 border border-slate-800 rounded-xl px-3 py-2 italic">
          „{request.reason}“
        </p>

        <div className="flex items-center gap-4 flex-wrap text-[11px] text-slate-500">
          {request.decided_at && (
            <span>
              Entschieden am {formatDateTime(request.decided_at)}
              {request.approved_by_name ? ` von ${request.approved_by_name}` : ''}
            </span>
          )}
          {request.expires_at && <span>Läuft ab am {formatDateTime(request.expires_at)}</span>}
          <span>
            {request.use_count} Zugriff(e) protokolliert
            {request.last_used_at ? `, zuletzt ${formatDateTime(request.last_used_at)}` : ''}
          </span>
        </div>
      </div>
    );
  };

  const pendingDecisions = requests.filter((request) => request.can_decide);
  const myRequests = requests.filter((request) => request.requested_by === user.id);
  const otherRequests = requests.filter(
    (request) => !request.can_decide && request.requested_by !== user.id
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />
            Familienbereiche
          </h1>
          <p className="text-xs text-slate-400">
            Private Bereiche gehören genau einer Person — auch Administratoren lesen sie nicht. Gemeinsame
            Bereiche gehören dem Haushalt. Dokumente ohne Bereich bleiben im gemeinsamen Ablagebereich.
          </p>
        </div>

        <button onClick={refreshAll} disabled={loading} className="btn-secondary text-xs py-2 px-3">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Aktualisieren
        </button>
      </div>

      {error && (
        <div className="glass-panel border border-rose-500/30 bg-rose-950/40 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="glass-panel border border-emerald-500/30 bg-emerald-950/30 text-emerald-200 px-4 py-3 rounded-xl text-xs">
          {notice}
        </div>
      )}

      {loading && spaces.length === 0 && !error && (
        <div className="glass-panel p-8 text-center text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
          Lade Familienbereiche…
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left column — create form and the list of spaces */}
        <div className="space-y-4">
          <form onSubmit={handleCreate} className="glass-panel p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Plus className="w-4 h-4 text-indigo-400" />
              Neuen Bereich anlegen
            </h2>
            <input
              type="text"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Name, z. B. „Unterlagen Anna“"
              className={FIELD_CLASS}
            />
            <select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value as SpaceKind)}
              className={FIELD_CLASS}
            >
              <option value="private">Privater Bereich (nur für mich)</option>
              {isAdmin && <option value="shared">Gemeinsamer Bereich (Haushalt)</option>}
            </select>
            {!isAdmin && (
              <p className="text-[11px] text-slate-500">
                Gemeinsame Bereiche legt eine Administratorin oder ein Administrator an.
              </p>
            )}
            <button
              type="submit"
              disabled={busy === 'create' || !newName.trim()}
              className="btn-primary text-xs py-2 px-3 disabled:opacity-50"
            >
              {busy === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Bereich anlegen
            </button>
          </form>

          {!loading && !error && spaces.length === 0 && (
            <div className="glass-panel p-6 sm:p-12 text-center space-y-4">
              <FolderLock className="w-12 h-12 text-slate-600 mx-auto" />
              <h3 className="text-lg font-semibold text-slate-300">Noch keine Bereiche</h3>
              <p className="text-slate-500 text-sm max-w-md mx-auto">
                Lege einen privaten Bereich an, damit deine persönlichen Unterlagen nur dir gehören.
              </p>
            </div>
          )}

          {spaces.map((space) => {
            const selected = space.id === selectedId;
            return (
              <button
                key={space.id}
                type="button"
                onClick={() => setSelectedId(space.id)}
                className={`glass-card p-4 w-full text-left space-y-2 ${
                  selected ? 'border-indigo-500/50' : ''
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {space.kind === 'private' ? (
                    <Lock className="w-4 h-4 text-amber-300 shrink-0" />
                  ) : (
                    <Users className="w-4 h-4 text-indigo-300 shrink-0" />
                  )}
                  <h4 className="font-semibold text-slate-100 text-sm truncate">{space.name}</h4>
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                      space.kind === 'private'
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                    }`}
                  >
                    {KIND_LABELS[space.kind]}
                  </span>
                  {!space.accessible && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-rose-500/10 text-rose-300 border-rose-500/30 flex items-center gap-1">
                      <EyeOff className="w-3 h-3" />
                      Kein Zugriff
                    </span>
                  )}
                  {space.trusted_contact && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-sky-500/10 text-sky-300 border-sky-500/30 flex items-center gap-1">
                      <HeartHandshake className="w-3 h-3" />
                      Vertrauensperson
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 flex-wrap text-[12px] text-slate-400">
                  <span className="truncate">Eigentümer: {space.owner_name || space.owner_id}</span>
                  <span className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-slate-500" />
                    {space.member_count} Mitglied(er)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-500" />
                    {space.document_count} Dokument(e)
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right column — detail of the selected space */}
        <div className="space-y-4">
          {!selectedId && (
            <div className="glass-panel p-6 sm:p-12 text-center space-y-4">
              <FolderLock className="w-12 h-12 text-slate-600 mx-auto" />
              <h3 className="text-lg font-semibold text-slate-300">Bereich auswählen</h3>
              <p className="text-slate-500 text-sm max-w-md mx-auto">
                Wähle links einen Bereich, um Mitglieder, Vertrauenspersonen und Berechtigungen zu sehen.
              </p>
            </div>
          )}

          {detailLoading && (
            <div className="glass-panel p-8 text-center text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              Lade Bereich…
            </div>
          )}

          {detailError && (
            <div className="glass-panel border border-rose-500/30 bg-rose-950/40 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{detailError}</span>
            </div>
          )}

          {detail && !detailLoading && !detailError && (
            <div className="glass-panel p-4 space-y-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    {detail.kind === 'private' ? (
                      <Lock className="w-4 h-4 text-amber-300" />
                    ) : (
                      <Users className="w-4 h-4 text-indigo-300" />
                    )}
                    <span className="truncate">{detail.name}</span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    {KIND_LABELS[detail.kind]} · Eigentümer: {detail.owner_name || detail.owner_id} · angelegt am{' '}
                    {formatDateTime(detail.created_at)}
                  </p>
                </div>
                {canAdminister(detail) && (
                  <button
                    onClick={() => handleDeleteSpace(detail)}
                    disabled={busy === `space:${detail.id}`}
                    className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                  >
                    {busy === `space:${detail.id}` ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                    Bereich löschen
                  </button>
                )}
              </div>

              {!detail.accessible && (
                <div className="text-xs text-rose-200 bg-rose-950/40 border border-rose-500/30 rounded-xl px-3 py-2 flex items-start gap-2">
                  <EyeOff className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Kein Zugriff auf die {detail.document_count} Dokument(e) in diesem Bereich. Du siehst nur, dass
                    es ihn gibt — der Inhalt bleibt privat.
                  </span>
                </div>
              )}

              {/* Members */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Users className="w-4 h-4 text-indigo-400" />
                  Mitglieder ({detail.members.length})
                </h3>

                {detail.members.length === 0 && (
                  <p className="text-xs text-slate-500">Keine Mitglieder eingetragen.</p>
                )}

                {detail.members.map((member) => (
                  <div
                    key={member.user_id}
                    className="glass-card p-3 flex items-center justify-between gap-3 flex-wrap"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-slate-100 font-medium truncate">{displayName(member)}</span>
                        {member.user_id === detail.owner_id && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-indigo-500/10 text-indigo-300 border-indigo-500/30">
                            Eigentümer
                          </span>
                        )}
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                            member.can_write
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                              : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                          }`}
                        >
                          {member.can_write ? 'Schreiben' : 'Nur lesen'}
                        </span>
                        {member.can_delete && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-amber-500/10 text-amber-300 border-amber-500/30">
                            Löschen
                          </span>
                        )}
                      </div>
                      {member.email && <p className="text-[11px] text-slate-500 truncate">{member.email}</p>}
                    </div>

                    {detail.kind === 'shared' && canAdminister(detail) && member.user_id !== detail.owner_id && (
                      <button
                        onClick={() => handleRemoveMember(detail.id, member)}
                        disabled={busy === `member:${member.user_id}`}
                        className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                      >
                        {busy === `member:${member.user_id}` ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <UserMinus className="w-3 h-3" />
                        )}
                        Entfernen
                      </button>
                    )}
                  </div>
                ))}

                {detail.kind === 'private' && (
                  <p className="text-[11px] text-slate-500">
                    Ein privater Bereich hat genau ein Mitglied. Für gemeinsame Unterlagen einen gemeinsamen
                    Bereich anlegen.
                  </p>
                )}

                {detail.kind === 'shared' && canAdminister(detail) && (
                  <form onSubmit={handleAddMember} className="space-y-2 border-t border-slate-800 pt-3">
                    <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      <UserPlus className="w-3.5 h-3.5 text-indigo-400" />
                      Mitglied hinzufügen
                    </label>
                    {renderUserPicker(
                      memberUserId,
                      setMemberUserId,
                      'Person auswählen…',
                      detail.members.map((member) => member.user_id)
                    )}
                    <div className="flex items-center gap-4 text-[11px] text-slate-400">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={memberCanWrite}
                          onChange={(event) => setMemberCanWrite(event.target.checked)}
                        />
                        Schreiben erlaubt
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={memberCanDelete}
                          onChange={(event) => setMemberCanDelete(event.target.checked)}
                        />
                        Löschen erlaubt
                      </label>
                    </div>
                    <button
                      type="submit"
                      disabled={!memberUserId.trim() || busy === `member:${memberUserId.trim()}`}
                      className="btn-secondary text-[11px] py-1.5 px-3 disabled:opacity-50"
                    >
                      <UserPlus className="w-3 h-3" />
                      Hinzufügen
                    </button>
                  </form>
                )}
              </div>

              {/* Trusted contacts — private spaces only */}
              {detail.kind === 'private' && (
                <div className="space-y-3 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                    <HeartHandshake className="w-4 h-4 text-sky-400" />
                    Vertrauenspersonen ({detail.trusted_contacts.length})
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Eine Benennung gibt für sich genommen keinen Zugriff. Sie ermöglicht nur, im Notfall einen
                    Zugriff zu beantragen — den eine zweite Person genehmigen muss.
                  </p>

                  {detail.trusted_contacts.length === 0 && (
                    <p className="text-xs text-slate-500">Noch niemand benannt.</p>
                  )}

                  {detail.trusted_contacts.map((contact) => (
                    <div
                      key={contact.user_id}
                      className="glass-card p-3 flex items-center justify-between gap-3 flex-wrap"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-slate-100 font-medium truncate">{displayName(contact)}</p>
                        {contact.email && <p className="text-[11px] text-slate-500 truncate">{contact.email}</p>}
                      </div>
                      {detail.owner_id === user.id && (
                        <button
                          onClick={() => handleRemoveContact(detail.id, contact)}
                          disabled={busy === `contact:${contact.user_id}`}
                          className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                        >
                          {busy === `contact:${contact.user_id}` ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <UserMinus className="w-3 h-3" />
                          )}
                          Entfernen
                        </button>
                      )}
                    </div>
                  ))}

                  {detail.owner_id === user.id && (
                    <form onSubmit={handleAddContact} className="space-y-2">
                      <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                        <UserPlus className="w-3.5 h-3.5 text-sky-400" />
                        Vertrauensperson benennen
                      </label>
                      {renderUserPicker(contactUserId, setContactUserId, 'Person auswählen…', [
                        detail.owner_id,
                        ...detail.trusted_contacts.map((contact) => contact.user_id),
                      ])}
                      <button
                        type="submit"
                        disabled={!contactUserId.trim() || busy === `contact:${contactUserId.trim()}`}
                        className="btn-secondary text-[11px] py-1.5 px-3 disabled:opacity-50"
                      >
                        <UserPlus className="w-3 h-3" />
                        Benennen
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Emergency access — the two-person unlock of a private space */}
      <div className="glass-panel p-4 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-amber-400" />
            Notfallzugriff
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Ein privater Bereich lässt sich im Notfall nur nach dem Vier-Augen-Prinzip öffnen: Eine benannte
            Vertrauensperson stellt die Anfrage, <strong className="text-slate-200">eine zweite Person</strong>{' '}
            (der Eigentümer oder eine weitere Vertrauensperson) muss sie genehmigen. Die Freigabe ist{' '}
            <strong className="text-slate-200">ausschließlich lesend</strong>, sie{' '}
            <strong className="text-slate-200">läuft automatisch ab</strong> (maximal {maxHours} Stunden,
            Standard {defaultHours}) und kann jederzeit vorzeitig beendet werden. Jeder einzelne Zugriff wird
            im Audit-Log protokolliert.
          </p>
        </div>

        {emergencyError && (
          <div className="glass-panel border border-rose-500/30 bg-rose-950/40 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{emergencyError}</span>
          </div>
        )}

        {emergencyLoading && requests.length === 0 && !emergencyError && (
          <div className="text-xs text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
            Lade Notfallzugriffe…
          </div>
        )}

        {unlockableSpaces.length > 0 && (
          <form onSubmit={handleRequestEmergency} className="glass-card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Notfallzugriff anfordern
            </h3>
            <select
              value={requestSpaceId}
              onChange={(event) => setRequestSpaceId(event.target.value)}
              className={FIELD_CLASS}
            >
              {unlockableSpaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name} ({space.owner_name || space.owner_id})
                </option>
              ))}
            </select>
            <div className="space-y-1">
              <textarea
                value={requestReason}
                onChange={(event) => setRequestReason(event.target.value)}
                rows={3}
                placeholder="Begründung — der Eigentümer liest sie später (mindestens 10 Zeichen)"
                className={`${FIELD_CLASS} resize-y`}
              />
              <p className="text-[11px] text-slate-500">{requestReason.trim().length}/10 Zeichen Minimum</p>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-slate-400">Dauer in Stunden (1 – {maxHours})</label>
              <input
                type="number"
                min={1}
                max={maxHours}
                value={effectiveHours}
                onChange={(event) => setRequestHours(Number(event.target.value))}
                className={FIELD_CLASS}
              />
            </div>
            <button
              type="submit"
              disabled={
                busy === 'emergency-request' || requestReason.trim().length < 10 || !requestSpaceId
              }
              className="btn-primary text-xs py-2 px-3 disabled:opacity-50"
            >
              {busy === 'emergency-request' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <KeyRound className="w-3.5 h-3.5" />
              )}
              Notfallzugriff anfordern
            </button>
          </form>
        )}

        {pendingDecisions.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-400" />
              Deine Entscheidung ist gefragt ({pendingDecisions.length})
            </h3>
            {pendingDecisions.map(renderRequestCard)}
          </div>
        )}

        {myRequests.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-indigo-400" />
              Meine Anfragen ({myRequests.length})
            </h3>
            {myRequests.map(renderRequestCard)}
          </div>
        )}

        {otherRequests.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              Weitere Vorgänge ({otherRequests.length})
            </h3>
            {otherRequests.map(renderRequestCard)}
          </div>
        )}

        {!emergencyLoading && !emergencyError && requests.length === 0 && (
          <p className="text-xs text-slate-500">
            Keine Notfallzugriffe. Solange niemand eine Anfrage stellt, bleibt jeder private Bereich
            ausschließlich seinem Eigentümer vorbehalten.
          </p>
        )}
      </div>
    </div>
  );
};
