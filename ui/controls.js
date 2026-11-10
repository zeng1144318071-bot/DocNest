import { createRenameDialog } from './rename.js';

export function createControls(root, { projectCount, refreshIcons }) {
  const byId = id => root.querySelector('#' + id);
  const selectors = [];
  let openSelector = null;
  let toastTimer;
  let toastCountdownTimer;
  let toastProgressAnimation;
  let toastExitAnimation;
  let toastExitTimer;
  let toastReturnFocus;
  const copiedButtons = new WeakMap();
  const actionButtons = new WeakMap();
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const icon = name => {
    const result = node('i'); result.dataset.lucide = name; result.setAttribute('aria-hidden', 'true'); return result;
  };
  function setAction(button, name, label) {
    const previous = actionButtons.get(button);
    if (previous?.name === name && previous?.label === label) return;
    resetCopied(button);
    button.classList.add('pv-action-button');
    button.dataset.actionIcon = name; button.dataset.actionLabel = label; button.dataset.tooltip = label;
    button.setAttribute('aria-label', label); button.removeAttribute('title');
    button.replaceChildren(icon(name), node('span', 'pv-sr-only', label));
    actionButtons.set(button, { name, label });
  }

  const tooltip = node('div', 'pv-tooltip'); tooltip.id = 'pv-action-tooltip';
  tooltip.setAttribute('role', 'tooltip'); tooltip.setAttribute('popover', 'manual'); root.append(tooltip);
  let tooltipTrigger = null;
  let tooltipTimer;
  function hideTooltip() {
    clearTimeout(tooltipTimer);
    if (tooltipTrigger) {
      const description = (tooltipTrigger.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (description.length) tooltipTrigger.setAttribute('aria-describedby', description.join(' '));
      else tooltipTrigger.removeAttribute('aria-describedby');
    }
    tooltipTrigger = null;
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
  }
  function showTooltip(button) {
    hideTooltip();
    if (!button.isConnected || button.disabled || !button.getClientRects().length || !button.dataset.tooltip) return;
    tooltipTrigger = button; tooltip.textContent = button.dataset.tooltip;
    button.setAttribute('aria-describedby', [button.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '));
    tooltip.style.left = '0px'; tooltip.style.top = '0px'; tooltip.showPopover();
    const target = button.getBoundingClientRect(); const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(innerWidth - bounds.width - 8, target.left + (target.width - bounds.width) / 2)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(innerHeight - bounds.height - 8, target.top >= bounds.height + 14 ? target.top - bounds.height - 8 : target.bottom + 8)) + 'px';
  }
  root.addEventListener('pointerover', event => {
    const button = event.target.closest('button[data-tooltip]');
    if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
    hideTooltip(); tooltipTimer = setTimeout(() => showTooltip(button), 350);
  });
  root.addEventListener('pointerout', event => {
    const button = event.target.closest('button[data-tooltip]');
    if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) hideTooltip();
  });
  root.addEventListener('focusin', event => { if (event.target.matches('button[data-tooltip]:focus-visible')) showTooltip(event.target); });
  root.addEventListener('focusout', hideTooltip);
  root.addEventListener('pointerdown', hideTooltip);
  root.addEventListener('click', hideTooltip);
  root.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
  document.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
  function positionSelector(control) {
    const rect = control.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, control.isProject ? 280 : 220), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 18;
    const above = rect.top - 18;
    const useAbove = below < 210 && above > below;
    const height = Math.max(100, Math.min(380, useAbove ? above : below));
    Object.assign(control.popup.style, { width: width + 'px', maxHeight: height + 'px', left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px', top: '0px' });
    const actualHeight = control.popup.getBoundingClientRect().height;
    control.popup.style.top = Math.max(12, useAbove ? rect.top - actualHeight - 6 : rect.bottom + 6) + 'px';
  }
  function closeSelector(restoreFocus = false) {
    if (!openSelector) return;
    const control = openSelector; openSelector = null;
    if (control.popup.matches(':popover-open')) control.popup.hidePopover();
    control.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !control.trigger.disabled) control.trigger.focus();
  }
  function focusOption(control, index) {
    const options = [...control.list.querySelectorAll('[role="option"]:not(:disabled)')];
    if (!options.length) return;
    const option = options[(index + options.length) % options.length];
    option.focus({ preventScroll: true }); option.scrollIntoView({ block: 'nearest' });
  }
  function fillOptions(control) {
    const query = control.search?.value.trim().toLocaleLowerCase() || '';
    const options = [...control.select.options].filter(option => !option.disabled && option.textContent.toLocaleLowerCase().includes(query));
    control.list.replaceChildren();
    for (const option of options) {
      const button = node('button', 'pv-select-option'); button.type = 'button'; button.tabIndex = -1;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.value === control.select.value)); button.dataset.value = option.value;
      const text = node('span', 'pv-select-option-text'); text.append(node('span', '', option.textContent));
      if (control.isProject) text.append(node('span', 'pv-select-option-detail', projectCount(option.value) + ' 份资料'));
      button.append(text, icon('check'));
      button.addEventListener('click', () => {
        const value = option.value;
        closeSelector(true);
        control.select.value = value;
        control.select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      });
      control.list.append(button);
    }
    if (!options.length) control.list.append(node('p', 'pv-select-empty', '没有找到匹配的项目'));
    refreshIcons();
    if (openSelector === control) positionSelector(control);
  }
  function open(control, keyboard = false) {
    if (control.trigger.disabled) return;
    closeSelector();
    if (control.search) control.search.value = '';
    fillOptions(control);
    control.popup.showPopover(); openSelector = control;
    control.trigger.setAttribute('aria-expanded', 'true');
    positionSelector(control);
    if (control.search && !keyboard) control.search.focus();
    else {
      const options = [...control.list.querySelectorAll('[role="option"]')];
      focusOption(control, Math.max(0, options.findIndex(option => option.getAttribute('aria-selected') === 'true')));
    }
  }
  for (const select of root.querySelectorAll('select.pv-input')) {
    const label = select.closest('label') || select.labels[0];
    const labelName = [...(label?.childNodes || [])].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim();
    const trigger = node('button', 'pv-input pv-select-trigger'); trigger.type = 'button'; trigger.id = select.id + '-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const text = node('span', 'pv-select-value'); trigger.append(text, icon('chevron-down'));
    select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true'); select.after(trigger);
    if (label) label.htmlFor = trigger.id;
    const popup = node('div', 'pv-select-popover'); popup.id = select.id + '-popup'; popup.setAttribute('popover', 'auto');
    trigger.setAttribute('aria-controls', select.id + '-listbox');
    const isProject = select.id === 'pv-project';
    popup.append(node('div', 'pv-select-heading', isProject ? '切换项目' : labelName));
    let search;
    if (isProject) {
      search = node('input', 'pv-input pv-select-search'); search.type = 'search'; search.placeholder = '查找项目'; search.setAttribute('aria-label', '查找项目');
      search.autocomplete = 'off'; popup.append(search);
    }
    const list = node('div', 'pv-select-list'); list.id = select.id + '-listbox'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', labelName); popup.append(list); root.append(popup);
    const control = { select, trigger, text, popup, list, search, isProject, labelName }; selectors.push(control);
    trigger.addEventListener('click', () => openSelector === control ? closeSelector(true) : open(control));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(control, true); }
    });
    search?.addEventListener('input', () => fillOptions(control));
    popup.addEventListener('keydown', event => {
      const options = [...list.querySelectorAll('[role="option"]')];
      const index = options.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeSelector(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); focusOption(control, index < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : index + (event.key === 'ArrowDown' ? 1 : -1));
      } else if ((event.key === 'Home' || event.key === 'End') && document.activeElement !== search) {
        event.preventDefault(); focusOption(control, event.key === 'Home' ? 0 : options.length - 1);
      } else if (event.key === 'Enter' || (event.key === ' ' && document.activeElement !== search)) {
        event.preventDefault(); (options[index] || options[0])?.click();
      } else if (event.key === 'Tab') {
        event.preventDefault(); closeSelector(true);
        const focusable = [...root.querySelectorAll('button, input, textarea, a[href]')].filter(item => !item.disabled && item.tabIndex >= 0 && item.getClientRects().length && !item.closest('.pv-select-popover, dialog, #pv-toast'));
        const position = focusable.indexOf(trigger);
        focusable[(position + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      }
    });
    popup.addEventListener('toggle', () => {
      if (!popup.matches(':popover-open')) { trigger.setAttribute('aria-expanded', 'false'); if (openSelector === control) openSelector = null; }
    });
    select.addEventListener('change', sync);
  }
  function sync() {
    for (const button of root.querySelectorAll('button[data-action-icon]')) setAction(button, button.dataset.actionIcon, button.dataset.actionLabel || button.getAttribute('aria-label') || button.textContent.trim());
    if (tooltipTrigger && (!tooltipTrigger.isConnected || tooltipTrigger.disabled || !tooltipTrigger.getClientRects().length)) hideTooltip();
    for (const control of selectors) {
      control.text.textContent = control.select.selectedOptions[0]?.textContent || '请选择';
      control.trigger.disabled = control.select.disabled;
      control.trigger.setAttribute('aria-label', control.labelName + '：' + control.text.textContent);
      if (control.trigger.disabled && openSelector === control) closeSelector();
    }
  }
  window.addEventListener('resize', () => { if (openSelector) positionSelector(openSelector); });
  document.addEventListener('scroll', event => { if (openSelector && !openSelector.popup.contains(event.target)) positionSelector(openSelector); }, true);

  const toastElement = byId('pv-toast');
  function finishHidingToast() {
    toastProgressAnimation?.cancel(); toastProgressAnimation = null;
    const restoreFocus = toastElement.contains(document.activeElement);
    toastElement.hidden = true;
    delete toastElement.dataset.state;
    if (restoreFocus && toastReturnFocus?.isConnected && !toastReturnFocus.disabled && toastReturnFocus.getClientRects().length) toastReturnFocus.focus({ preventScroll: true });
    toastReturnFocus = null;
  }
  function hideToast({ immediate = true } = {}) {
    clearTimeout(toastTimer); clearTimeout(toastCountdownTimer);
    if (tooltipTrigger && toastElement.contains(tooltipTrigger)) hideTooltip();
    if (immediate || toastElement.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clearTimeout(toastExitTimer); toastExitTimer = null;
      const previous = toastExitAnimation; toastExitAnimation = null; previous?.cancel();
      finishHidingToast(); return;
    }
    if (toastExitAnimation) return;
    // Freeze the countdown ring at its current position while the message fades.
    const progress = byId('pv-toast-progress');
    progress.style.strokeDashoffset = getComputedStyle(progress).strokeDashoffset;
    toastProgressAnimation?.cancel(); toastProgressAnimation = null;
    const style = getComputedStyle(toastElement);
    toastElement.dataset.state = 'leaving';
    const animation = toastElement.animate([
      { opacity: style.opacity, transform: style.transform },
      { opacity: 0, transform: 'translate(-50%, -6px)' }
    ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    toastExitAnimation = animation;
    const finishExit = () => {
      if (toastExitAnimation !== animation) return;
      clearTimeout(toastExitTimer); toastExitTimer = null;
      toastExitAnimation = null; finishHidingToast(); animation.cancel();
    };
    animation.finished.then(finishExit, () => {});
    // Minimized or hidden windows can suspend animation frames and their finished promise.
    toastExitTimer = setTimeout(finishExit, 220);
  }
  function toast(title, detail = '', tone = 'success') {
    hideToast(); toastReturnFocus = document.activeElement;
    toastElement.dataset.tone = tone;
    toastElement.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    byId('pv-toast-icon').replaceChildren(icon(tone === 'error' ? 'circle-alert' : 'check'));
    byId('pv-toast-title').textContent = title;
    byId('pv-toast-detail').textContent = detail; byId('pv-toast-detail').hidden = !detail;
    const countdown = byId('pv-toast-countdown'); const progress = byId('pv-toast-progress');
    countdown.textContent = '3'; progress.style.strokeDashoffset = '0';
    toastElement.hidden = false; refreshIcons();
    const duration = 3000; const deadline = performance.now() + duration;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function updateCountdown() {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { hideToast({ immediate: false }); return; }
      const seconds = Math.ceil(remaining / 1000);
      countdown.textContent = String(seconds);
      if (reducedMotion) progress.style.strokeDashoffset = String(1 - remaining / duration);
      toastCountdownTimer = setTimeout(updateCountdown, Math.max(16, remaining - (seconds - 1) * 1000 + 1));
    }
    updateCountdown();
    if (!reducedMotion) toastProgressAnimation = progress.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '1' }], { duration, easing: 'linear', fill: 'forwards' });
    toastTimer = setTimeout(() => hideToast({ immediate: false }), duration);
  }
  byId('pv-toast-close').addEventListener('click', () => hideToast({ immediate: false }));
  function resetCopied(button) {
    const previous = button && copiedButtons.get(button);
    if (!previous) return;
    clearTimeout(previous.timer); button.replaceChildren(...previous.original); button.style.minWidth = previous.minWidth;
    button.setAttribute('aria-label', previous.label); button.dataset.tooltip = previous.tooltip;
    delete button.dataset.copied; copiedButtons.delete(button);
  }
  function markCopied(button) {
    if (!button) return;
    const previous = copiedButtons.get(button);
    if (previous) clearTimeout(previous.timer);
    const original = previous?.original || [...button.childNodes].map(child => child.cloneNode(true));
    const minWidth = previous?.minWidth ?? button.style.minWidth;
    const label = previous?.label ?? button.getAttribute('aria-label') ?? '复制内容';
    const tooltip = previous?.tooltip ?? button.dataset.tooltip ?? label;
    if (!previous) button.style.minWidth = Math.ceil(button.getBoundingClientRect().width) + 'px';
    button.replaceChildren(icon('check'), node('span', 'pv-sr-only', '已复制')); button.dataset.copied = 'true';
    button.setAttribute('aria-label', '已复制'); button.dataset.tooltip = '已复制'; refreshIcons();
    const timer = setTimeout(() => resetCopied(button), 2000);
    copiedButtons.set(button, { original, timer, minWidth, label, tooltip });
  }

  const dialog = byId('pv-confirm-dialog');
  let pendingConfirmation;
  function settleConfirmation(confirmed) {
    const pending = pendingConfirmation; pendingConfirmation = null;
    if (!pending) return;
    if (pending.focus?.isConnected && !pending.focus.disabled) pending.focus.focus();
    pending.resolve(confirmed);
  }
  function finishConfirmation(confirmed) {
    if (!dialog.open) return;
    dialog.close(confirmed ? 'confirm' : 'cancel'); settleConfirmation(confirmed);
  }
  byId('pv-confirm-cancel').addEventListener('click', () => finishConfirmation(false));
  byId('pv-confirm-close').addEventListener('click', () => finishConfirmation(false));
  byId('pv-confirm-delete').addEventListener('click', () => finishConfirmation(true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); finishConfirmation(false); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled)')];
    const current = controls.indexOf(document.activeElement);
    event.preventDefault(); controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finishConfirmation(false);
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open) settleConfirmation(dialog.returnValue === 'confirm');
  });
  function confirmDelete({ kind, name, count }) {
    if (pendingConfirmation) return Promise.resolve(false);
    closeSelector(); hideToast();
    const isProject = kind === 'project'; const title = isProject ? '删除项目' : '删除资料';
    byId('pv-confirm-title').textContent = title + '？';
    byId('pv-confirm-label').textContent = isProject ? '项目名称' : '资料名称';
    byId('pv-confirm-name').textContent = name;
    byId('pv-confirm-scope').textContent = isProject ? '此项目中的 ' + count + ' 份资料将一并删除。其他项目不受影响。' : '将从当前项目中删除这份资料。其他资料不受影响。';
    byId('pv-confirm-delete').textContent = title;
    return new Promise(resolve => {
      pendingConfirmation = { resolve, focus: document.activeElement };
      dialog.returnValue = ''; dialog.showModal(); byId('pv-confirm-cancel').focus();
    });
  }
  const renameDocument = createRenameDialog(root, { onOpen: () => { closeSelector(); hideTooltip(); hideToast(); } });
  return { sync, toast, markCopied, resetCopied, confirmDelete, setAction, renameDocument };
}
