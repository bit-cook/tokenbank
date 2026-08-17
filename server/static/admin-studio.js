/** Admin 社区圈内容：预定义场景 / 预定义插件（owner_id NULL）。管理员可见 content 原文。 */
window.initStudioAdmin = function (api, lang, ref) {
  const zh = lang === 'zh'
  const communitySub = ref('catalog')   // catalog | scenes | mods

  // ── 场景 ──
  const stScenes = ref([])
  const stSceneMsg = ref('')
  const stSceneOpen = ref(false)
  const stSceneForm = ref(emptyScene())
  function emptyScene() {
    return { id: null, name: '', icon: '🎭', intro: '', category: '', default_model: '', persona: '', greeting: '' }
  }
  async function fetchStudioScenes() {
    try { const d = await (await api('/admin/studio/scenes')).json(); stScenes.value = d.scenes || [] }
    catch (e) { stSceneMsg.value = e.message }
  }
  function openScene(s) {
    stSceneMsg.value = ''
    stSceneForm.value = s ? { ...emptyScene(), ...s } : emptyScene()
    stSceneOpen.value = true
  }
  async function saveScene() {
    const f = stSceneForm.value
    if (!f.name.trim()) { stSceneMsg.value = zh ? '场景名不能为空' : 'Name required'; return }
    const path = f.id ? `/admin/studio/scenes/${f.id}` : '/admin/studio/scenes'
    const method = f.id ? 'PUT' : 'POST'
    try {
      const r = await api(path, { method, body: JSON.stringify(f) })
      if (!r.ok) { stSceneMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      stSceneOpen.value = false; await fetchStudioScenes()
    } catch (e) { stSceneMsg.value = e.message }
  }
  async function delScene(s) {
    if (!confirm(zh ? `删除场景「${s.name}」？` : `Delete scene?`)) return
    try { await api(`/admin/studio/scenes/${s.id}`, { method: 'DELETE' }); await fetchStudioScenes() } catch {}
  }

  // ── 插件 ──
  const stMods = ref([])
  const stModMsg = ref('')
  const stModOpen = ref(false)
  const stModForm = ref(emptyMod())
  function emptyMod() {
    return { id: null, name: '', intro: '', contentText: '', price: 0, trigger: 'always', trigger_keywords: '' }
  }
  async function fetchStudioMods() {
    try { const d = await (await api('/admin/studio/mods')).json(); stMods.value = d.mods || [] }
    catch (e) { stModMsg.value = e.message }
  }
  function _parseContentText(content) {
    try { const o = typeof content === 'string' ? JSON.parse(content || '{}') : (content || {}); return o.text || '' }
    catch { return typeof content === 'string' ? content : '' }
  }
  function openMod(m) {
    stModMsg.value = ''
    if (m) {
      stModForm.value = {
        id: m.id, name: m.name || '', intro: m.intro || '',
        contentText: _parseContentText(m.content), price: m.price || 0,
        trigger: m.trigger || 'always', trigger_keywords: m.trigger_keywords || '',
      }
    } else stModForm.value = emptyMod()
    stModOpen.value = true
  }
  async function saveMod() {
    const f = stModForm.value
    if (!f.name.trim()) { stModMsg.value = zh ? '插件名不能为空' : 'Name required'; return }
    const body = {
      name: f.name, intro: f.intro, price: Number(f.price) || 0,
      trigger: f.trigger, trigger_keywords: f.trigger_keywords,
      content: { text: f.contentText },
    }
    const path = f.id ? `/admin/studio/mods/${f.id}` : '/admin/studio/mods'
    const method = f.id ? 'PUT' : 'POST'
    try {
      const r = await api(path, { method, body: JSON.stringify(body) })
      if (!r.ok) { stModMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      stModOpen.value = false; await fetchStudioMods()
    } catch (e) { stModMsg.value = e.message }
  }
  async function delMod(m) {
    if (!confirm(zh ? `删除插件「${m.name}」？` : `Delete mod?`)) return
    try { await api(`/admin/studio/mods/${m.id}`, { method: 'DELETE' }); await fetchStudioMods() } catch {}
  }
  // 上架到圈子（逗号分隔 circle id）
  const stShelfIds = ref('')
  async function shelfMod(m) {
    const ids = String(stShelfIds.value || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0)
    try {
      const r = await api(`/admin/studio/mods/${m.id}/circles`, { method: 'PUT', body: JSON.stringify({ circle_ids: ids }) })
      stModMsg.value = r.ok ? (zh ? '已上架' : 'Shelved') : `HTTP ${r.status}`
    } catch (e) { stModMsg.value = e.message }
  }

  function fetchStudioAll() { fetchStudioScenes(); fetchStudioMods() }

  return {
    communitySub,
    stScenes, stSceneMsg, stSceneOpen, stSceneForm,
    fetchStudioScenes, openScene, saveScene, delScene,
    stMods, stModMsg, stModOpen, stModForm, stShelfIds,
    fetchStudioMods, openMod, saveMod, delMod, shelfMod,
    fetchStudioAll,
  }
}
