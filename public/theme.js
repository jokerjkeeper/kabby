/**
 * 暗色 / 亮色主題切換（所有頁面共用；要在 <head> 同步載入，避免先閃一下暗色）。
 *
 * 決定順序：網址 ?theme=light|dark（給 iframe 嵌入用，只影響該頁、不記住）
 *          → localStorage 'kabby-theme'（使用者按過切換鈕）
 *          → 系統 prefers-color-scheme
 * 結果寫到 <html data-theme="light|dark">；色票在 theme.css。
 * 其他分頁切換時經 storage 事件同步；沒手動選過時跟著系統設定變。
 *
 * KabbyTheme.get() / set('light'|'dark') / toggle() / bindButton(btn)
 * 主題變更時 window 發出 'kabby-theme' 事件（detail = 'light'|'dark'）。
 */
(function () {
  const KEY = 'kabby-theme';
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let urlTheme = null;
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') urlTheme = q;
  } catch {}

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch { return null; }
  }
  // 目前應套用的主題
  function resolve() {
    return urlTheme || stored() || (media && media.matches ? 'light' : 'dark');
  }
  // 寫到 <html> 並通知（沒變就不發事件）
  function apply(theme) {
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('kabby-theme', { detail: theme }));
  }

  /** 使用者切換：記住選擇（網址參數指定的頁面也改成以按鈕為準）。 */
  function set(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    urlTheme = null;
    try { localStorage.setItem(KEY, theme); } catch {}
    apply(theme);
  }

  /** 把按鈕綁成切換鈕：顯示「切換到…」的圖示與提示。 */
  function bindButton(btn) {
    if (!btn) return;
    const render = () => {
      const light = root.dataset.theme === 'light';
      btn.textContent = light ? '🌙' : '☀';
      btn.title = light ? '切換為暗色主題' : '切換為亮色主題';
    };
    btn.addEventListener('click', () => set(root.dataset.theme === 'light' ? 'dark' : 'light'));
    window.addEventListener('kabby-theme', render);
    render();
  }

  apply(resolve());
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(resolve()); });
  if (media) {
    const onChange = () => apply(resolve());
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  // 頁面上的 #theme-btn 自動綁成切換鈕
  document.addEventListener('DOMContentLoaded', () => bindButton(document.getElementById('theme-btn')));

  window.KabbyTheme = {
    get: () => root.dataset.theme,
    set,
    toggle: () => set(root.dataset.theme === 'light' ? 'dark' : 'light'),
    bindButton,
  };
})();
