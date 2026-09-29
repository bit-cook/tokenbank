import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

/** 圈子页签：我的圈子 │ ✦ 发现（与资产页页签同款下划线样式） */
export default function CirclesTabs({ active, count = null }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const cls = (on) => `-mb-px pb-2.5 text-[13px] border-b-2 transition-colors ${
    on
      ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-50 font-semibold'
      : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
  }`;
  return (
    <div role="tablist" className="electron-no-drag relative z-40 mt-4 flex items-end gap-6 border-b border-zinc-200/80 dark:border-white/[0.08]">
      <button type="button" role="tab" aria-selected={active === 'mine'} onClick={() => navigate('/circles')} className={cls(active === 'mine')}>
        {t('circles.tab.mine')}
        {count > 0 && <span className="ml-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">{count}</span>}
      </button>
      <span className="self-center mb-2.5 w-px h-4 bg-zinc-200 dark:bg-zinc-700" aria-hidden />
      <button type="button" role="tab" aria-selected={active === 'discover'} onClick={() => navigate('/circles/browse')} className={cls(active === 'discover')}>
        <span className="text-violet-500 mr-1" aria-hidden>✦</span>{t('circles.tab.discover')}
      </button>
    </div>
  );
}
