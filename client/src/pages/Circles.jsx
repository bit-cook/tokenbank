import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import {
  createCircle, listMyCircles, listJoinedCircles,
  dissolveCircle, leaveCircle, listCircleMembers,
  previewCircle, joinCircle, listCircleJoinRequests,
} from '../api/client';
import { getServerUrl } from '../config';
import UserAvatar, { userDisplayName, avatarColor } from '../components/UserAvatar';
import {
  SplitButton, LIB_LIST_CLS, LibrarySectionHead,
} from '../components/LibraryControls';
import { AssetMoreMenu } from '../components/ResourceAssetCard';
import CircleBrowse from './CircleBrowse';

/**
 * 圈子 = 交易范围：嵌在「交易 → 圈子」页签里管理我的圈子 / 发现公开圈子。
 * view / circleResult 由交易页按导航 state 传入（旧 /circles 路由与邀请链接都会落到这里）。
 */
export default function Circles({ view: viewProp = 'mine', circleResult = null, onChanged }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const [owned, setOwned]           = useState([]);
  const [joined, setJoined]         = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin]     = useState(false);
  /** 圈主：各圈待审批入圈申请数（列表上提示） */
  const [requestCounts, setRequestCounts] = useState({});
  const [name, setName]             = useState('');
  const [desc, setDesc]             = useState('');
  const [creating, setCreating]     = useState(false);
  const [error, setError]           = useState('');
  const [copiedInModal, setCopiedInModal] = useState(false);
  const [inviteModal, setInviteModal]       = useState(null); // { circle, url }
  const [joinInput, setJoinInput]   = useState('');
  const [joinPreview, setJoinPreview] = useState(null);  // { circle, already_member, full }
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError]   = useState('');
  const discoverRef = useRef(null);
  const scrollToDiscover = () => discoverRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const [joinBanner, setJoinBanner] = useState(null);
  // 从社区网络 / 旧 /circles/browse 跳来：定位到「发现公开圈子」
  useEffect(() => {
    if (viewProp === 'discover') setTimeout(scrollToDiscover, 150);
  }, [viewProp]);
  // 邀请链接登录后自动入圈的结果
  useEffect(() => {
    const r = circleResult;
    if (!r) return;
    if (r.already_member) setJoinBanner({ type: 'info', key: 'circles.alreadyMember' });
    else if (r.full) setJoinBanner({ type: 'warning', key: 'circles.fullAutoJoinFailed' });
    else if (r.ok) setJoinBanner({ type: 'success', key: 'circles.joinSuccess' });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随新的入圈结果触发
  }, [circleResult]);

  async function load() {
    setListLoading(true);
    try {
      const [o, j] = await Promise.all([listMyCircles(), listJoinedCircles()]);
      const ownedList = o.data?.circles || [];
      const ownedIds  = new Set(ownedList.map(c => c.id));
      const joinedList = (j.data?.circles || []).filter(c => !ownedIds.has(c.id));
      const allCircles = [...ownedList, ...joinedList];

      // Fetch members for all circles in parallel
      const memberMap = {};
      await Promise.all(allCircles.map(async c => {
        try {
          const r = await listCircleMembers(c.id);
          memberMap[c.id] = r.data?.members || [];
        } catch (_) {
          memberMap[c.id] = [];
        }
      }));

      setOwned(ownedList.map(c => ({ ...c, members: memberMap[c.id] || [] })));
      onChanged?.([...ownedList, ...joinedList]);
      // 待审批申请数不阻塞列表渲染
      Promise.all(ownedList.map(c => listCircleJoinRequests(c.id)
        .then(r => [c.id, (r.data?.requests || []).length])
        .catch(() => [c.id, 0])))
        .then(pairs => setRequestCounts(Object.fromEntries(pairs)));
      setJoined(joinedList.map(c => ({ ...c, members: memberMap[c.id] || [] })));
    } catch (_) {
      setOwned([]);
      setJoined([]);
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true); setError('');
    try {
      await createCircle(name.trim(), desc.trim());
      setName(''); setDesc(''); setShowCreate(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || t('circles.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleDissolve(circle) {
    if (!confirm(t('circles.dissolveConfirm').replace('{name}', circle.name))) return;
    await dissolveCircle(circle.id);
    await load();
  }

  async function handleLeave(circle) {
    if (!confirm(t('circles.leaveConfirm').replace('{name}', circle.name))) return;
    await leaveCircle(circle.id);
    await load();
  }

  function extractCode(input) {
    const s = input.trim();
    // support full URL like http://host/app?c=XXXX or just the code
    try { return new URL(s).searchParams.get('c') || s; } catch { return s; }
  }

  async function handleJoinPreview(e) {
    e.preventDefault();
    const code = extractCode(joinInput);
    if (!code) return;
    setJoinLoading(true); setJoinError(''); setJoinPreview(null);
    try {
      const r = await previewCircle(code);
      setJoinPreview({ ...r.data, code });  // opens modal
    } catch (err) {
      setJoinError(err?.response?.data?.detail || t('circles.inviteInvalid'));
      setTimeout(() => setJoinError(''), 3000);
    } finally {
      setJoinLoading(false);
    }
  }

  async function handleJoinConfirm() {
    if (!joinPreview) return;
    setJoinLoading(true); setJoinError('');
    try {
      const r = await joinCircle(joinPreview.code);
      const d = r.data;
      if (d.already_member) {
        setJoinBanner({ type: 'info', key: 'circles.alreadyMember' });
      } else if (d.full) {
        setJoinBanner({ type: 'warning', key: 'circles.fullCannotJoin' });
      } else {
        setJoinBanner({ type: 'success', key: 'circles.joinSuccessNamed', params: { name: joinPreview.circle.name } });
      }
      setJoinInput(''); setJoinPreview(null); setShowJoin(false);
      await load();
    } catch (err) {
      setJoinError(err?.response?.data?.detail || t('circles.joinFailed'));
    } finally {
      setJoinLoading(false);
    }
  }

  function buildInviteUrl(circle) {
    const base = getServerUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}/app?c=${circle.code}`;
  }

  function openInvite(circle) {
    setCopiedInModal(false);
    setInviteModal({ circle, url: buildInviteUrl(circle) });
  }

  function copyInviteFromModal() {
    if (!inviteModal?.url) return;
    navigator.clipboard.writeText(inviteModal.url).then(() => {
      setCopiedInModal(true);
      setTimeout(() => setCopiedInModal(false), 2000);
    });
  }

  const all = [
    ...owned.map(c => ({ ...c, _owner: true })),
    ...joined.map(c => ({ ...c, _owner: false })),
  ];
  const openCreate = () => { setShowJoin(false); setShowCreate(true); };
  const openJoin = () => { setShowCreate(false); setShowJoin(true); };

  function renderCard(c) {
    const pending = c._owner ? (requestCounts[c.id] || 0) : 0;
    const n = c.member_count ?? 0;
    const cap = c.max_members || 0;
    const pct = cap ? Math.min(100, Math.round((n / cap) * 100)) : 0;
    const open = () => navigate(`/circles/${c.id}`);
    return (
      <li
        key={c.id}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
        className="group relative flex flex-col rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/60 dark:bg-zinc-900/40 p-4 cursor-pointer transition-all hover:-translate-y-px hover:shadow-md hover:shadow-zinc-900/5 hover:border-zinc-300/80 dark:hover:border-white/[0.12]"
      >
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl ${avatarColor(c.name)} flex items-center justify-center text-base font-semibold text-white shrink-0 shadow-sm`} aria-hidden>
            {(c.name || '?')[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50 truncate">{c.name}</span>
              {c._owner && (
                <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300">{t('circles.isOwner')}</span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400 line-clamp-2 min-h-[2.1rem]">
              {c.description || t('circles.noDesc')}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <MemberStack members={c.members || []} />
          <div className="ml-auto text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
            {cap ? t('circles.memberSlots', { current: n, max: cap }) : t('circles.members', { n })}
          </div>
        </div>
        {cap > 0 && (
          <div className="mt-2 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden" aria-hidden>
            <div className={`h-full rounded-full ${pct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(pct, 3)}%` }} />
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-white/[0.06] flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {pending > 0 ? (
            <button type="button" onClick={open}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <span className="relative flex w-1.5 h-1.5"><span className="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-70 animate-ping" /><span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-amber-500" /></span>
              {t('circles.reviewRequests', { n: pending })}
            </button>
          ) : (
            <span className="text-[11px] text-zinc-400">{c._owner ? t('circles.roleOwner') : t('circles.roleMember')}</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => openInvite(c)}
              className="tb-press text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              + {t('circles.inviteBtn')}
            </button>
            <AssetMoreMenu
              label={t('circles.moreActions')}
              items={[
                { key: 'open', label: t('circles.browse.view'), onClick: open },
                c._owner
                  ? { key: 'dissolve', label: t('circles.dissolve'), danger: true, onClick: () => handleDissolve(c) }
                  : { key: 'leave', label: t('circles.leave'), danger: true, onClick: () => handleLeave(c) },
              ]}
            />
          </div>
        </div>
      </li>
    );
  }

  const totalMembers = all.reduce((n, c) => n + (c.member_count || 0), 0);
  const totalPending = owned.reduce((n, c) => n + (requestCounts[c.id] || 0), 0);
  const GRID = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';

  const fieldCls = 'tb-soft-field w-full text-xs px-3 py-2 rounded-lg text-zinc-900 dark:text-zinc-100';

  return (
    <div className="space-y-4">
      {/* 概况头：圈子即交易范围 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-gradient-to-br from-emerald-50/80 via-white/70 to-teal-50/60 dark:from-emerald-950/30 dark:via-zinc-900/40 dark:to-teal-950/20 px-5 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center text-lg shadow-md shadow-emerald-500/25 shrink-0" aria-hidden>◎</div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">{t('circles.bannerTitle')}</div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 flex flex-wrap items-center gap-x-2">
              <span>{t('circles.bannerCircles', { n: all.length })}</span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>{t('circles.bannerMembers', { n: totalMembers })}</span>
              {totalPending > 0 && (<><span className="text-zinc-300 dark:text-zinc-600">·</span><span className="text-amber-600 dark:text-amber-400">{t('circles.bannerPending', { n: totalPending })}</span></>)}
            </p>
            <p className="text-[11px] text-zinc-400 mt-1">{t('circles.scopeHint')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/network')}
              className="tb-press inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800">
              <span aria-hidden>🌐</span>{t('circles.networkLink')}
            </button>
            <button type="button" onClick={scrollToDiscover}
              className="tb-press inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-900 bg-white/80 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/40">
              <span aria-hidden>✦</span>{t('circles.menu.discover')}
            </button>
            <SplitButton
              label={t('circles.createBtn')}
              onClick={openCreate}
              menuLabel={t('circles.moreActions')}
              items={[
                { key: 'join', label: t('circles.menu.join'), hint: t('circles.menu.joinHint'), onClick: openJoin },
              ]}
            />
          </div>
        </div>
      </div>

      {/* 入圈结果横幅 */}
      {joinBanner && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-xs
          ${joinBanner.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
            joinBanner.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
            'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'}`}>
          <span>{joinBanner.key ? t(joinBanner.key, joinBanner.params) : joinBanner.text}</span>
          <button onClick={() => setJoinBanner(null)} className="ml-3 opacity-60 hover:opacity-100 text-base leading-none">×</button>
        </div>
      )}

      {/* 创建 / 邀请码加入：同一位置的轻量表单 */}
      {showCreate && (
        <form onSubmit={handleCreate} className={`${LIB_LIST_CLS} p-4 space-y-2.5`}>
          <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('circles.createTitle')}</h2>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <input autoFocus className={fieldCls} placeholder={t('circles.namePh')}
              value={name} onChange={e => setName(e.target.value)} maxLength={40} required />
            <input className={fieldCls} placeholder={t('circles.descPh')}
              value={desc} onChange={e => setDesc(e.target.value)} maxLength={120} />
          </div>
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={creating || !name.trim()}
              className="tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
              {creating ? t('circles.creating') : t('circles.createSubmit')}
            </button>
            <button type="button" onClick={() => { setShowCreate(false); setError(''); }}
              className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {t('circles.cancel')}
            </button>
          </div>
        </form>
      )}
      {showJoin && (
        <form onSubmit={handleJoinPreview} className={`${LIB_LIST_CLS} p-4 space-y-2.5`}>
          <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('circles.joinModalTitle')}</h2>
          <div className="flex gap-2">
            <input autoFocus className={fieldCls} placeholder={t('circles.joinInputPh')}
              value={joinInput}
              onChange={e => { setJoinInput(e.target.value); setJoinPreview(null); setJoinError(''); }} />
            <button type="submit" disabled={joinLoading || !joinInput.trim()}
              className="tb-press shrink-0 text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
              {t('circles.joinBtn')}
            </button>
            <button type="button" onClick={() => { setShowJoin(false); setJoinError(''); }}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {t('circles.cancel')}
            </button>
          </div>
          {joinError && <p className="text-red-500 text-xs">{joinError}</p>}
        </form>
      )}

      {listLoading ? (
        <div className={`${LIB_LIST_CLS} divide-y divide-zinc-100/90 dark:divide-white/[0.05]`} aria-busy="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
              <div className="w-9 h-9 rounded-xl bg-zinc-200/80 dark:bg-zinc-700/80" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-40 rounded bg-zinc-200/80 dark:bg-zinc-700/80" />
                <div className="h-2.5 w-64 rounded bg-zinc-200/60 dark:bg-zinc-700/60" />
              </div>
            </div>
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className={`${LIB_LIST_CLS} px-6 py-10 text-center`}>
          <div className="text-2xl" aria-hidden>👥</div>
          <p className="mt-2 text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t('circles.empty.title')}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('circles.empty.desc')}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={openCreate}
              className="tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500">
              {t('circles.createBtn')}
            </button>
            <button type="button" onClick={scrollToDiscover}
              className="text-xs px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white/70 dark:hover:bg-zinc-800">
              {t('circles.menu.discover')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {owned.length > 0 && (
            <section>
              <LibrarySectionHead title={t('circles.myCircles')} count={owned.length} />
              <ul className={GRID}>{all.filter(c => c._owner).map(renderCard)}</ul>
            </section>
          )}
          <section>
            <LibrarySectionHead
              title={t('circles.joinedCircles')}
              count={joined.length}
              extra={(
                <button type="button" onClick={openJoin} className="text-blue-600 dark:text-blue-400 hover:underline">
                  {t('circles.menu.join')}
                </button>
              )}
            />
            {joined.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300/80 dark:border-zinc-700 px-4 py-5 text-xs text-zinc-500 dark:text-zinc-400">
                {t('circles.noJoined')}，
                <button type="button" onClick={scrollToDiscover} className="text-blue-600 dark:text-blue-400 hover:underline">
                  {t('circles.menu.discover')}
                </button>
              </div>
            ) : (
              <ul className={GRID}>{all.filter(c => !c._owner).map(renderCard)}</ul>
            )}
          </section>
        </>
      )}

      {/* 发现公开圈子：常驻在「我的圈子」下方，不用切换 */}
      <section ref={discoverRef} className="scroll-mt-4">
        <LibrarySectionHead title={<span><span className="text-violet-500 mr-1" aria-hidden>✦</span>{t('circles.menu.discover')}</span>} extra={t('circles.browse.subtitle')} />
        <CircleBrowse onJoined={load} />
      </section>

      {/* 邀请同好弹框：挂 body，避开主栏 backdrop-filter 裁切 fixed */}
      {inviteModal && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={() => setInviteModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('circles.inviteTitle')}</h3>
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full ${avatarColor(inviteModal.circle.name)} flex items-center justify-center text-xl font-bold text-white shrink-0`}>
                {inviteModal.circle.name[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{inviteModal.circle.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">{t('circles.inviteDesc')}</p>
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2.5 leading-relaxed">
              {t('circles.inviteHint')}
            </p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={copyInviteFromModal}
                className="flex-1 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                {copiedInModal ? t('circles.linkCopied') + ' ✓' : t('circles.copyInviteLink')}
              </button>
              <button type="button" onClick={() => setInviteModal(null)}
                className="flex-1 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {t('circles.inviteClose')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 加入圈子弹框：同样挂 body */}
      {joinPreview && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={() => setJoinPreview(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('circles.joinModalTitle')}</h3>
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full ${avatarColor(joinPreview.circle.name)} flex items-center justify-center text-xl font-bold text-white shrink-0`}>
                {joinPreview.circle.name[0].toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-gray-900 dark:text-gray-100">{joinPreview.circle.name}</p>
                {joinPreview.circle.description && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{joinPreview.circle.description}</p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {t('circles.memberSlots', { current: joinPreview.circle.member_count, max: joinPreview.circle.max_members })}
                </p>
              </div>
            </div>
            {joinError && <p className="text-red-500 text-xs">{joinError}</p>}
            <div className="flex gap-2 pt-1">
              {joinPreview.already_member ? (
                <p className="text-sm text-blue-600 dark:text-blue-400 flex-1">{t('circles.alreadyMember')}</p>
              ) : joinPreview.full ? (
                <p className="text-sm text-yellow-600 dark:text-yellow-400 flex-1">{t('circles.fullCannotJoin')}</p>
              ) : (
                <button onClick={handleJoinConfirm} disabled={joinLoading}
                  className="flex-1 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {joinLoading ? t('circles.joining') : t('circles.joinConfirm')}
                </button>
              )}
              <button onClick={() => setJoinPreview(null)}
                className="flex-1 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {t('circles.cancel')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 成员头像叠放（最多 5 个 + 余数），悬停看名字 */
function MemberStack({ members }) {
  const MAX = 5;
  if (!members.length) return <span className="text-[11px] text-zinc-300 dark:text-zinc-600">—</span>;
  const rest = members.length - MAX;
  return (
    <div className="flex items-center" title={members.map(userDisplayName).join('、')}>
      {members.slice(0, MAX).map((m, i) => (
        <span key={m.id} className={`${i ? '-ml-1.5' : ''} rounded-full ring-2 ring-white dark:ring-zinc-900`}>
          <UserAvatar user={m} className="w-6 h-6 rounded-full" />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-[10px] text-zinc-400 tabular-nums">+{rest}</span>}
    </div>
  );
}
