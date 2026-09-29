import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLang } from '../store/lang';
import {
  getCircleDetail,
  listCircleMembers,
  createCirclePost,
  updateCirclePost,
  deleteCirclePost,
  listCircleJoinRequests,
  approveCircleJoinRequest,
  rejectCircleJoinRequest,
  dissolveCircle,
  leaveCircle,
} from '../api/client';
import RichMediaInput from '../components/RichMediaInput';
import RichMediaContent from '../components/RichMediaContent';
import UserAvatar, { userDisplayName, avatarColor } from '../components/UserAvatar';
import { AssetMoreMenu } from '../components/ResourceAssetCard';
import { LIB_LIST_CLS, libRowCls, LibraryRowTitle, LibrarySectionHead } from '../components/LibraryControls';
import { getServerUrl } from '../config';

/** 侧栏卡片：与资产 / 模型列表容器同款描边 */
const SIDE_CARD = 'rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/55 dark:bg-zinc-900/40 px-4 py-3.5 space-y-2.5';

function authorName(a) {
  return userDisplayName(a);
}

import { formatServerTime } from '../lib/datetime';

function fmtTime(iso) {
  return formatServerTime(iso, { month: 'short' });
}

function AuthorAvatar({ author }) {
  return <UserAvatar user={author} />;
}

/** 圈子共享智能体卡片图标：首字着色 + 右下角智能体符号 */
function CircleAgentIcon({ name }) {
  const label = String(name || '?').trim() || '?';
  const initial = label[0].toUpperCase();
  return (
    <div
      className={`relative w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center text-white font-semibold text-base shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${avatarColor(label)}`}
      aria-hidden
    >
      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-md bg-white dark:bg-gray-900 flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300" fill="currentColor">
          <path d="M8 1.5a1 1 0 0 1 1 1V4h1.5a2 2 0 0 1 2 2v1H14a1 1 0 1 1 0 2h-1.5v1a2 2 0 0 1-2 2H9v1.5a1 1 0 1 1-2 0V12H5.5a2 2 0 0 1-2-2v-1H2a1 1 0 1 1 0-2h1.5V6a2 2 0 0 1 2-2H7V2.5a1 1 0 0 1 1-1zM5.5 6v4h5V6h-5z" />
        </svg>
      </span>
      {initial}
    </div>
  );
}

/** 操作按钮：回复 / 编辑 / 删除 */

function MemberAvatar({ user }) {
  const name = userDisplayName(user);
  return (
    <div className="flex flex-col items-center gap-1 w-10 shrink-0">
      <UserAvatar user={user} />
      <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate w-full text-center leading-tight">
        {name}
      </span>
    </div>
  );
}

/** 圈友列表：默认单行，可展开 */
function CircleMembers({ members, expanded, onToggle }) {
  const { t } = useLang();
  // 单行约 8 个头像，超出则显示展开
  const ROW_CAP = 8;
  const hasMore = members.length > ROW_CAP;

  if (members.length === 0) {
    return <p className="text-xs text-gray-400">{t('circles.detail.noMembers')}</p>;
  }

  return (
    <div className="space-y-2">
      <div className={`flex gap-1 ${expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden'}`}>
        {members.map(m => (
          <MemberAvatar key={m.id} user={m} />
        ))}
      </div>
      {hasMore && (
        <button type="button" onClick={onToggle}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
          {expanded
            ? t('circles.detail.collapseMembers')
            : t('circles.detail.expandMembers').replace('{n}', String(members.length))}
        </button>
      )}
    </div>
  );
}

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
  const [posts, setPosts] = useState([]);
  const [members, setMembers] = useState([]);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [joinRequests, setJoinRequests] = useState([]);
  const [requestBusy, setRequestBusy] = useState(null); // request id

  const [inviteCopied, setInviteCopied] = useState(false);

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
    try { await dissolveCircle(id); navigate('/contribute', { state: { tradeTab: 'circles' } }); } catch (err) { setError(err?.response?.data?.detail || err.message); }
  }

  async function handleLeave() {
    if (!circle || !window.confirm(t('circles.leaveConfirm').replace('{name}', circle.name))) return;
    try { await leaveCircle(id); navigate('/contribute', { state: { tradeTab: 'circles' } }); } catch (err) { setError(err?.response?.data?.detail || err.message); }
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
      setPosts(r.data?.posts || []);
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

  async function handlePost(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    try {
      const r = await createCirclePost(id, text);
      setPosts(prev => [r.data.post, ...prev]);
      setDraft('');
      setShowComposer(false);
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.postFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleSaveEdit(post) {
    const text = editText.trim();
    if (!text) return;
    setPosting(true);
    try {
      const r = await updateCirclePost(id, post.id, text);
      const updated = r.data.post;
      setPosts(prev => prev.map(p => (p.id === post.id ? { ...p, ...updated } : p)));
      setEditId(null);
      setEditText('');
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.editFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleDeletePost(post) {
    if (!window.confirm(t('circles.detail.deleteConfirm'))) return;
    setPosting(true);
    try {
      await deleteCirclePost(id, post.id);
      setPosts(prev => prev.filter(p => p.id !== post.id));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.deleteFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleApproveRequest(req) {
    setRequestBusy(req.id);
    try {
      await approveCircleJoinRequest(id, req.id);
      setJoinRequests(prev => prev.filter(r => r.id !== req.id));
      const memRes = await listCircleMembers(id);
      setMembers(memRes.data?.members || []);
      if (circle) {
        setCircle(c => ({ ...c, member_count: (c.member_count || 0) + 1 }));
      }
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
    return (
      <div className="px-5 py-10 text-center text-sm text-gray-400">{t('circles.detail.loading')}</div>
    );
  }

  if (error && !circle) {
    return (
      <div className="px-5 py-5 text-center space-y-3">
        <p className="text-sm text-red-500">{error}</p>
        <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'circles' } })}
          className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
          {t('circles.detail.back')}
        </button>
      </div>
    );
  }

  const color = avatarColor(circle?.name);

  // 圈主最新一条即公告（按时间倒序）
  const announcement = posts.find(p => circle?.owner_id == null || p.author_id === circle.owner_id) || null;

  const memberLabel = circle?.max_members
    ? t('circles.memberSlots', { current: circle?.member_count ?? 0, max: circle.max_members })
    : t('circles.members', { n: circle?.member_count ?? 0 });

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'circles' } })}
          className="electron-no-drag relative z-50 mb-2 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
          {t('circles.detail.back')}
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className={`w-11 h-11 rounded-xl ${color} flex items-center justify-center text-lg font-semibold text-white shrink-0`} aria-hidden>
            {(circle?.name || '?')[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate">{circle?.name}</h1>
              {circle?.is_owner && (
                <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300">{t('circles.isOwner')}</span>
              )}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
              {circle?.description ? `${circle.description} · ` : ''}{memberLabel}
              {' · '}{t('circles.detail.statModels', { n: models.length })}
              {' · '}{t('circles.detail.statAgents', { n: agents.length })}
            </p>
          </div>
          <div className="electron-no-drag relative z-50 flex items-center gap-1.5">
            {circle?.code && (
              <button type="button" onClick={copyInvite}
                className="tb-press text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500">
                {inviteCopied ? `${t('circles.linkCopied')} ✓` : t('circles.copyInviteLink')}
              </button>
            )}
            <AssetMoreMenu
              label={t('circles.moreActions')}
              items={[
                circle?.is_owner
                  ? { key: 'dissolve', label: t('circles.dissolve'), danger: true, onClick: handleDissolve }
                  : { key: 'leave', label: t('circles.leave'), danger: true, onClick: handleLeave },
              ]}
            />
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* 圈子 = 交易范围：主栏是「本圈可用」；公告只一条、仅圈主可发 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] items-start">
        <div className="min-w-0 space-y-4">
          {(announcement || circle?.is_owner) && (
            <section className={SIDE_CARD}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('circles.detail.notice')}</h2>
                {circle?.is_owner && !showComposer && editId == null && (
                  <div className="flex items-center gap-2 text-[11px]">
                    {announcement && (
                      <>
                        <button type="button" onClick={() => { setEditId(announcement.id); setEditText(announcement.content); }}
                          className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">{t('circles.detail.edit')}</button>
                        <button type="button" onClick={() => handleDeletePost(announcement)}
                          className="text-zinc-400 hover:text-red-500">{t('circles.detail.delete')}</button>
                      </>
                    )}
                    {!announcement && (
                      <button type="button" onClick={() => setShowComposer(true)}
                        className="text-blue-600 dark:text-blue-400 hover:underline">{t('circles.detail.noticeCreate')}</button>
                    )}
                  </div>
                )}
              </div>
              {showComposer ? (
                <form onSubmit={handlePost} className="space-y-2">
                  <RichMediaInput circleId={id} value={draft} onChange={setDraft} maxLength={2000} rows={3}
                    placeholder={t('circles.detail.announcePh')} autoFocus />
                  <div className="flex gap-2">
                    <button type="submit" disabled={posting || !draft.trim()}
                      className="tb-press text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                      {posting ? t('circles.detail.posting') : t('circles.detail.post')}
                    </button>
                    <button type="button" onClick={() => { setShowComposer(false); setDraft(''); }}
                      className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      {t('circles.detail.cancel')}
                    </button>
                  </div>
                </form>
              ) : announcement && editId === announcement.id ? (
                <div className="space-y-2">
                  <RichMediaInput circleId={id} value={editText} onChange={setEditText} maxLength={2000} rows={3} />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => handleSaveEdit(announcement)} disabled={posting}
                      className="tb-press text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                      {t('circles.detail.save')}
                    </button>
                    <button type="button" onClick={() => { setEditId(null); setEditText(''); }}
                      className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      {t('circles.detail.cancel')}
                    </button>
                  </div>
                </div>
              ) : announcement ? (
                <div className="text-xs text-zinc-700 dark:text-zinc-200">
                  <RichMediaContent content={announcement.content} />
                  <p className="mt-1.5 text-[11px] text-zinc-400">{authorName(announcement)} · {fmtTime(announcement.updated_at || announcement.created_at)}</p>
                </div>
              ) : (
                <p className="text-xs text-zinc-400">{t('circles.detail.noticeEmptyOwner')}</p>
              )}
            </section>
          )}

          <section>
            <LibrarySectionHead
              title={t('circles.detail.available')}
              count={agents.length + models.length}
              extra={t('circles.detail.availableHint')}
            />
            {agents.length === 0 && models.length === 0 ? (
              <div className={`${LIB_LIST_CLS} px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-400`}>
                {t('circles.detail.availableEmpty')}
                <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'supply' } })}
                  className="ml-1 text-blue-600 dark:text-blue-400 hover:underline">{t('circles.detail.shareToCircle')}</button>
              </div>
            ) : (
              <ul className={LIB_LIST_CLS}>
                {agents.map((a) => {
                  const title = a.display_name || a.name || a.id;
                  const blurb = String(a.description || '').trim();
                  return (
                    <li key={`${a.worker_id}:${a.id}`} className={`${libRowCls(false)} !cursor-default grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7rem_4.5rem]`}>
                      <LibraryRowTitle
                        logo={<CircleAgentIcon name={title} />}
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
                      logo={<div className="w-9 h-9 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm shrink-0" aria-hidden>◆</div>}
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
        </div>

        <aside className="space-y-3 lg:sticky lg:top-0">
      {/* 圈主：待审批入圈申请 */}
      {circle?.is_owner && joinRequests.length > 0 && (
        <section className={`${SIDE_CARD} ring-1 ring-amber-200/70 dark:ring-amber-900/50`}>
          <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
            {t('circles.browse.requestsTitle')}
            {joinRequests.length > 0 && (
              <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                {joinRequests.length}
              </span>
            )}
          </h2>
          {joinRequests.length === 0 ? (
            <p className="text-xs text-gray-400">{t('circles.browse.noRequests')}</p>
          ) : (
            <div className="space-y-2">
              {joinRequests.map(req => {
                const name = req.nickname || req.email?.split('@')[0] || '?';
                return (
                  <div key={req.id} className="flex items-center gap-3 py-2 border-t border-gray-100 dark:border-gray-700 first:border-0 first:pt-0">
                    <AuthorAvatar author={req} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{name}</p>
                      {req.message && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{req.message}</p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={requestBusy === req.id}
                        onClick={() => handleApproveRequest(req)}
                        className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
                      >
                        {t('circles.browse.approve')}
                      </button>
                      <button
                        type="button"
                        disabled={requestBusy === req.id}
                        onClick={() => handleRejectRequest(req)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                      >
                        {t('circles.browse.reject')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 圈友 */}
      <section className={SIDE_CARD}>
        <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('circles.detail.friends')}</h2>
        <CircleMembers
          members={members}
          expanded={membersExpanded}
          onToggle={() => setMembersExpanded(v => !v)}
        />
      </section>

        </aside>
      </div>
    </div>
  );
}
