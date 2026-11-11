import { showMenu } from './popovers.js';

export function createThemeControls(root, { api, ui, refreshIcons }) {
  const trigger = root.querySelector('#pv-theme-trigger');
  const menu = root.querySelector('#pv-theme-menu');
  const options = [...menu.querySelectorAll('[data-theme]')];
  const modes = {
    system: { label: '跟随系统', icon: 'monitor' },
    light: { label: '白天模式', icon: 'sun' },
    dark: { label: '夜晚模式', icon: 'moon' }
  };
  let source = 'system';
  let changing = false;

  function sync() {
    for (const option of options) option.setAttribute('aria-checked', String(option.dataset.theme === source));
    ui.setAction(trigger, modes[source].icon, '外观模式：' + modes[source].label);
    refreshIcons();
  }
  function close(restoreFocus = false) {
    if (menu.matches(':popover-open')) menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function open() {
    showMenu(root, menu);
    trigger.setAttribute('aria-expanded', 'true');
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - bounds.width - 8, anchor.right - bounds.width)) + 'px';
    menu.style.top = Math.max(8, Math.min(innerHeight - bounds.height - 8, anchor.top - bounds.height - 8)) + 'px';
    options.find(option => option.dataset.theme === source).focus();
  }
  async function choose(next) {
    if (changing) return;
    if (next === source) { close(true); return; }
    changing = true;
    try {
      const result = await api.setTheme(next);
      source = result.source;
      sync(); close(true);
      ui.toast('外观已切换', modes[source].label);
    } catch (error) { ui.toast('外观切换失败', String(error.message || '请稍后重试。'), 'error'); }
    finally { changing = false; }
  }

  for (const option of options) {
    option.tabIndex = -1;
    option.addEventListener('click', () => { void choose(option.dataset.theme); });
  }
  trigger.addEventListener('click', () => menu.matches(':popover-open') ? close(true) : open());
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!menu.matches(':popover-open')) open();
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') {
      event.preventDefault(); close();
      (event.shiftKey ? trigger : root.querySelector('#pv-check-update:not(:disabled), #pv-data-directory')).focus();
      return;
    }
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % options.length : event.key === 'ArrowUp' ? (current + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); options[next].focus();
  });
  menu.addEventListener('toggle', event => { trigger.setAttribute('aria-expanded', String(event.newState === 'open')); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.matches(':popover-open') && !menu.contains(event.target)) {
      event.preventDefault(); close(true);
    }
  });
  trigger.disabled = true;
  void api.themeState().then(result => {
    if (modes[result.source]) source = result.source;
    sync();
  }).catch(() => {}).finally(() => { trigger.disabled = false; });
  sync();
}
