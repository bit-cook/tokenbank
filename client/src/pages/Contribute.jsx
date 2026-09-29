// client/src/pages/Contribute.jsx
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getStats, getSettlements, getContributeSummary, listJoinedCircles, listMyCircles, listCommunityAgents, listPublicCommunityAgents } from '../api/client';
import { getConfig, getGateway, getLocalConfig } from '../api/adapter';
import { resolveLocalGatewayBase } from '../api/gatewayModels';
import { loadUserAccounts } from '../api/userAccounts';
import { collectPersonalAvailableModels, mergeAccountsForGateway } from '../lib/personalAvailableModels';
import {
  getAgentStatus, startAgent, stopAgent, getAgentLogs,
  subscribeAgentEvents, useAgentPolling,
} from '../api/agentControl';
import RateChart from '../components/RateChart';
import Circles from './Circles';
import TruncTip from '../components/TruncTip';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import { fmtContribTokens, fmtCreditCny, creditsToCny } from '../lib/credit-pricing';
import { avatarColor } from '../components/UserAvatar';
import {
  LIB_LIST_CLS, libRowCls, LibraryRowTitle, LibraryInspector, InspectorSection, LibrarySectionHead,
} from '../components/LibraryControls';
import { getServerUrl } from '../config';
import { copyText } from '../lib/resource-enable';
function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 兼容 API 返回 list 或 JSON 字符串 */
function normalizeSettlementResources(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch { /* ignore */ }
  }
  return [];
}

/** 结算时间：去掉 ISO 的 T，显示为 YYYY-MM-DD HH:mm（period_end 为墙钟时间，不按 UTC 偏移） */
function formatSettlementTime(iso) {
  if (!iso) return '—';
  const m = String(iso).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}`;
  return String(iso).slice(0, 16).replace('T', ' ');
}

/** 结算资源展示：模型名原样；agent → 智能体裸名（去掉「昵称的」前缀） */
function formatSettlementResource(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  let raw = s.startsWith('agent:') ? s.slice(6).trim() : s;
  // 兼容 id 形态与「所有者的名称」历史展示名
  raw = raw.replace(/^res-assistant-/, '').replace(/-assistant$/, '');
  const m = raw.match(/^(.+?)的(.+)$/);
  if (m && m[2]) raw = m[2].trim();
  return raw || s;
}

/** 按圈子 id 去重（统一为 number，避免 owned/joined 合并重复） */
function uniqueCircles(list) {
  const map = new Map();
  for (const c of list || []) {
    const id = Number(c.id);
    if (!id || map.has(id)) continue;
    map.set(id, { ...c, id });
  }
  return [...map.values()];
}

function uniqueCircleIds(ids) {
  return [...new Set((ids || []).map(id => Number(id)).filter(Boolean))];
}

/** 贡献可选模型：个人源 + agent providers + 已保存配置；类型取最高优先级（图文可覆盖 chat） */
function collectContributeAvailableModels(saved, accounts, localCfg) {
  const merged = mergeAccountsForGateway(localCfg || {}, accounts || {});
  const typeByName = {};
  const rank = (t) => {
    if (t === 'image' || t === 'embedding') return 3;
    if (t === 'vision') return 2;
    return 1;
  };
  const bump = (name, type = 'chat') => {
    const n = String(name || '').trim();
    if (!n) return;
    let t = String(type || 'chat').trim().toLowerCase();
    if (t === 'vl' || t === 'vlm' || t === 'multimodal') t = 'vision';
    else if (t === 'img' || t === 'imggen') t = 'image';
    else if (t === 'embed' || t === 'embeddings') t = 'embedding';
    else if (!['chat', 'vision', 'image', 'embedding'].includes(t)) t = 'chat';
    const cur = typeByName[n];
    // 非 chat 优先，避免个人源先写入 chat 盖住供给源上的图文
    if (!cur || rank(t) >= rank(cur)) typeByName[n] = t;
  };

  for (const { id } of collectPersonalAvailableModels(saved || {}, merged)) {
    bump(id, 'chat');
  }

  for (const p of (saved?.providers || [])) {
    if (p.type === 'p2p') continue;
    for (const m of (p.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
      bump(name, type);
    }
  }

  for (const m of (saved?.models || [])) {
    const name = typeof m === 'string' ? m : m.name;
    const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
    bump(name, type);
  }

  for (const g of (saved?.model_groups || [])) {
    for (const m of (g.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      bump(name, typeof m === 'string' ? 'chat' : (m.type || 'chat'));
    }
  }

  return Object.entries(typeByName)
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ContributionConfigCard({ onStart, onStop, running, agentError, onAgentsRefresh, circles: circlesProp = null, onManageCircles }) {
  const { t } = useLang();
  const location = useLocation();
  const pageActive = location.pathname === '/contribute';
  const [selectedNames,   setSelectedNames]   = useState(new Set()); // Set<string>
  const [availableModels, setAvailableModels] = useState([]);        // {name, type}[]
  const [availableAssistants, setAvailableAssistants] = useState([]); // resource rows
  const [selectedAssistantIds, setSelectedAssistantIds] = useState(new Set());
  const [nodeName,        setNodeName]        = useState('');
  const [autoStart,       setAutoStart]       = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [savedMsg,        setSavedMsg]        = useState('');
  const [localGw,         setLocalGw]         = useState(() => resolveLocalGatewayBase());
  const [circles,         setCircles]         = useState([]);         // 可分享的圈子
  // 交易页「圈子」页签里新建 / 加入后同步到这里
  useEffect(() => { if (circlesProp) setCircles(uniqueCircles(circlesProp)); }, [circlesProp]);
  const [circleScope,     setCircleScope]     = useState('public');   // 'public' | 'circle'
  const [selectedCircleIds, setSelectedCircleIds] = useState(new Set());
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [copiedAssistantId, setCopiedAssistantId] = useState('');
  const [assistantPickerBusy, setAssistantPickerBusy] = useState(false);
  // 首次加载时同步贡献配置里的已选智能体；之后刷新列表不覆盖用户勾选
  const assistantsHydratedRef = useRef(false);

  /** 可上架的非内置智能体（含投射状态，供选择器过滤） */
  const refreshAssistants = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.resource?.listResources) {
      return [];
    }
    try {
      const asstRes = await window.electronAPI.resource.listResources({ type: 'assistant' });
      const assistants = asstRes?.success ? (asstRes.resources || []) : (asstRes?.resources || []);
      const contributable = (Array.isArray(assistants) ? assistants : []).filter((a) => {
        if (!a) return false;
        if (a.source === 'builtin' || a.metadata?.builtin) return false;
        if (String(a.source_url || '').startsWith('builtin:')) return false;
        return true;
      });
      setAvailableAssistants(contributable);
      // 已选里去掉库中已删除的项；不重置用户刚勾选的
      const allowedIds = new Set(contributable.map((a) => a.id));
      setSelectedAssistantIds((prev) => {
        if (!assistantsHydratedRef.current) return prev;
        let changed = false;
        const next = new Set();
        for (const id of prev) {
          if (allowedIds.has(id)) next.add(id);
          else changed = true;
        }
        return changed ? next : prev;
      });
      return contributable;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    Promise.all([listMyCircles(), listJoinedCircles()])
      .then(([ownedRes, joinedRes]) => {
        const owned = ownedRes.data?.circles || [];
        const joined = joinedRes.data?.circles || [];
        setCircles(uniqueCircles([...owned, ...joined]));
      })
      .catch(() => {});
    Promise.all([
      getConfig().read().catch(() => null),
      getGateway().status().catch(() => null),
      loadUserAccounts().catch(() => ({})),
      getLocalConfig().get().catch(() => ({})),
      (typeof window !== 'undefined' && window.electronAPI?.resource?.listResources)
        ? window.electronAPI.resource.listResources({ type: 'assistant' }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([saved, gwStatus, accounts, localCfg, asstRes]) => {
      // Dynamic gateway URL from actual running port
      const port = gwStatus?.port || 11430;
      const gw   = resolveLocalGatewayBase(port);
      setLocalGw(gw);

      const cfg = saved || {};
      const avail = collectContributeAvailableModels(cfg, accounts, localCfg);
      const prevNames = new Set(
        (cfg.model_groups || [])
          .flatMap(g => g.models || [])
          .map(m => typeof m === 'string' ? m : m.name)
          .filter(Boolean)
      );
      setAvailableModels(avail);
      setSelectedNames(prevNames);
      setNodeName(cfg.name || '');
      setAutoStart(!!cfg.auto_start);
      if (cfg.contribute_circle_ids?.length) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds(cfg.contribute_circle_ids)));
      } else if (cfg.contribute_circle_id) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds([cfg.contribute_circle_id])));
      }
      const assistants = asstRes?.success ? (asstRes.resources || []) : (asstRes?.resources || []);
      // 内置智能体不出现在贡献列表
      const contributable = (Array.isArray(assistants) ? assistants : []).filter((a) => {
        if (!a) return false;
        if (a.source === 'builtin' || a.metadata?.builtin) return false;
        if (String(a.source_url || '').startsWith('builtin:')) return false;
        return true;
      });
      setAvailableAssistants(contributable);
      const allowedIds = new Set(contributable.map((a) => a.id));
      const prevAsst = new Set(
        (cfg.contribute_assistants || [])
          .map((x) => (typeof x === 'string' ? x : x?.id))
          .filter((id) => id && allowedIds.has(id)),
      );
      setSelectedAssistantIds(prevAsst);
      assistantsHydratedRef.current = true;
    });
  }, []);

  // 打开「上架智能体」选择器时重新拉取，避免资源页刚投射后此处仍是旧列表
  useEffect(() => {
    if (!showAssistantPicker) return undefined;
    let cancelled = false;
    setAssistantPickerBusy(true);
    refreshAssistants()
      .finally(() => {
        if (!cancelled) setAssistantPickerBusy(false);
      });
    return () => { cancelled = true; };
  }, [showAssistantPicker, refreshAssistants]);

  // KeepAlive：从资源页切回交易页时刷新投射状态
  useEffect(() => {
    if (!pageActive) return;
    refreshAssistants();
  }, [pageActive, refreshAssistants]);

  function toggleModel(name) {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleAssistant(id) {
    setSelectedAssistantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** 复制已分享智能体的网页版链接（全球/圈子共用 /a/{id}） */
  async function copyAssistantWebLink(id) {
    const base = (getServerUrl() || '').replace(/\/$/, '');
    if (!base || !id) return;
    const url = `${base}/a/${encodeURIComponent(id)}`;
    const ok = await copyText(url);
    if (ok) {
      setCopiedAssistantId(id);
      setTimeout(() => setCopiedAssistantId((cur) => (cur === id ? '' : cur)), 1500);
    }
  }

  function assistantDisabledReason(r) {
    // 内置智能体不可贡献（列表侧已过滤；此处兜底）
    if (r?.source === 'builtin' || r?.metadata?.builtin
      || String(r?.source_url || '').startsWith('builtin:')) {
      return t('contribute.assistantBuiltinBlocked');
    }
    const ENABLE = new Set(['claude-code', 'codex', 'cursor', 'kimi-code', 'workbuddy']);
    const ok = (r.projections || []).some((p) => ENABLE.has(p.agentId || p.agent_id));
    if (!ok) return t('contribute.assistantNeedProject');
    return '';
  }

  function toggleCircle(id) {
    const nid = Number(id);
    if (!nid) return;
    setSelectedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(nid)) next.delete(nid); else next.add(nid);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSavedMsg('');
    try {
      const models = [...selectedNames].map(name =>
        availableModels.find(m => m.name === name) || { name, type: 'chat' }
      );
      const model_groups = [{ base_url: localGw, token: '', models }];
      const current      = (await getConfig().read().catch(() => null)) || {};
      const visibility = circleScope === 'circle' ? 'circle' : 'public';
      const contribute_assistants = [...selectedAssistantIds]
        .filter((id) => {
          const row = availableAssistants.find((a) => a.id === id);
          return row && !assistantDisabledReason(row);
        })
        .map((id) => ({ id, visibility }));
      const updated      = {
        ...current,
        model_groups,
        llm_base_url: localGw,
        llm_token: '',
        models,
        name: nodeName,
        auto_start: autoStart,
        contribute_assistants,
      };
      const circleIds = circleScope === 'circle' ? uniqueCircleIds([...selectedCircleIds]) : [];
      await getConfig().write({
        ...updated,
        contribute_circle_ids: circleIds,
        contribute_circle_id: circleIds[0] ?? null,
      });
      // 保存后立即启动贡献节点
      const started = onStart ? await onStart() : true;
      setSavedMsg(started ? t('contribute.savedAndStarted') : t('common.saved'));
      // 启动后触发社区列表刷新（含延迟补刷，等节点重连上报）
      onAgentsRefresh?.();
      setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className={`${LIB_LIST_CLS} p-5 space-y-4`}>
      {/* 转发地址：供给请求经本机网关转出 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">{t('contribute.forwardUrl')}</span>
        <TruncTip as="span" title={localGw} className="text-xs font-mono text-zinc-700 dark:text-zinc-300 min-w-0">
          {localGw}
        </TruncTip>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400 shrink-0 ml-auto">{savedMsg}</span>}
      </div>
      {agentError && (
        <p className="text-xs text-red-600 dark:text-red-400 -mt-1">{agentError}</p>
      )}

      {/* 贡献模型：默认只展示已选；点 + 从候选里添加，避免占满整页 */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{t('contribute.models')}</span>
          {selectedNames.size > 0 && (
            <span className="text-[11px] text-zinc-400">{t('contribute.modelsSelected', { n: selectedNames.size })}</span>
          )}
        </div>

        {availableModels.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noModelsHint')}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedNames].map((name) => {
                const m = availableModels.find((x) => x.name === name) || { name, type: 'chat' };
                const isImage = m.type === 'image';
                const typeTitle = isImage
                  ? t('contribute.modelTypeImage')
                  : m.type === 'vision'
                    ? t('contribute.modelTypeVision')
                    : t('contribute.modelTypeText');
                return (
                  // 仅 × 可移除；类型用 title，避免「对话」角标抢视觉
                  <span
                    key={name}
                    title={typeTitle}
                    className={`tb-tag pl-2.5 pr-0.5 py-1 text-xs font-mono ${
                      isImage ? 'tb-tag-purple' : 'tb-tag-blue'
                    }`}
                  >
                    <TruncTip as="span" title={name} className="max-w-[14rem]">{name}</TruncTip>
                    <button
                      type="button"
                      title={t('contribute.removeModel')}
                      aria-label={t('contribute.removeModel')}
                      onClick={() => toggleModel(name)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded-md text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowModelPicker((v) => !v)}
                className={`tb-tag tb-tag-muted border-dashed justify-center min-w-[2rem] h-7 px-2 text-sm font-medium cursor-pointer ${
                  showModelPicker ? '!border-solid !bg-white/75 dark:!bg-zinc-700/80 !text-zinc-900 dark:!text-zinc-100' : ''
                }`}
                title={t('contribute.addModel')}
                aria-label={t('contribute.addModel')}
                aria-expanded={showModelPicker}
              >
                +
              </button>
            </div>
            {selectedNames.size === 0 && !showModelPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addModelHint')}</p>
            )}
            {showModelPicker && (
              <div className="tb-soft-card rounded-xl p-3 space-y-2 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">{t('contribute.pickModelHint')}</p>
                  <button
                    type="button"
                    onClick={() => setShowModelPicker(false)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    {t('contribute.closePicker')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableModels
                    .filter((m) => !selectedNames.has(m.name))
                    .map((m) => {
                      const isImage = m.type === 'image';
                      return (
                        <button
                          key={m.name}
                          type="button"
                          title={isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                          onClick={() => toggleModel(m.name)}
                          className="tb-tag tb-tag-muted px-2.5 py-1 text-xs font-mono cursor-pointer"
                        >
                          {m.name}
                        </button>
                      );
                    })}
                  {availableModels.every((m) => selectedNames.has(m.name)) && (
                    <p className="text-[11px] text-zinc-400">{t('contribute.allModelsAdded')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 贡献智能体：默认只展示已选；点 + 添加（须已投射） */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{t('contribute.assistants')}</span>
          {selectedAssistantIds.size > 0 && (
            <span className="text-[11px] text-zinc-400">
              {t('contribute.assistantsSelected', { n: selectedAssistantIds.size })}
            </span>
          )}
        </div>
        {availableAssistants.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noAssistantsHint')}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedAssistantIds].map((id) => {
                const a = availableAssistants.find((x) => x.id === id);
                const label = a ? (a.display_name || a.name) : id;
                const reason = a ? assistantDisabledReason(a) : '';
                return (
                  // 仅操作按钮可点；避免点 chip 本体误删
                  <span
                    key={id}
                    title={reason || a?.description || undefined}
                    className="tb-tag tb-tag-amber pl-2.5 pr-0.5 py-0.5 text-xs"
                  >
                    <TruncTip as="span" title={label} className="max-w-[14rem]">{label}</TruncTip>
                    {reason && <span className="text-[10px] opacity-80">· {reason}</span>}
                    <button
                      type="button"
                      title={t('contribute.copyWebLink')}
                      aria-label={t('contribute.copyWebLink')}
                      onClick={() => copyAssistantWebLink(id)}
                      className="ml-0.5 px-1.5 h-5 inline-flex items-center justify-center rounded-md text-[10px] text-current/70 hover:text-current hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      {copiedAssistantId === id ? t('contribute.webLinkCopied') : t('contribute.webLink')}
                    </button>
                    <button
                      type="button"
                      title={t('contribute.removeAssistant')}
                      aria-label={t('contribute.removeAssistant')}
                      onClick={() => toggleAssistant(id)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded-md text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowAssistantPicker((v) => !v)}
                className={`tb-tag tb-tag-muted border-dashed justify-center min-w-[2rem] h-7 px-2 text-sm font-medium cursor-pointer ${
                  showAssistantPicker ? '!border-solid !bg-white/75 dark:!bg-zinc-700/80 !text-zinc-900 dark:!text-zinc-100' : ''
                }`}
                title={t('contribute.addAssistant')}
                aria-label={t('contribute.addAssistant')}
                aria-expanded={showAssistantPicker}
              >
                +
              </button>
            </div>
            {selectedAssistantIds.size === 0 && !showAssistantPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addAssistantHint')}</p>
            )}
            {showAssistantPicker && (
              <div className="tb-soft-card rounded-xl p-3 space-y-2 max-h-56 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">
                    {assistantPickerBusy
                      ? t('contribute.pickAssistantRefreshing')
                      : t('contribute.pickAssistantHint')}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={assistantPickerBusy}
                      onClick={() => {
                        setAssistantPickerBusy(true);
                        refreshAssistants().finally(() => setAssistantPickerBusy(false));
                      }}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40"
                    >
                      {t('contribute.refreshAssistants')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAssistantPicker(false)}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    >
                      {t('contribute.closePicker')}
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableAssistants
                    .filter((a) => !selectedAssistantIds.has(a.id))
                    .map((a) => {
                      const reason = assistantDisabledReason(a);
                      const label = a.display_name || a.name;
                      if (reason) {
                        return (
                          <span
                            key={a.id}
                            title={reason}
                            className="tb-tag tb-tag-muted px-2.5 py-1 text-xs opacity-55 cursor-not-allowed"
                          >
                            {label}
                            <span className="ml-1 text-[10px] opacity-80">· {reason}</span>
                          </span>
                        );
                      }
                      return (
                        <button
                          key={a.id}
                          type="button"
                          title={a.description || a.name}
                          onClick={() => toggleAssistant(a.id)}
                          className="tb-tag tb-tag-muted px-2.5 py-1 text-xs cursor-pointer"
                        >
                          {label}
                        </button>
                      );
                    })}
                  {availableAssistants.filter((a) => !selectedAssistantIds.has(a.id) && !assistantDisabledReason(a)).length === 0 && (
                    <p className="text-[11px] text-zinc-400 w-full">{t('contribute.noAddableAssistants')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">{t('contribute.nodeName')}</label>
          <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder={t('contribute.nodeNamePh')}
            className="tb-soft-field w-full text-xs px-3 py-2 rounded-lg text-zinc-900 dark:text-zinc-100" />
        </div>
        {/* 供给范围：分段选择代替原生单选 */}
        <div>
          <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">{t('contribute.scope')}</p>
          <div role="radiogroup" aria-label={t('contribute.scope')} className="inline-flex p-0.5 rounded-lg bg-zinc-100/90 dark:bg-zinc-800/80">
            {[['public', t('contribute.scopePublic')], ['circle', t('contribute.scopeCircle')]].map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={circleScope === v} onClick={() => setCircleScope(v)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  circleScope === v
                    ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-50 shadow-sm font-medium'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {circleScope === 'circle' && (
        <div className="space-y-2 -mt-1">
          {circles.length === 0
            ? (
              <p className="text-xs text-zinc-400">
                {t('contribute.noCircle')}
                {onManageCircles && (
                  <button type="button" onClick={onManageCircles} className="ml-1.5 text-blue-600 dark:text-blue-400 hover:underline">
                    {t('contribute.createCircleLink')}
                  </button>
                )}
              </p>
            )
            : (
              <div className="flex flex-wrap items-center gap-1.5">
                {circles.map(c => {
                  const sel = selectedCircleIds.has(c.id);
                  return (
                    <button key={c.id} type="button" onClick={() => toggleCircle(c.id)} aria-pressed={sel}
                      className={`tb-tag px-2.5 py-1 text-xs cursor-pointer ${sel ? 'tb-tag-blue' : 'tb-tag-muted !border-solid'}`}>
                      {sel ? '✓ ' : ''}{c.name}
                    </button>
                  );
                })}
              </div>
            )}
          <p className="text-[11px] text-zinc-400">{t('contribute.scopeHint')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-zinc-100 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="tb-press text-xs font-medium px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? t('contribute.savingAndStarting') : (running ? t('contribute.saveAndApply') : t('contribute.saveAndStart'))}
        </button>
        {running && (
          <button
            type="button"
            onClick={() => {
              // 停止会下线算力，二次确认避免误触
              if (typeof window !== 'undefined' && !window.confirm(t('contribute.stopConfirm'))) return;
              onStop?.();
            }}
            className="text-xs px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            {t('contribute.stop')}
          </button>
        )}
        <label className="ml-auto flex items-center gap-2 select-none cursor-pointer">
          <button
            type="button"
            role="switch"
            aria-checked={autoStart}
            aria-label={t('contribute.autoStart')}
            onClick={() => setAutoStart((v) => !v)}
            className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              autoStart ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
            }`}
          >
            <span className={`absolute top-[2px] left-0 w-[14px] h-[14px] bg-white rounded-full shadow transition-transform duration-200 ${
              autoStart ? 'translate-x-[16px]' : 'translate-x-[2px]'
            }`} />
          </button>
          <span className="text-xs text-zinc-600 dark:text-zinc-300">{t('contribute.autoStart')}</span>
        </label>
      </div>
    </div>
  );
}

/** 拆分智能体名与所有者（去掉「昵称的」前缀；展示为 owner/name 以区分同名） */
function parseCommunityAgent(a) {
  let owner = String(a?.owner_nickname || '').trim();
  const raw = String(a?.display_name || a?.name || '').trim();
  let name = raw;
  if (owner) {
    const prefix = `${owner}的`;
    if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  } else {
    const m = raw.match(/^(.+?)的(.+)$/);
    if (m && m[2]) {
      owner = m[1].trim();
      name = m[2].trim();
    }
  }
  name = name || String(a?.name || '').trim() || a?.id || '智能体';
  return { name, owner };
}

/** @deprecated 兼容旧调用：仅返回智能体名 */
function communityAgentTitle(a) {
  return parseCommunityAgent(a).name;
}

/** 社区智能体卡片左侧图标：按名称着色 + 首字，辅以简易智能体符号 */
function CommunityAgentIcon({ name, selected, small = false }) {
  const label = String(name || '?').trim() || '?';
  const initial = label[0].toUpperCase();
  return (
    <div
      className={`relative ${small ? 'w-9 h-9 rounded-xl text-sm' : 'w-11 h-11 rounded-2xl text-base'} shrink-0 flex items-center justify-center text-white font-semibold shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${avatarColor(label)} ${
        selected ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''
      }`}
      aria-hidden
    >
      {/* 右下角小符号，区分「智能体」而非用户头像 */}
      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-md bg-white dark:bg-zinc-900 flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-zinc-600 dark:text-zinc-300" fill="currentColor">
          <path d="M8 1.5a1 1 0 0 1 1 1V4h1.5a2 2 0 0 1 2 2v1H14a1 1 0 1 1 0 2h-1.5v1a2 2 0 0 1-2 2H9v1.5a1 1 0 1 1-2 0V12H5.5a2 2 0 0 1-2-2v-1H2a1 1 0 1 1 0-2h1.5V6a2 2 0 0 1 2-2H7V2.5a1 1 0 0 1 1-1zM5.5 6v4h5V6h-5z" />
        </svg>
      </span>
      {initial}
    </div>
  );
}

/** 社区智能体：浏览在线名片 → 雇佣/取消雇佣（供游乐场与 MCP；此处不发起任务） */
function CommunityAgentsCard({ refreshKey = 0, circles = [], scope = 'all', onScopeChange, focusAgent = null }) {
  const { t } = useLang();
  const location = useLocation();
  const [agents, setAgents] = useState([]);
  const [hiredIds, setHiredIds] = useState(new Set());
  const [credits, setCredits] = useState(null);
  const [selected, setSelected] = useState(null); // { id, worker_id, display_name, runtime, description }
  const [hireMsg, setHireMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''); // '' | 'hire' | 'unhire'
  const [query, setQuery] = useState('');
  // 行内「雇佣」：先选中再在下一帧执行（hireSelected 读取 selected）
  const [pendingHire, setPendingHire] = useState(null);
  // KeepAlive 下用 pathname 判断是否在交易页（再次进入需立刻刷新）
  const pageActive = location.pathname === '/contribute';
  const refreshRef = useRef(null);

  function refreshHired() {
    if (!window.electronAPI?.agent?.listHiredCommunity) return;
    window.electronAPI.agent.listHiredCommunity()
      .then((r) => {
        const ids = new Set((r?.hired || []).map((h) => h.assistant_id));
        setHiredIds(ids);
      })
      .catch(() => {});
  }

  /** @param {{ quiet?: boolean }} [opts] quiet=true 时不闪 skeleton（定时/事件刷新） */
  async function refresh(opts = {}) {
    const quiet = !!opts.quiet;
    if (!quiet) setLoading(true);
    try {
      try {
        const r = await listCommunityAgents();
        setAgents(r.data?.agents || []);
        if (r.data?.credits_per_task != null) setCredits(r.data.credits_per_task);
      } catch {
        // 未登录或鉴权失败时回退公开列表
        try {
          const r = await listPublicCommunityAgents();
          setAgents(r.data?.agents || []);
        } catch {
          setAgents([]);
        }
      }
    } finally {
      if (!quiet) setLoading(false);
    }
    refreshHired();
  }
  refreshRef.current = refresh;

  // 进入交易页立即刷新（无定时轮询）
  useEffect(() => {
    if (!pageActive) return;
    refresh({ quiet: agents.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随页面可见性触发
  }, [pageActive]);

  // 保存/停止：立刻刷一次，再于 0.8s、2s 补刷（等节点重连上报名片）
  useEffect(() => {
    if (!refreshKey) return undefined;
    let cancelled = false;
    (async () => {
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 800));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 1200));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  async function hireSelected() {
    if (!selected || busy) return;
    setErr('');
    setHireMsg('');
    setBusy('hire');
    try {
      if (!window.electronAPI?.agent?.hireCommunity) {
        throw new Error('请在桌面客户端中雇佣');
      }
      const r = await window.electronAPI.agent.hireCommunity({
        assistant_id: selected.id,
        worker_id: selected.worker_id,
        display_name: selected.display_name,
        runtime: selected.runtime,
        description: selected.description,
      });
      if (!r?.success) throw new Error(r?.error || 'hire failed');
      setHireMsg(t('contribute.hiredOk', { name: selected.display_name || selected.id, id: r.hired?.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  async function unhireSelected() {
    if (!selected || busy) return;
    setErr('');
    setHireMsg('');
    setBusy('unhire');
    try {
      if (!window.electronAPI?.agent?.unhireCommunity) {
        throw new Error('请在桌面客户端中操作');
      }
      const r = await window.electronAPI.agent.unhireCommunity(selected.id);
      if (!r?.success) throw new Error(r?.error || 'unhire failed');
      setHireMsg(t('contribute.unhiredOk', { name: selected.display_name || selected.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  const selectedHired = selected && hiredIds.has(selected.id);

  // 从圈子详情 / 社区网络跳来：定位并展开该智能体
  useEffect(() => {
    if (focusAgent?.query) setQuery(focusAgent.query);
  }, [focusAgent]);

  useEffect(() => {
    if (!focusAgent?.id || !agents.length) return;
    const a = agents.find(x => x.id === focusAgent.id);
    if (!a) return;
    // 目标不在当前范围内时回到「全部」，避免选中了却看不到
    if (!inScope(a)) onScopeChange?.('all');
    selectAgent(a, { toggle: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随跳转目标 / 列表就绪触发
  }, [focusAgent, agents]);

  useEffect(() => {
    if (!pendingHire || !selected || selected.id !== pendingHire.id) return;
    setPendingHire(null);
    hireSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在选中目标就绪时触发一次
  }, [pendingHire, selected]);
  const hireBannerRef = useRef(null);

  // 雇佣结果横幅：数秒后自动收起
  useEffect(() => {
    if (!hireMsg) return undefined;
    hireBannerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    const id = setTimeout(() => setHireMsg(''), 5000);
    return () => clearTimeout(id);
  }, [hireMsg]);

  function selectAgent(a, { toggle = true } = {}) {
    const { name: title, owner } = parseCommunityAgent(a);
    const same = selected && selected.id === a.id && selected.worker_id === a.worker_id;
    setSelected(same && toggle ? null : {
      id: a.id,
      worker_id: a.worker_id,
      display_name: title,
      runtime: a.runtime,
      description: a.description,
      owner_nickname: owner || a.owner_nickname,
    });
  }

  const circleName = (cid) => circles.find(c => c.id === cid)?.name || '';
  const inScope = (a) => {
    if (scope === 'all') return true;
    const isCircle = (a.visibility || 'public') !== 'public';
    if (scope === 'public') return !isCircle;
    // 旧服务端未返回 circle_ids 时，圈内项一律归入任意圈子
    if (!Array.isArray(a.circle_ids)) return isCircle;
    return a.circle_ids.includes(scope);
  };
  const q = query.trim().toLowerCase();
  const scoped = agents.filter(inScope);
  const shown = !q ? scoped : scoped.filter((a) => {
    const { name, owner } = parseCommunityAgent(a);
    return [name, owner, a.runtime, a.description].some(v => String(v || '').toLowerCase().includes(q));
  });
  const selectedFull = selected
    ? (selected.owner_nickname ? `${selected.owner_nickname}/${selected.display_name || selected.id}` : (selected.display_name || selected.id))
    : '';

  const scopeOptions = [
    { id: 'all', label: t('contribute.scope.all') },
    { id: 'public', label: t('contribute.scope.public') },
    ...circles.map(c => ({ id: c.id, label: c.name, circle: true })),
  ];

  return (
    <div className="space-y-3">
      {/* 交易范围：公开市场 / 我的圈子（圈子即交易范围） */}
      {circles.length > 0 && (
        <div role="radiogroup" aria-label={t('contribute.scope.label')} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-zinc-400 mr-1">{t('contribute.scope.label')}</span>
          {scopeOptions.map(o => {
            const on = scope === o.id;
            const n = agents.filter(a => {
              if (o.id === 'all') return true;
              const isCircle = (a.visibility || 'public') !== 'public';
              if (o.id === 'public') return !isCircle;
              return Array.isArray(a.circle_ids) ? a.circle_ids.includes(o.id) : isCircle;
            }).length;
            return (
              <button key={o.id} type="button" role="radio" aria-checked={on} onClick={() => onScopeChange?.(o.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  on
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white/70 dark:hover:bg-zinc-800'
                }`}>
                {o.circle && <span className="mr-1 opacity-60" aria-hidden>◎</span>}
                {o.label}
                <span className={`ml-1 tabular-nums ${on ? 'opacity-70' : 'text-zinc-400'}`}>{n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" aria-hidden>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
          </span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('contribute.searchAgents')}
            className="tb-soft-field w-full text-xs pl-8 pr-3 py-1.5 rounded-lg text-zinc-900 dark:text-zinc-100"
          />
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 flex-1 min-w-[12rem]">
          {t('contribute.communityAgentsHint')}
          {credits != null && <span className="ml-1.5 text-zinc-400">· {t('contribute.agentTaskCost', { n: credits })}</span>}
        </p>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 px-2 py-1 rounded-md hover:bg-white/70 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          {t('contribute.refreshAgents')}
        </button>
      </div>
      {hireMsg && (
        <div
          ref={hireBannerRef}
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 dark:border-green-800/60 bg-green-50 dark:bg-green-950/40 px-3 py-2"
        >
          <p className="flex-1 text-xs text-green-800 dark:text-green-300 leading-snug">{hireMsg}</p>
          <button type="button" onClick={() => setHireMsg('')}
            className="shrink-0 text-xs text-green-700/70 dark:text-green-400/70 hover:text-green-900 dark:hover:text-green-200"
            aria-label={t('contribute.hireFeedbackDismiss')}>×</button>
        </div>
      )}
      {err && <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap" role="alert">{err}</p>}

      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className={`${LIB_LIST_CLS} divide-y divide-zinc-100/90 dark:divide-white/[0.05]`} aria-busy="true" aria-label={t('contribute.agentsLoading')}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
                  <div className="w-9 h-9 rounded-xl bg-zinc-200/80 dark:bg-zinc-700/80" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-40 rounded bg-zinc-200/80 dark:bg-zinc-700/80" />
                    <div className="h-2.5 w-72 rounded bg-zinc-200/60 dark:bg-zinc-700/60" />
                  </div>
                </div>
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className={`${LIB_LIST_CLS} px-4 py-10 text-center text-xs text-zinc-500 dark:text-zinc-400`}>
              {q ? t('contribute.noAgentsMatch') : t('contribute.noCommunityAgents')}
            </div>
          ) : (
            <ul className={LIB_LIST_CLS} role="listbox" aria-label={t('contribute.communityAgents')}>
              {shown.map((a) => {
                const key = `${a.worker_id}:${a.id}`;
                const sel = !!selected && selected.id === a.id && selected.worker_id === a.worker_id;
                const hired = hiredIds.has(a.id);
                const { name: title, owner } = parseCommunityAgent(a);
                const blurb = String(a.description || '').trim();
                return (
                  <li
                    key={key}
                    role="option"
                    aria-selected={sel}
                    tabIndex={0}
                    onClick={() => selectAgent(a)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAgent(a); } }}
                    className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_7rem_5rem]`}
                  >
                    <LibraryRowTitle
                      logo={<CommunityAgentIcon name={title} small />}
                      name={owner ? (
                        <>
                          <span className="text-zinc-400 dark:text-zinc-500 font-normal">{owner}</span>
                          <span className="text-zinc-300 dark:text-zinc-600 mx-0.5">/</span>
                          {title}
                        </>
                      ) : title}
                      chips={(
                        <>
                          {(a.visibility || 'public') !== 'public' && (
                            <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                              ◎ {(a.circle_ids || []).map(circleName).filter(Boolean)[0] || t('contribute.scope.circleTag')}
                              {(a.circle_ids || []).length > 1 ? ` +${a.circle_ids.length - 1}` : ''}
                            </span>
                          )}
                          {hired && (
                            <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300">
                              {t('contribute.hiredBadge')}
                            </span>
                          )}
                        </>
                      )}
                      sub={blurb || t('contribute.noAgentDesc')}
                      subClass={blurb ? undefined : 'text-zinc-400 dark:text-zinc-500 italic'}
                    />
                    <div className="hidden md:block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{a.runtime || '—'}</div>
                    <div className="flex justify-end md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                      {!hired && (
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => { selectAgent(a, { toggle: false }); setPendingHire(a); }}
                          className="tb-press whitespace-nowrap text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-45"
                        >
                          {t('contribute.hireShort')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {selected && (
          <LibraryInspector
            logo={<CommunityAgentIcon name={selected.display_name || selected.id} />}
            title={selectedFull}
            chips={selectedHired ? (
              <span className="text-[10px] px-1.5 py-px rounded font-medium bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300">{t('contribute.hiredBadge')}</span>
            ) : null}
            desc={String(selected.description || '').trim() || t('contribute.noAgentDesc')}
            stats={[
              [t('contribute.col.runtime'), selected.runtime || '—'],
              [t('contribute.col.cost'), credits != null ? t('contribute.creditsN', { n: credits }) : '—'],
            ]}
            onClose={() => setSelected(null)}
            closeLabel={t('circles.inviteClose')}
            footer={(
              <>
                <button
                  type="button"
                  onClick={hireSelected}
                  disabled={!!busy}
                  className="tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {busy === 'hire' ? t('contribute.hiring') : (selectedHired ? t('contribute.hiredAgain') : t('contribute.hireBtn'))}
                </button>
                {selectedHired && (
                  <button
                    type="button"
                    onClick={unhireSelected}
                    disabled={!!busy}
                    className="text-xs px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {busy === 'unhire' ? t('contribute.unhiring') : t('contribute.unhireBtn')}
                  </button>
                )}
              </>
            )}
          >
            <InspectorSection title={t('contribute.hireHowTitle')}>
              <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('contribute.hireHint')}</p>
            </InspectorSection>
          </LibraryInspector>
        )}
      </div>
    </div>
  );
}

export default function Contribute() {
  const { t, lang } = useLang();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [chartData,   setChartData]   = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [summary,     setSummary]     = useState(null);
  const [logs,        setLogs]        = useState([]);
  const [agentError,  setAgentError]  = useState('');
  const [agentsRefreshKey, setAgentsRefreshKey] = useState(0);
  const logRef = useRef(null);
  const location = useLocation();
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('tokenbank.trade.tab') || 'hire'; } catch { return 'hire'; }
  });
  // 圈子 = 交易范围：共享给雇佣筛选、上架范围、圈子管理
  const [myCircles, setMyCircles] = useState(null);
  const [scope, setScope] = useState('all');
  const [focusAgent, setFocusAgent] = useState(null);
  const [circlesView, setCirclesView] = useState('mine');
  const [circleResult, setCircleResult] = useState(null);

  useEffect(() => {
    Promise.all([listMyCircles(), listJoinedCircles()])
      .then(([o, j]) => setMyCircles(uniqueCircles([...(o.data?.circles || []), ...(j.data?.circles || [])])))
      .catch(() => setMyCircles([]));
  }, []);

  // 跨页跳转（圈子详情 / 社区网络 / 邀请链接 / 旧 /circles 路由）带来的定位
  useEffect(() => {
    if (location.pathname !== '/contribute') return;
    const st = location.state || {};
    if (st.tradeTab) changeTab(st.tradeTab);
    if (st.scope != null) setScope(st.scope);
    if (st.focusAgent) setFocusAgent({ id: st.focusAgent, at: Date.now() });
    if (st.agentQuery) setFocusAgent({ query: st.agentQuery, at: Date.now() });
    if (st.circlesView) setCirclesView(st.circlesView);
    if (st.circleResult) setCircleResult({ ...st.circleResult, at: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每次导航触发一次
  }, [location.key]);
  function changeTab(id) {
    setTab(id);
    try { localStorage.setItem('tokenbank.trade.tab', id); } catch { /* ignore */ }
  }

  /** 触发社区智能体列表刷新（保存/停止后） */
  function bumpAgentsRefresh() {
    setAgentsRefreshKey((k) => k + 1);
  }

  useEffect(() => {
    const unsub = subscribeAgentEvents({
      onStatus: ({ running: r, error }) => {
        setRunning(r);
        if (error) setLogs(prev => [...prev.slice(-199), `[error] ${error}`]);
      },
      onLog: (line) => setLogs(prev => [...prev.slice(-199), line.trimEnd()]),
    });
    if (unsub) {
      getAgentStatus().then(({ running: r }) => setRunning(r));
      getAgentLogs().then(lines => {
        if (lines?.length) setLogs(lines.map(l => String(l).trimEnd()));
      });
      return unsub;
    }

    // Docker / CLI：轮询 admin-api
    if (!useAgentPolling()) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const st = await getAgentStatus();
        if (cancelled) return;
        setRunning(!!st.running);
        const lines = await getAgentLogs();
        if (!cancelled && lines.length) setLogs(lines.map(l => String(l).trimEnd()));
      } catch {}
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  useEffect(() => {
    function poll() {
      getStats().then(r => {
        setStats(r.data);
        const locale = lang === 'en' ? 'en-US' : 'zh-CN';
        const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setChartData(prev => [...prev.slice(-29), { time, value: r.data.contribute_req_per_min ?? 0 }]);
      }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [lang]);

  useEffect(() => {
    function loadSummary() {
      getContributeSummary().then(r => setSummary(r.data)).catch(() => {});
    }
    loadSummary();
    const id = setInterval(loadSummary, 30000);
    return () => clearInterval(id);
  }, []);

  // KeepAlive 下只挂载一次：登录就绪后拉取，并定时刷新，避免首次失败后一直「暂无」
  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    function loadSettlements() {
      getSettlements()
        .then((r) => {
          if (cancelled) return;
          setSettlements((r.data?.settlements || []).slice(0, 10));
        })
        .catch((e) => {
          console.warn('[contribute] settlements load failed', e?.message || e);
        });
    }
    loadSettlements();
    const id = setInterval(loadSettlements, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user?.id]);

  async function handleStart() {
    setAgentError('');
    try {
      await startAgent();
      const st = await getAgentStatus();
      setRunning(!!st.running);
      const lines = await getAgentLogs();
      if (lines.length) setLogs(lines.map(l => String(l).trimEnd()));
      return true;
    } catch (e) {
      setAgentError(e.message || String(e));
      return false;
    }
  }

  async function handleStop() {
    setAgentError('');
    try {
      await stopAgent();
      setRunning(false);
      // 停止后刷新社区智能体（本机名片应尽快消失）
      bumpAgentsRefresh();
    } catch (e) {
      setAgentError(e.message || String(e));
    }
  }

  const kpis = [
    {
      k: 'tokens', label: t('contribute.totalTokens'),
      value: summary ? fmtContribTokens(summary.contrib_tokens) : '—',
      sub: summary?.period_tokens > 0 ? t('contribute.periodTokens', { n: fmtContribTokens(summary.period_tokens) }) : t('contribute.totalTokensHint'),
    },
    {
      k: 'credits', label: t('contribute.earnedCredits'), tone: 'text-green-600 dark:text-green-400',
      value: summary ? `+${(summary.contrib_credits ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}` : '—',
      sub: summary ? t('contribute.approxCny', { amount: fmtCreditCny(summary.contrib_cny) }) : '',
    },
    {
      k: 'saved', label: t('contribute.savedMoney'), tone: 'text-emerald-600 dark:text-emerald-400',
      value: summary ? fmtCreditCny(summary.saved_cny) : '—',
      sub: summary?.p2p_tokens > 0 ? t('contribute.p2pTokensUsed', { n: fmtContribTokens(summary.p2p_tokens) }) : t('contribute.savedHint'),
    },
    {
      k: 'rate', label: t('contribute.rate'),
      value: stats ? `${stats.contribute_req_per_min ?? 0}` : '—', unit: 'req/min',
      sub: stats ? t('contribute.liveSub', { active: stats.active_requests ?? 0, nodes: stats.active_workers ?? 0 }) : '',
    },
  ];

  const TABS = [
    { id: 'hire', label: t('contribute.tab.hire') },
    { id: 'supply', label: t('contribute.tab.supply') },
    { id: 'circles', label: t('contribute.tab.circles'), count: myCircles?.length || null },
    { id: 'earnings', label: t('contribute.tab.earnings'), count: settlements.length || null },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="shrink-0 px-5 pt-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('contribute.title')}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('contribute.subtitle')}</p>
          </div>
          <div className="electron-no-drag relative z-50 flex items-center gap-2">
            {/* 供给状态：一眼可见，点击直达上架配置 */}
            <button
              type="button"
              onClick={() => changeTab('supply')}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                running
                  ? 'border-green-200 dark:border-green-900 bg-green-50/80 dark:bg-green-950/30 text-green-700 dark:text-green-300'
                  : 'border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <span className="relative flex w-2 h-2" aria-hidden>
                {running && <span className="absolute inline-flex w-full h-full rounded-full bg-green-400 opacity-60 animate-ping" />}
                <span className={`relative inline-flex w-2 h-2 rounded-full ${running ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
              </span>
              {running ? t('contribute.statusSupplying') : t('contribute.statusIdle')}
            </button>
            <button
              type="button"
              onClick={() => navigate('/network')}
              className="text-xs px-2.5 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-white/70 dark:hover:bg-zinc-800"
            >
              {t('providers.p2p.globalNetwork')}
            </button>
          </div>
        </div>

        {/* 收益概览：一条 KPI 带，取代三张大卡 + 三张小卡 */}
        <div className={`${LIB_LIST_CLS} mt-4 grid grid-cols-2 md:grid-cols-4`}>
          {kpis.map((m, i) => (
            <div key={m.k} className={`px-4 py-3 min-w-0 ${i ? 'md:border-l' : ''} ${i % 2 ? 'border-l md:border-l' : ''} ${i >= 2 ? 'border-t md:border-t-0' : ''} border-zinc-100 dark:border-white/[0.06]`}>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{m.label}</div>
              <div className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${m.tone || 'text-zinc-900 dark:text-zinc-50'}`}>
                {m.value}
                {m.unit && <span className="ml-1 text-[11px] font-normal text-zinc-400">{m.unit}</span>}
              </div>
              {m.sub && <div className="text-[11px] text-zinc-400 truncate mt-0.5">{m.sub}</div>}
            </div>
          ))}
        </div>

        <div role="tablist" className="mt-4 flex items-end gap-6 border-b border-zinc-200/80 dark:border-white/[0.08]">
          {TABS.map(tb => (
            <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id} onClick={() => changeTab(tb.id)}
              className={`-mb-px pb-2.5 text-[13px] border-b-2 transition-colors ${
                tab === tb.id
                  ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-50 font-semibold'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}>
              {tb.label}
              {tb.count > 0 && <span className="ml-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">{tb.count}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {/* 三个页签常驻挂载：切换不丢未保存的上架配置 */}
        <div className={tab === 'hire' ? '' : 'hidden'}>
          <CommunityAgentsCard
            refreshKey={agentsRefreshKey}
            circles={myCircles || []}
            scope={scope}
            onScopeChange={setScope}
            focusAgent={focusAgent}
          />
        </div>

        <div className={tab === 'supply' ? 'space-y-2' : 'hidden'}>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('contribute.sectionSupplyHint')}</p>
          <ContributionConfigCard
            onStart={handleStart}
            onStop={handleStop}
            running={running}
            agentError={agentError}
            onAgentsRefresh={bumpAgentsRefresh}
            circles={myCircles}
            onManageCircles={() => changeTab('circles')}
          />
        </div>

        <div className={tab === 'circles' ? '' : 'hidden'}>
          <Circles view={circlesView} circleResult={circleResult} onChanged={setMyCircles} />
        </div>

        <div className={tab === 'earnings' ? 'space-y-4' : 'hidden'}>
          <div className={`${LIB_LIST_CLS} p-4`}>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-3">{t('contribute.chartTitle')}</p>
            <RateChart data={chartData} />
          </div>

          <section>
            <LibrarySectionHead title={t('contribute.settlements')} count={settlements.length || null} />
            {settlements.length === 0 ? (
              <div className={`${LIB_LIST_CLS} px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-400`}>{t('contribute.noSettlements')}</div>
            ) : (
              <ul className={LIB_LIST_CLS}>
                <li className="hidden md:grid grid-cols-[8.5rem_6rem_minmax(0,1fr)_6rem_5rem] gap-3 px-4 py-2 text-[11px] text-zinc-400 border-b border-zinc-100/90 dark:border-white/[0.05]">
                  <span>{t('contribute.col.period')}</span>
                  <span className="text-right">{t('contribute.col.tokens')}</span>
                  <span>{t('contribute.col.resources')}</span>
                  <span className="text-right">{t('contribute.col.credits')}</span>
                  <span className="text-right">{t('contribute.col.cny')}</span>
                </li>
                {settlements.map(st => {
                  const resources = normalizeSettlementResources(st.resources);
                  const resHint = resources.map((r) => formatSettlementResource(r)).join('、');
                  const mult = st.multiplier ?? 1;
                  const qualityLabel = t('contribute.qualityMult', { n: mult.toFixed(2) });
                  return (
                    <li key={st.id ?? st.period_end}
                      className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[8.5rem_6rem_minmax(0,1fr)_6rem_5rem] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-xs border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05]">
                      <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">{formatSettlementTime(st.period_end)}</span>
                      <span className="text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtContribTokens(st.output_tokens ?? 0)} tok</span>
                      <span className="col-span-2 md:col-span-1 min-w-0 truncate text-zinc-500 dark:text-zinc-400" title={resHint}>
                        <span className="text-yellow-600 dark:text-yellow-400 mr-1.5" title={qualityLabel} aria-label={qualityLabel}>
                          {multiplierToStars(mult)}<span className="ml-1 text-zinc-400 tabular-nums">{mult.toFixed(2)}×</span>
                        </span>
                        {resHint}
                      </span>
                      <span className="text-right tabular-nums font-medium text-green-600 dark:text-green-400">+{(st.credits_awarded ?? 0).toFixed(1)}</span>
                      <span className="text-right tabular-nums text-zinc-400">≈{fmtCreditCny(creditsToCny(st.credits_awarded))}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* 运行日志：排障用，默认收起 */}
          <details className="group">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 list-none">
              <span className="inline-block transition-transform group-open:rotate-90 mr-1">›</span>
              {t('contribute.agentLog')}
              {logs.length > 0 && <span className="ml-1.5 text-zinc-400 tabular-nums">{logs.length}</span>}
            </summary>
            <div ref={logRef} className="mt-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 h-40 overflow-y-auto font-mono text-[11px] text-zinc-600 dark:text-zinc-400 space-y-0.5">
              {logs.length === 0 ? <span className="text-zinc-500 dark:text-zinc-400">{t('contribute.logEmpty')}</span> : logs.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
