import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { getNetwork } from '../api/client';

/**
 * 游客访问需登录的页面（圈子 / 交易）时的预览页：先讲清楚能得到什么，再引导登录；
 * 不直接跳整页登录表单。圈子可无登录浏览已有的公开圈子（/public/network），交易可逛社区网络。
 */
export default function GuestPreview({ kind, from }) {
  const navigate = useNavigate();
  const { t } = useLang();
  const prefix = `guestPreview.${kind}`;
  const isCircles = kind === 'circles';
  // 公开圈子列表：null=未加载，'error'=加载失败
  const [circles, setCircles] = useState(null);
  const [loadingCircles, setLoadingCircles] = useState(false);
  const listRef = useRef(null);
  const signIn = () => navigate('/login', { state: { from } });

  async function showCircles() {
    if (circles && circles !== 'error') {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setLoadingCircles(true);
    try {
      const r = await getNetwork();
      setCircles(Array.isArray(r?.data?.available_circles) ? r.data.available_circles : []);
    } catch {
      setCircles('error');
    } finally {
      setLoadingCircles(false);
    }
  }

  useEffect(() => {
    if (circles && circles !== 'error') listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [circles]);

  const hasList = isCircles && (loadingCircles || circles != null);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-10 flex flex-col">
      <div className={`tb-soft-card rounded-2xl px-6 py-8 max-w-xl w-full mx-auto space-y-5 ${hasList ? '' : 'my-auto'}`}>
        <div className="text-center space-y-2">
          <div className="text-3xl" aria-hidden>{isCircles ? '👥' : '💱'}</div>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t(`${prefix}.title`)}</h1>
          <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t(`${prefix}.desc`)}</p>
        </div>
        <ul className="space-y-2">
          {['p1', 'p2', 'p3'].map(k => (
            <li key={k} className="flex gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <span className="text-blue-500 shrink-0">✓</span>
              <span>{t(`${prefix}.${k}`)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <button type="button" onClick={signIn}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors">
            {t('guestPreview.signIn')}
          </button>
          <button type="button" onClick={isCircles ? showCircles : () => navigate('/network')}
            className="px-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
            {isCircles ? t('guestPreview.browseCircles') : t('guestPreview.browseNetwork')}
          </button>
        </div>
      </div>

      {hasList && (
        <div ref={listRef} className="max-w-xl w-full mx-auto mt-4 space-y-2 scroll-mt-4">
          <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 px-1">{t('guestPreview.circles.listTitle')}</h2>
          {loadingCircles ? (
            <p className="text-xs text-zinc-400 px-1 py-4">{t('circles.browse.loading')}</p>
          ) : circles === 'error' ? (
            <p className="text-xs text-zinc-400 px-1 py-4">{t('guestPreview.circles.loadFailed')}</p>
          ) : circles.length === 0 ? (
            <p className="text-xs text-zinc-400 px-1 py-4">{t('circles.browse.empty')}</p>
          ) : circles.map(c => (
            <div key={c.id} className="tb-soft-card rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{c.name}</div>
                {c.description && <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{c.description}</div>}
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {t('guestPreview.circles.members', { n: c.member_count ?? 0, max: c.max_members ?? '—' })}
                </div>
              </div>
              {c.full ? (
                <span className="text-xs text-zinc-400 shrink-0">{t('circles.browse.full')}</span>
              ) : (
                <button type="button" onClick={signIn}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-900 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors">
                  {t('guestPreview.circles.signInToJoin')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
