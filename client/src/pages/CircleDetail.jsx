import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLang } from '../store/lang';
import {
  getCircleDetail,
  listCircleMembers,
  listCircleJoinRequests,
  approveCircleJoinRequest,
  rejectCircleJoinRequest,
  dissolveCircle,
  leaveCircle,
} from '../api/client';
import UserAvatar, { userDisplayName, avatarColor } from '../components/UserAvatar';
import { AssetMoreMenu } from '../components/ResourceAssetCard';
import { LIB_LIST_CLS, libRowCls, LibraryRowTitle, LibrarySectionHead } from '../components/LibraryControls';
import { getServerUrl } from '../config';

/** 与资产 / 模型列表容器同款描边 */
const CARD = 'rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/55 dark:bg-zinc-900/40';

/** 圈内智能体图标：首字着色 */
function AgentIcon({ name }) {
  const label = String(name || '?').trim() || '?';
  return (
    <div className={`w-9 h-9 rounded-xl shrink-0 flex items-center justify-center text-white text-sm font-semibold ${avatarColor(label)}`} aria-hidden>
      {label[0].toUpperCase()}
    </div>
  );
}

/**
 * 圈子详情：圈子 = 交易范围。只保留「本圈可用」「邀请 / 审批」「圈友」三件事，
 * 发帖 / 公告等内容功能不在主路径上。
 */
export default function CircleDetail({ routeParams }) {
  const params = useParams();
  const navigate = useNavigate();
  const { t } = useLang();
  // KeepAlive 下 useParams 会随当前 URL 漂移；优先用缓存 key 解析出的稳定 id
  const circleId = routeParams?.circleId ?? params.circleId;
  const id = Number(circleId);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [circle, setCircle] = useState(null);
  const [models, setModels] = useState([]);
  const [agents, setAgents] = useState([]);
  const [members, setMembers] = useState([]);
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [joinRequests, setJoinRequests] = useState([]);
  const [requestBusy, setRequestBusy] = useState(null); // request id
  const [inviteCopied, setInviteCopied] = useState(false);

  const backToCircles = () => navigate('/contribute', { state: { tradeTab: 'circles' } });

  function copyInvite() {
    if (!circle?.code) return;
    const base = getServerUrl() || window.location.origin;
    navigator.clipboard?.writeText(`${base}/app?c=${circle.code}`).then(() => {
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    }).catch(() => {});
  }

  async function handleDissolve() {
    if (!circle || !window.confirm(t('circles.dissolveConfirm').replace('{name}', circle.name))) return;
    try { await dissolveCircle(id); backToCircles(); } catch (err) { setError(err?.response?.data?.detail || err.message); }
  }

  async function handleLeave() {
    if (!circle || !window.confirm(t('circles.leaveConfirm').replace('{name}', circle.name))) return;
    try { await leaveCircle(id); backToCircles(); } catch (err) { setError(err?.response?.data?.detail || err.message); }
  }

  const load = useCallback(async () => {
    // 无效 id：必须结束 loading，否则会永远停在「加载中…」
    if (!Number.isFinite(id) || id <= 0) {
      setLoading(false);
      setError(t('circles.detail.loadFailed'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [r, memRes] = await Promise.all([
        getCircleDetail(id),
        listCircleMembers(id).catch(() => ({ data: { members: [] } })),
      ]);
      setCircle(r.data?.circle || null);
      setModels(r.data?.models || []);
      setAgents(r.data?.agents || []);
      setMembers(memRes.data?.members || []);
      if (r.data?.circle?.is_owner) {
        try {
          const jr = await listCircleJoinRequests(id);
          setJoinRequests(jr.data?.requests || []);
        } catch {
          setJoinRequests([]);
        }
      } else {
        setJoinRequests([]);
      }
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  async function handleApproveRequest(req) {
    setRequestBusy(req.id);
    try {
      await approveCircleJoinRequest(id, req.id);
      setJoinRequests(prev => prev.filter(r => r.id !== req.id));
      const memRes = await listCircleMembers(id);
      setMembers(memRes.data?.members || []);
      setCircle(c => (c ? { ...c, member_count: (c.member_count || 0) + 1 } : c));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.browse.applyFailed'));
    } finally {
      setRequestBusy(null);
    }
  }

  async function handleRejectRequest(req) {
    setRequestBusy(req.id);
    try {
      await rejectCircleJoinRequest(id, req.id);
      setJoinRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.browse.applyFailed'));
    } finally {
      setRequestBusy(null);
    }
  }

  if (loading) {
    return <div className="px-5 py-10 text-center text-xs text-zinc-400">{t('circles.detail.loading')}</div>;
  }

  if (error && !circle) {
    return (
      <div className="px-5 py-10 text-center space-y-3">
        <p className="text-xs text-red-500">{error}</p>
        <button type="button" onClick={backToCircles}
          className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
          {t('circles.detail.back')}
        </button>
      </div>
    );
  }

  const n = circle?.member_count ?? members.length;
  const cap = circle?.max_members || 0;
  const pct = cap ? Math.min(100, Math.round((n / cap) * 100)) : 0;
  const isOwner = !!circle?.is_owner;
  const MEMBER_CAP = 12;
  const shownMembers = showAllMembers ? members : members.slice(0, MEMBER_CAP);
  const stats = [
    { k: 'members', label: t('circles.detail.statMembersLabel'), value: cap ? `${n} / ${cap}` : n },
    { k: 'agents', label: t('circles.detail.kindAgent'), value: agents.length },
    { k: 'models', label: t('circles.detail.kindModel'), value: models.length },
  ];

  return (
    <div className="px-5 py-5 space-y-4">
      <button type="button" onClick={backToCircles}
        className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
        {t('circles.detail.back')}
      </button>

      {/* 头部：身份 + 关键数字 + 主操作 */}
      <section className={`${CARD} relative overflow-hidden`}>
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-emerald-100/70 via-teal-50/50 to-transparent dark:from-emerald-900/20 dark:via-teal-900/10" aria-hidden />
        <div className="relative px-5 pt-5 pb-4 flex flex-wrap items-start gap-4">
          <div className={`w-14 h-14 rounded-2xl ${avatarColor(circle?.name)} flex items-center justify-center text-xl font-semibold text-white shrink-0 shadow-md ring-4 ring-white/70 dark:ring-zinc-900/70`} aria-hidden>
            {(circle?.name || '?')[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate">{circle?.name}</h1>
              {isOwner && (
                <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300">{t('circles.isOwner')}</span>
              )}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{circle?.description || t('circles.noDesc')}</p>
          </div>
          <div className="electron-no-drag relative z-50 flex items-center gap-1.5 pt-1">
            {circle?.code && (
              <button type="button" onClick={copyInvite}
                className="tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25 hover:bg-blue-500">
                {inviteCopied ? `${t('circles.linkCopied')} ✓` : t('circles.copyInviteLink')}
              </button>
            )}
            <AssetMoreMenu
              label={t('circles.moreActions')}
              items={[
                isOwner
                  ? { key: 'dissolve', label: t('circles.dissolve'), danger: true, onClick: handleDissolve }
                  : { key: 'leave', label: t('circles.leave'), danger: true, onClick: handleLeave },
              ]}
            />
          </div>
        </div>
        <div className="relative grid grid-cols-3 border-t border-zinc-100 dark:border-white/[0.06]">
          {stats.map((s, i) => (
            <div key={s.k} className={`px-5 py-3 ${i ? 'border-l border-zinc-100 dark:border-white/[0.06]' : ''}`}>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{s.label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{s.value}</div>
              {s.k === 'members' && cap > 0 && (
                <div className="mt-1.5 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden" aria-hidden>
                  <div className={`h-full rounded-full ${pct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(pct, 3)}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* 圈主：待审批（有才显示） */}
      {isOwner && joinRequests.length > 0 && (
        <section className="rounded-2xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/15 overflow-hidden">
          <div className="px-4 pt-3 pb-1 text-[13px] font-semibold text-amber-800 dark:text-amber-300">
            {t('circles.browse.requestsTitle')}
            <span className="ml-1.5 text-xs font-normal tabular-nums">{joinRequests.length}</span>
          </div>
          <ul>
            {joinRequests.map(req => {
              const name = req.nickname || req.email?.split('@')[0] || '?';
              return (
                <li key={req.id} className="flex items-center gap-3 px-4 py-2.5 border-t first:border-t-0 border-amber-100/80 dark:border-amber-900/30">
                  <UserAvatar user={req} className="w-8 h-8 rounded-full" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate">{name}</p>
                    {req.message && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{req.message}</p>}
                  </div>
                  <button type="button" disabled={requestBusy === req.id} onClick={() => handleApproveRequest(req)}
                    className="tb-press text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                    {t('circles.browse.approve')}
                  </button>
                  <button type="button" disabled={requestBusy === req.id} onClick={() => handleRejectRequest(req)}
                    className="text-[11px] px-2.5 py-1 rounded-lg text-zinc-500 hover:bg-white/80 dark:hover:bg-zinc-800 disabled:opacity-50">
                    {t('circles.browse.reject')}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 本圈可用：圈子作为交易范围的核心价值 */}
      <section>
        <LibrarySectionHead
          title={t('circles.detail.available')}
          count={agents.length + models.length}
          extra={(
            <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'supply' } })}
              className="text-blue-600 dark:text-blue-400 hover:underline">
              {t('circles.detail.shareToCircle')}
            </button>
          )}
        />
        {agents.length === 0 && models.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300/80 dark:border-zinc-700 px-6 py-10 text-center">
            <div className="text-2xl" aria-hidden>🤝</div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('circles.detail.availableEmpty')}</p>
            <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'supply' } })}
              className="tb-press mt-3 text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500">
              {t('circles.detail.shareToCircle')}
            </button>
          </div>
        ) : (
          <ul className={LIB_LIST_CLS}>
            {agents.map((a) => {
              const title = a.display_name || a.name || a.id;
              const blurb = String(a.description || '').trim();
              return (
                <li key={`${a.worker_id}:${a.id}`} className={`${libRowCls(false)} !cursor-default grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7rem_4.5rem]`}>
                  <LibraryRowTitle
                    logo={<AgentIcon name={title} />}
                    name={title}
                    chips={<span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">{t('circles.detail.kindAgent')}</span>}
                    sub={blurb || '—'}
                  />
                  <span className="hidden md:block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{a.runtime || '—'}</span>
                  <div className="flex justify-end">
                    <button type="button"
                      onClick={() => navigate('/contribute', { state: { tradeTab: 'hire', scope: id, focusAgent: a.id } })}
                      className="tb-press whitespace-nowrap text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500">
                      {t('contribute.hireShort')}
                    </button>
                  </div>
                </li>
              );
            })}
            {models.map((m) => (
              <li key={m.id} className={`${libRowCls(false)} !cursor-default grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7rem_4.5rem]`}>
                <LibraryRowTitle
                  logo={<div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300 flex items-center justify-center text-xs shrink-0" aria-hidden>◆</div>}
                  name={<span className="font-mono">{m.id}</span>}
                  chips={<span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300">{t('circles.detail.kindModel')}</span>}
                  sub={t('circles.detail.modelUsage')}
                />
                <span className="hidden md:block text-[11px] text-zinc-500 dark:text-zinc-400">{m.model_type && m.model_type !== 'chat' ? m.model_type : 'chat'}</span>
                <span />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 圈友：头像 + 名字，圈主置前 */}
      <section>
        <LibrarySectionHead title={t('circles.detail.friends')} count={members.length} />
        {members.length === 0 ? (
          <p className="px-1 text-xs text-zinc-400">{t('circles.detail.noMembers')}</p>
        ) : (
          <div className={`${CARD} p-3`}>
            <div className="flex flex-wrap gap-1.5">
              {[...shownMembers].sort((x, y) => (y.id === circle?.owner_id) - (x.id === circle?.owner_id)).map(m => (
                <span key={m.id} className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-100 dark:border-white/[0.05]">
                  <UserAvatar user={m} className="w-5 h-5 rounded-full text-[9px]" />
                  <span className="text-[11px] text-zinc-700 dark:text-zinc-200 max-w-[8rem] truncate">{userDisplayName(m)}</span>
                  {m.id === circle?.owner_id && <span className="text-[10px] text-blue-600 dark:text-blue-300">{t('circles.isOwner')}</span>}
                </span>
              ))}
              {members.length > MEMBER_CAP && (
                <button type="button" onClick={() => setShowAllMembers(v => !v)}
                  className="text-[11px] px-2.5 py-1 rounded-full text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30">
                  {showAllMembers ? t('circles.detail.collapseMembers') : t('circles.detail.expandMembers').replace('{n}', String(members.length))}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
