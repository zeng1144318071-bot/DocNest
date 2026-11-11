export function createRenameDialog(root, { onOpen }) {
  const byId = id => root.querySelector('#' + id);
  const dialog = byId('pv-rename-dialog');
  const form = byId('pv-rename-form');
  const input = byId('pv-rename-input');
  const error = byId('pv-rename-error');
  const save = byId('pv-rename-save');
  const cancel = byId('pv-rename-cancel');
  const close = byId('pv-rename-close');
  let pending = null;
  let busy = false;
  function showError(message) {
    error.textContent = message; error.hidden = !message;
    input.setAttribute('aria-invalid', String(Boolean(message)));
  }
  function validate() {
    const result = pending?.validate(input.value) || { name: '', error: '' };
    showError(result.error); save.disabled = busy || Boolean(result.error);
    return result;
  }
  function setBusy(value) {
    busy = value; form.setAttribute('aria-busy', String(value));
    for (const control of [input, save, cancel, close]) control.disabled = value;
    if (!value) save.disabled = Boolean(pending?.validate(input.value).error);
  }
  function settle(value) {
    const request = pending; pending = null;
    if (!request) return;
    if (request.focus?.isConnected && !request.focus.disabled) request.focus.focus();
    request.resolve(value);
  }
  function finish(value = null) {
    if (!dialog.open || busy) return;
    dialog.close(value === null ? 'cancel' : 'saved'); settle(value);
  }
  input.addEventListener('input', validate);
  cancel.addEventListener('click', () => finish());
  close.addEventListener('click', () => finish());
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.addEventListener('close', () => { if (!dialog.open && !busy) settle(null); });
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Enter' && event.target === input) { event.preventDefault(); if (!busy && !save.disabled) form.requestSubmit(save); return; }
    if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(node => node.getClientRects().length);
    if (!controls.length) { event.preventDefault(); return; }
    const current = controls.indexOf(document.activeElement);
    event.preventDefault(); controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!pending || busy) return;
    const result = validate();
    if (result.error) { input.focus(); return; }
    setBusy(true);
    try {
      if (await pending.onSave(result.name)) { setBusy(false); finish(result.name); }
      else showError('名称保存失败，请重试。');
    } catch (_) { showError('名称保存失败，请重试。'); }
    finally { setBusy(false); }
  });
  return function renameDocument({ name, formatLabel, extension, validate: validateName, onSave }) {
    if (pending || dialog.open) return Promise.resolve(null);
    onOpen();
    return new Promise(resolve => {
      pending = { resolve, validate: validateName, onSave, focus: document.activeElement };
      input.value = name;
      byId('pv-rename-hint').textContent = formatLabel + ' · 未填写后缀时自动补全 ' + extension;
      setBusy(false); validate();
      dialog.returnValue = ''; dialog.showModal(); input.focus();
      const dot = name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 && !name.startsWith('.') ? dot : name.length);
    });
  };
}
