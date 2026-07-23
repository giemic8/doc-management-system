import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, PieChart, Repeat, Loader2, Filter } from 'lucide-react';
import { fetchAnalyticsSummary, fetchTags } from '../services/api';
import { AnalyticsSummary, Tag } from '../types';

const VENDOR_COLORS = ['#6366f1', '#a855f7', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#14b8a6', '#8b5cf6', '#f97316'];

function formatCurrency(amount: number, currency?: string) {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ''}`;
  }
}

/** Hand-rolled SVG bar chart — no charting library dependency needed for a
 * dashboard this small (see final report for rationale). */
const MonthlyBarChart: React.FC<{ data: { month: string; total: number }[] }> = ({ data }) => {
  const width = 640;
  const height = 220;
  const paddingLeft = 48;
  const paddingBottom = 28;
  const chartWidth = width - paddingLeft - 12;
  const chartHeight = height - paddingBottom - 12;
  const maxTotal = Math.max(1, ...data.map((d) => d.total));
  const barWidth = data.length > 0 ? chartWidth / data.length : 0;

  if (data.length === 0) {
    return <p className="text-xs text-slate-500 py-8 text-center">Keine Daten für den gewählten Zeitraum.</p>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56">
      {/* Y-axis gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
        const y = 12 + chartHeight * (1 - frac);
        return (
          <line
            key={frac}
            x1={paddingLeft}
            x2={width - 12}
            y1={y}
            y2={y}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
          />
        );
      })}
      {data.map((d, i) => {
        const barHeight = (d.total / maxTotal) * chartHeight;
        const x = paddingLeft + i * barWidth + barWidth * 0.15;
        const y = 12 + chartHeight - barHeight;
        return (
          <g key={d.month}>
            <rect
              x={x}
              y={y}
              width={barWidth * 0.7}
              height={Math.max(barHeight, 1)}
              rx={4}
              fill="url(#analyticsBarGradient)"
            >
              <title>{`${d.month}: ${formatCurrency(d.total)}`}</title>
            </rect>
            <text
              x={x + (barWidth * 0.7) / 2}
              y={height - paddingBottom + 16}
              textAnchor="middle"
              fontSize="9"
              fill="#94a3b8"
            >
              {d.month.slice(2)}
            </text>
          </g>
        );
      })}
      <defs>
        <linearGradient id="analyticsBarGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Hand-rolled SVG pie chart of vendor spend share. */
const VendorPieChart: React.FC<{ data: { sender: string; total: number }[] }> = ({ data }) => {
  const size = 200;
  const radius = size / 2;
  const cx = radius;
  const cy = radius;
  const total = data.reduce((sum, d) => sum + d.total, 0);

  if (data.length === 0 || total === 0) {
    return <p className="text-xs text-slate-500 py-8 text-center">Keine Daten für den gewählten Zeitraum.</p>;
  }

  let cumulativeAngle = -90; // start at 12 o'clock

  const slices = data.map((d, i) => {
    const fraction = d.total / total;
    const angle = fraction * 360;
    const startAngle = cumulativeAngle;
    const endAngle = cumulativeAngle + angle;
    cumulativeAngle = endAngle;

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(toRad(startAngle));
    const y1 = cy + radius * Math.sin(toRad(startAngle));
    const x2 = cx + radius * Math.cos(toRad(endAngle));
    const y2 = cy + radius * Math.sin(toRad(endAngle));
    const largeArc = angle > 180 ? 1 : 0;

    const path =
      fraction >= 0.999
        ? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    return { path, color: VENDOR_COLORS[i % VENDOR_COLORS.length], sender: d.sender, total: d.total, fraction };
  });

  return (
    <div className="flex items-center gap-6">
      <svg viewBox={`0 0 ${size} ${size}`} className="w-40 h-40 shrink-0">
        {slices.map((s) => (
          <path key={s.sender} d={s.path} fill={s.color} stroke="#0f172a" strokeWidth={1}>
            <title>{`${s.sender}: ${formatCurrency(s.total)} (${(s.fraction * 100).toFixed(1)}%)`}</title>
          </path>
        ))}
      </svg>
      <div className="space-y-1.5 text-xs flex-1 min-w-0">
        {slices.map((s) => (
          <div key={s.sender} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-slate-300 truncate flex-1">{s.sender}</span>
            <span className="text-slate-500 font-mono shrink-0">{(s.fraction * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const AnalyticsDashboard: React.FC = () => {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [tagId, setTagId] = useState('');
  const [currency, setCurrency] = useState('');

  useEffect(() => {
    fetchTags().then(setTags).catch(() => setTags([]));
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAnalyticsSummary({
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        tagId: tagId || undefined,
        currency: currency || undefined,
      });
      setSummary(data);
    } catch (err) {
      console.error(err);
      setError('Analyse-Daten konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, tagId, currency]);

  const totalSpend = useMemo(
    () => summary?.monthlyBreakdown.reduce((sum, m) => sum + m.total, 0) ?? 0,
    [summary]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-100">Kostenanalyse</h1>
        <p className="text-xs text-slate-400">
          Monatliche Ausgabenübersicht, Top-Lieferanten und automatisch erkannte wiederkehrende Kosten.
        </p>
      </div>

      {/* Filters */}
      <div className="glass-panel p-4 flex flex-wrap items-end gap-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <Filter className="w-3.5 h-3.5" /> Filter
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400">Von</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400">Bis</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400">Tag</label>
          <select
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
          >
            <option value="">Alle Tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400">Währung</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 outline-none"
          >
            <option value="">Alle Währungen</option>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="CHF">CHF</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Monthly breakdown bar chart */}
            <section className="glass-panel p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-200 text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-indigo-400" /> Monatliche Ausgaben
                </h2>
                <span className="text-xs text-slate-400 font-mono">Gesamt: {formatCurrency(totalSpend, currency || undefined)}</span>
              </div>
              <MonthlyBarChart data={summary.monthlyBreakdown} />
            </section>

            {/* Top vendors pie chart */}
            <section className="glass-panel p-6 space-y-3">
              <h2 className="font-bold text-slate-200 text-sm flex items-center gap-2">
                <PieChart className="w-4 h-4 text-purple-400" /> Top-Lieferanten nach Ausgabenanteil
              </h2>
              <VendorPieChart data={summary.topVendors} />
            </section>
          </div>

          {/* Top vendors table */}
          <section className="glass-panel overflow-hidden border border-slate-800">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-bold text-slate-200 text-sm">Top-Lieferanten / Absender</h2>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="p-3 font-semibold">Absender</th>
                  <th className="p-3 font-semibold">Gesamtbetrag</th>
                  <th className="p-3 font-semibold">Anzahl Dokumente</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {summary.topVendors.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-6 text-center text-slate-500">
                      Keine Daten für den gewählten Zeitraum.
                    </td>
                  </tr>
                ) : (
                  summary.topVendors.map((v) => (
                    <tr key={v.sender} className="hover:bg-slate-900/40">
                      <td className="p-3 text-slate-300 font-medium">{v.sender}</td>
                      <td className="p-3 text-slate-200 font-mono">{formatCurrency(v.total, currency || undefined)}</td>
                      <td className="p-3 text-slate-400">{v.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          {/* Recurring subscriptions */}
          <section className="glass-panel p-6 space-y-3">
            <h2 className="font-bold text-slate-200 text-sm flex items-center gap-2">
              <Repeat className="w-4 h-4 text-emerald-400" /> Wiederkehrende Abonnements / Verträge
            </h2>
            {summary.recurringSubscriptions.length === 0 ? (
              <p className="text-xs text-slate-500">Keine wiederkehrenden Kosten erkannt.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {summary.recurringSubscriptions.map((r) => (
                  <div key={r.sender} className="glass-card p-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200 text-sm truncate">{r.sender}</span>
                      <span
                        className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                          r.cadence === 'monthly'
                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}
                      >
                        {r.cadence === 'monthly' ? 'Monatlich' : 'Jährlich'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Ø {formatCurrency(r.averageAmount, currency || undefined)} · {r.occurrences} Belege erkannt
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
};
