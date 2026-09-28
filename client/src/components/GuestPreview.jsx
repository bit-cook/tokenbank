import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

/**
 * 游客访问需登录的页面（圈子 / 交易）时的预览页：先讲清楚能得到什么，再引导登录；
 * 不直接跳整页登录表单。可无登录浏览公开的社区网络。
 */
export default function GuestPreview({ kind, from }) {
  const navigate = useNavigate();
  const { t } = useLang();
  const prefix = `guestPreview.${kind}`;
  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-10 flex">
      <div className="tb-soft-card rounded-2xl px-6 py-8 max-w-xl w-full m-auto space-y-5">
        <div className="text-center space-y-2">
          <div className="text-3xl" aria-hidden>{kind === 'circles' ? '👥' : '💱'}</div>
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
          <button type="button" onClick={() => navigate('/login', { state: { from } })}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors">
            {t('guestPreview.signIn')}
          </button>
          <button type="button" onClick={() => navigate('/network')}
            className="px-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
            {t('guestPreview.browseNetwork')}
          </button>
        </div>
      </div>
    </div>
  );
}
