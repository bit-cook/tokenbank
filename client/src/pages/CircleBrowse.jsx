import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { browseCircles, applyJoinCircle } from '../api/client';
import { LIB_LIST_CLS, libRowCls, LibraryRowTitle } from '../components/LibraryControls';

const AVATAR_COLORS = [
  'bg-blue-600', 'bg-violet-600', 'bg-emerald-600',
  'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
];

function circleColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** 发现公开圈子（嵌在「交易 → 圈子」里） */
export default function CircleBrowse({ onJoined }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const [query, setQuery]       = useState('');
  const [circles, setCircles]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [applying, setApplying] = useState(null); // circle id
  const [banner, setBanner]     = useState(null);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const r = await browseCircles(q);
      setCircles(r.data?.circles || []);
    } catch {
      setCircles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleSearch(e) {
    e.preventDefault();
    load(query.trim());
  }

  async function handleApply(circle) {
    if (circle.join_status === 'member' || circle.join_status === 'pending' || circle.full) return;
    setApplying(circle.id);
    try {
      const r = await applyJoinCircle(circle.id);
      const d = r.data;
      if (d.already_member) {
        setBanner({ type: 'info', text: t('circles.browse.alreadyMember') });
        onJoined?.();
        await load(query.trim());
      } else if (d.pending) {
        setBanner({ type: 'success', text: t('circles.browse.applySent').replace('{name}', circle.name) });
        setCircles(prev => prev.map(c => (
          c.id === circle.id ? { ...c, join_status: 'pending' } : c
        )));
      }
    } catch (err) {
      setBanner({
        type: 'warning',
        text: err?.response?.data?.detail || t('circles.browse.applyFailed'),
      });
    } finally {
      setApplying(null);
    }
  }

  // 输入即搜（防抖），不必再点「搜索」
  useEffect(() => {
    const id = setTimeout(() => load(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query, load]);

  function renderAction(c) {
    const isMember = c.join_status === 'member';
    if (isMember) {
      return (
        <button type="button" onClick={() => navigate(`/circles/${c.id}`)}
          className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800">
          {t('circles.browse.view')}
        </button>
      );
    }
    if (c.join_status === 'pending') {
      return <span className="text-[11px] text-zinc-400">{t('circles.browse.pending')}</span>;
    }
    if (c.full) return <span className="text-[11px] text-zinc-400">{t('circles.browse.full')}</span>;
    return (
      <button type="button" onClick={() => handleApply(c)} disabled={applying === c.id}
        className="tb-press whitespace-nowrap text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
        {applying === c.id ? t('circles.browse.applying') : t('circles.browse.apply')}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleSearch} className="relative w-72 max-w-full">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" aria-hidden>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
        </span>
        <input
          className="tb-soft-field w-full text-xs pl-8 pr-3 py-1.5 rounded-lg text-zinc-900 dark:text-zinc-100"
          placeholder={t('circles.browse.searchPh')}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </form>

      {banner && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-xs
          ${banner.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
            banner.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
            'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'}`}>
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="ml-3 opacity-60 hover:opacity-100 text-base leading-none">×</button>
        </div>
      )}

      {loading && circles.length === 0 ? (
        <p className="text-xs text-zinc-400 px-1">{t('circles.browse.loading')}</p>
      ) : circles.length === 0 ? (
        <div className={`${LIB_LIST_CLS} px-4 py-10 text-center text-xs text-zinc-400`}>{t('circles.browse.empty')}</div>
      ) : (
        <ul className={LIB_LIST_CLS}>
          {circles.map(c => {
            const isMember = c.join_status === 'member';
            return (
              <li
                key={c.id}
                onClick={() => { if (isMember) navigate(`/circles/${c.id}`); }}
                className={`${libRowCls(false)} ${isMember ? '' : '!cursor-default'} grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7.5rem_auto]`}
              >
                <LibraryRowTitle
                  logo={(
                    <div className={`w-9 h-9 rounded-xl ${circleColor(c.name)} flex items-center justify-center text-sm font-semibold text-white shrink-0`} aria-hidden>
                      {(c.name || '?')[0].toUpperCase()}
                    </div>
                  )}
                  name={c.name}
                  chips={isMember ? (
                    <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">{t('circles.joinedBadge')}</span>
                  ) : null}
                  sub={c.description || t('circles.noDesc')}
                />
                <div className="hidden md:block text-[11px] tabular-nums whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                  {c.max_members
                    ? t('circles.memberSlots', { current: c.member_count ?? 0, max: c.max_members })
                    : t('circles.members', { n: c.member_count ?? 0 })}
                </div>
                <div className="flex justify-end" onClick={e => e.stopPropagation()}>{renderAction(c)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
