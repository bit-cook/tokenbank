// 模型 / 智能体网页对话页共用的小工具（无框架依赖）
window.ChatUI = (function () {
  const COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0d9488', '#4f46e5', '#0a0a0a']

  function avatarColor(name) {
    let h = 0
    const s = String(name || '')
    for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
    return COLORS[Math.abs(h) % COLORS.length]
  }

  /** 给已净化的 HTML 中每个 <pre> 包一层并加「复制」按钮 */
  function wrapCode(html, label) {
    if (!html || html.indexOf('<pre') < 0) return html
    return html
      .replace(/<pre>/g, '<div class="pre"><button type="button" class="copy-btn">' + label + '</button><pre>')
      .replace(/<\/pre>/g, '</pre></div>')
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    return new Promise((resolve) => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
      resolve()
    })
  }

  /** 消息区委托点击：代码块复制按钮 */
  function onCopyClick(e, copiedLabel, label) {
    const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null
    if (!btn) return
    const pre = btn.parentElement && btn.parentElement.querySelector('pre')
    if (!pre) return
    copyText(pre.innerText || '').then(() => {
      btn.textContent = copiedLabel
      setTimeout(() => { btn.textContent = label }, 1400)
    })
  }

  /** textarea 随内容自适应高度（上限由 CSS max-height 控制） */
  function autoGrow(el) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  return { avatarColor, wrapCode, copyText, onCopyClick, autoGrow }
})()
