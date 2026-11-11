import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { createIcons, icons } from 'lucide';
import { createControls } from './controls.js';
import { repository } from '../package.json';
import { EXAMPLE_PROJECT_ID, createExampleStore, planExampleImport } from '../examples/catalog.cjs';
import { createUpdateControls } from './updates.js';
import { detectContentFormat, formatFromFilename, maskEnv, splitEnvSections } from './formats.js';
globalThis.lucide = { createIcons: options => createIcons({ ...options, icons }) };
(async () => {
  const root = document.getElementById('project-vault-preview');
  const byId = id => root.querySelector('#' + id);
  const mainPane = root.querySelector('.pv-main');
  const formats = { text: { label: 'TXT 文档', short: 'TXT', ext: '.txt', icon: 'file-text' }, env: { label: 'ENV 配置', short: 'ENV', ext: '.env', icon: 'sliders-horizontal' }, json: { label: 'JSON 源码', short: 'JSON', ext: '.json', icon: 'braces' }, markdown: { label: 'Markdown 文档', short: 'MD', ext: '.md', icon: 'pilcrow' } };
  const { projects, records } = createExampleStore();
  const demoRecords = createExampleStore().records;
  const api = window.vaultApp;
  const repositoryUrl = repository.url.replace(/\.git$/, '');
  byId('pv-github').dataset.actionLabel = 'GitHub 仓库 · ' + repositoryUrl;
  let storageReady = false;
  let platform = 'win32';
  let editingId = null;
  let saving = false;
  let deleting = false;
  let renaming = false;
  let project = EXAMPLE_PROJECT_ID;
  let selected = 'guide';
  let route = 'library';
  let sourceView = false;
  let revealSecrets = false;
  let importFormat = 'text';
  let importName = '';
  let importHint = null;
  let importOriginalSource = '';
  let exportFormat = 'markdown';
  let exportScope = 'current';
  let exportSourceView = false;
  const projectRecords = () => records.filter(record => record.project === project);
  const currentRecord = () => records.find(record => record.id === selected && record.project === project);
  const feedback = message => { byId('pv-feedback').textContent = message; };
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) { const node = element('i'); node.setAttribute('data-lucide', name); node.setAttribute('aria-hidden', 'true'); return node; }
  function refreshIcons() {
    ui.sync();
    root.querySelectorAll('button').forEach(button => button.classList.add('cursor-interaction'));
    if (globalThis.lucide) globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } });
  }
  const ui = createControls(root, { projectCount: id => records.filter(record => record.project === id).length, refreshIcons: () => globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } }) });
  function maskSource(source, format, includeSecrets = false) {
    if (includeSecrets) return source;
    const sensitive = /password|passwd|secret|token|private[_-]?key|access[_-]?key|密码|密钥/i;
    if (format === 'env') return maskEnv(source, sensitive);
    if (format === 'json') {
      try {
        return JSON.stringify(JSON.parse(source, (key, value) => sensitive.test(key) ? '[已隐藏]' : value), null, 2);
      } catch (_) { return source; }
    }
    return source.replace(/\r\n/g, '\n').split('\n').map(line => {
      const pair = line.match(/^(\s*[^:=：\n]+\s*[:=：]\s*)(.*)$/);
      return pair && sensitive.test(pair[1]) && pair[2].trim() ? pair[1] + '[已隐藏]' : line;
    }).join('\n');
  }
  async function copyText(value, button) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      feedback('已复制当前显示的内容');
      ui.markCopied(button); ui.toast('复制成功', value.length + ' 个字符已复制，可直接粘贴');
    } catch (_) { ui.resetCopied(button); feedback('复制失败，请重试'); ui.toast('复制失败', '剪贴板暂时不可用，请重试。', 'error'); }
  }
  function appendHighlighted(container, code, language) {
    const token = (kind, text) => container.append(element('span', kind ? 'pv-token-' + kind : '', text));
    if (language === 'json') {
      let position = 0;
      const pattern = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
      for (const match of code.matchAll(pattern)) {
        token('', code.slice(position, match.index));
        token(match[0].startsWith('"') ? (/^\s*:/.test(code.slice(match.index + match[0].length)) ? 'key' : 'string') : 'number', match[0]);
        position = match.index + match[0].length;
      }
      token('', code.slice(position));
      return;
    }
    code.split('\n').forEach((rawLine, index) => {
      if (index) token('', '\n');
      const line = rawLine.replace(/\r$/, '');
      if (/^\s*[#;]/.test(line) && (language === 'env' || language === 'ini')) { token('comment', rawLine); return; }
      const setting = (language === 'env' || language === 'ini') && line.match(/^(\s*[^=]+?)(\s*=\s*)(.*)$/);
      const section = (language === 'ini' || language === 'env') && line.match(/^(\s*\[[^\]]+\])(.*)$/);
      const method = language === 'http' && line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+.*)$/);
      const header = language === 'http' && line.match(/^([^:]+)(:\s*)(.*)$/);
      if (setting) { token('setting', setting[1]); token('', setting[2]); token('string', setting[3]); }
      else if (section) { token('setting', section[1]); token('', section[2]); }
      else if (method) { token('number', method[1]); token('', method[2]); }
      else if (header) { token('setting', header[1]); token('', header[2] + header[3]); }
      else token(language === 'bash' || language === 'shell' ? 'key' : '', line);
      token('', rawLine.slice(line.length));
    });
  }
  function createCodeBlock(language, code, { title, copyLabel, copyValue = code } = {}) {
    const labels = { bash: 'Bash', shell: 'Shell', http: 'http', ini: 'INI', env: 'ENV', json: 'JSON', markdown: 'Markdown', text: 'TXT' };
    const block = element('figure', 'pv-code-block');
    const heading = element('figcaption', 'pv-code-header');
    const label = element('span', 'pv-code-language'); label.append(icon(title ? 'folder-code' : 'code-xml'), element('span', '', title || labels[language] || language || '代码'));
    const copy = element('button', 'pv-code-copy pv-action-compact cursor-interaction'); copy.type = 'button';
    ui.setAction(copy, 'copy', copyLabel || '复制 ' + (title || labels[language] || '代码') + ' 内容'); copy.addEventListener('click', () => copyText(copyValue, copy));
    heading.append(label, copy);
    const pre = element('pre', 'pv-code-body'); const node = element('code'); appendHighlighted(node, code, language); pre.append(node);
    block.append(heading, pre); return block;
  }
  function appendInline(container, text) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
    let position = 0;
    for (const match of text.matchAll(pattern)) {
      container.append(document.createTextNode(text.slice(position, match.index)));
      const token = match[0];
      if (token.startsWith('`')) container.append(element('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) container.append(element('strong', '', token.slice(2, -2)));
      else {
        const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        const link = element('a', '', parts[1]); link.href = parts[2]; link.target = '_blank'; link.rel = 'noopener noreferrer'; container.append(link);
      }
      position = match.index + token.length;
    }
    container.append(document.createTextNode(text.slice(position)));
  }
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  function renderMarkdown(container, source) {
    container.innerHTML = DOMPurify.sanitize(markdown.render(source), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object'], FORBID_ATTR: ['style'] });
    container.querySelectorAll('pre > code').forEach(code => {
      const language = Array.from(code.classList).find(name => name.startsWith('language-'))?.slice(9) || 'text';
      const text = code.textContent.replace(/\n$/, '');
      code.parentElement.replaceWith(createCodeBlock(language, text));
    });
    container.querySelectorAll('img').forEach(image => {
      if (!image.getAttribute('src')?.startsWith('data:image/')) image.replaceWith(document.createTextNode(image.alt || '[图片]'));
    });
    container.querySelectorAll('a').forEach(link => { link.removeAttribute('target'); link.setAttribute('rel', 'noopener noreferrer'); });
  }
  function renderSource(container, source, format, raw = false) {
    container.replaceChildren();
    if (format === 'markdown' && !raw) { renderMarkdown(container, source); return; }
    if (format === 'text') { container.append(element('pre', 'pv-text', source)); return; }
    if (format === 'env' && !raw) {
      const sections = splitEnvSections(source);
      if (sections.length) {
        const preview = element('div', 'pv-env-preview');
        const columns = element('div', 'pv-env-columns');
        const all = element('section', 'pv-env-column pv-env-all'); all.setAttribute('aria-label', 'ENV 全部内容');
        all.append(element('div', 'pv-env-column-label', '全部内容'), createCodeBlock('env', source, { copyLabel: '复制全部 ENV 内容' }));
        const groups = element('section', 'pv-env-column pv-env-groups'); groups.setAttribute('aria-label', 'ENV 分组预览');
        groups.append(element('div', 'pv-env-column-label', '分组预览'));
        for (const section of sections) {
          const title = section.name === null ? '全局配置' : '[' + section.name + ']';
          const block = createCodeBlock(section.name === null ? 'env' : 'ini', section.source.replace(/(?:\r?\n[ \t]*)+$/, ''), { title: section.name === null ? title : undefined, copyLabel: '复制 ' + title + ' 内容', copyValue: section.source });
          block.classList.add('pv-env-group'); block.dataset.envSection = section.name ?? ''; block.setAttribute('aria-label', 'ENV 分组 ' + title);
          groups.append(block);
        }
        columns.append(all, groups); preview.append(columns); container.append(preview);
        return;
      }
    }
    let display = source;
    if (format === 'json') { try { display = JSON.stringify(JSON.parse(source), null, 2); } catch (_) { /* Raw source remains visible while editing. */ } }
    container.append(createCodeBlock(format, display));
  }
  function renderSidebar() {
    byId('pv-project').replaceChildren(...Object.entries(projects).map(([id, name]) => { const option = element('option', '', name); option.value = id; return option; }));
    const hasProject = Object.hasOwn(projects, project);
    if (!hasProject) { const option = element('option', '', '请先新建项目'); option.value = ''; byId('pv-project').append(option); }
    byId('pv-project').value = project || '';
    byId('pv-project').disabled = !hasProject;
    byId('pv-project-delete').disabled = !hasProject || !storageReady || saving;
    byId('pv-project-example').disabled = !storageReady || saving;
    byId('pv-overview').disabled = !hasProject;
    byId('pv-search').disabled = !hasProject;
    const all = projectRecords(); const query = byId('pv-search').value.trim().toLocaleLowerCase();
    const matches = all.filter(record => (record.name + ' ' + maskSource(record.source, record.format)).toLocaleLowerCase().includes(query));
    byId('pv-file-count').textContent = all.length + ' 份';
    byId('pv-overview-count').textContent = String(all.length);
    byId('pv-status-summary').textContent = all.length + ' 份资料 · TXT / ENV / JSON / MD';
    byId('pv-overview').setAttribute('aria-pressed', String(selected === null && route === 'library'));
    const list = byId('pv-files');
    const existing = new Map([...list.children].map(button => [button.dataset.record, button]));
    const visible = [];
    for (const record of matches) {
      let button = existing.get(record.id);
      if (!button) {
        button = element('button', 'pv-file cursor-interaction'); button.type = 'button'; button.dataset.record = record.id;
        const picture = element('span', 'pv-file-icon pv-document-icon'); picture.dataset.format = record.format; picture.setAttribute('aria-hidden', 'true'); picture.append(icon(formats[record.format].icon));
        const label = element('span', 'pv-file-text'); label.append(element('span', 'pv-file-name'), element('span', 'pv-file-meta'));
        button.append(picture, label);
        button.addEventListener('click', () => { if (!renaming && (selected !== record.id || route !== 'library')) selectRecord(record.id); });
        button.addEventListener('dblclick', event => { event.preventDefault(); renameRecord(record.id, button); });
      }
      button.setAttribute('aria-pressed', String(record.id === selected && route === 'library'));
      button.setAttribute('aria-description', '双击或按 F2 重命名');
      const name = button.querySelector('.pv-file-name'); if (name.textContent !== record.name) name.textContent = record.name;
      const meta = button.querySelector('.pv-file-meta'); const caption = formats[record.format].short + ' · ' + record.note;
      if (meta.textContent !== caption) meta.textContent = caption;
      visible.push(button);
    }
    const visibleSet = new Set(visible);
    for (const button of [...list.children]) if (!visibleSet.has(button)) button.remove();
    visible.forEach((button, index) => { if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null); });
    byId('pv-no-results').hidden = matches.length > 0;
    byId('pv-no-results').textContent = !hasProject ? '新建项目后即可导入资料' : !all.length ? '项目暂无资料，点击“导入资料”添加' : '没有找到匹配的资料';
  }
  function renderLibrary() {
    const current = currentRecord(); const wholeProject = selected === null;
    const hasProject = Object.hasOwn(projects, project);
    const hasRecords = projectRecords().length > 0;
    byId('pv-import-open').disabled = !hasProject || !storageReady;
    byId('pv-export-open').disabled = !hasProject || !hasRecords;
    byId('pv-copy').disabled = !hasRecords;
    byId('pv-reveal').disabled = !hasRecords;
    if (!hasProject) {
      byId('pv-breadcrumb-project').textContent = 'DocNest';
      byId('pv-breadcrumb-file').textContent = '新建项目';
      byId('pv-title').textContent = '还没有项目';
      byId('pv-subtitle').textContent = '点击左侧“新建项目”，开始整理你的资料。';
      byId('pv-native-type').textContent = '全部类型';
      for (const id of ['pv-native-switch', 'pv-rename', 'pv-edit', 'pv-delete']) byId(id).hidden = true;
      const empty = element('div', 'pv-empty-state');
      const create = element('button', 'pv-button pv-button-primary'); create.type = 'button'; ui.setAction(create, 'folder-plus', '新建项目'); create.addEventListener('click', openProjectForm); empty.append(create);
      byId('pv-content').replaceChildren(empty);
      return;
    }
    byId('pv-breadcrumb-project').textContent = projects[project];
    byId('pv-breadcrumb-file').textContent = wholeProject ? '项目完整预览' : current.name;
    byId('pv-title').textContent = wholeProject ? '项目完整预览' : current.name;
    byId('pv-subtitle').textContent = wholeProject ? projectRecords().length + ' 份资料，按各自类型完整展示' : formats[current.format].label + ' · ' + current.note;
    byId('pv-native-type').textContent = wholeProject ? '全部类型' : formats[current.format].short;
    byId('pv-native-switch').hidden = wholeProject || current.format !== 'markdown';
    byId('pv-rename').hidden = wholeProject; byId('pv-edit').hidden = wholeProject; byId('pv-delete').hidden = wholeProject;
    byId('pv-rename').disabled = !storageReady || saving;
    byId('pv-view-preview').setAttribute('aria-pressed', String(!sourceView)); byId('pv-view-source').setAttribute('aria-pressed', String(sourceView));
    ui.setAction(byId('pv-reveal'), revealSecrets ? 'eye-off' : 'eye', revealSecrets ? '隐藏敏感值' : '显示敏感值'); byId('pv-reveal').setAttribute('aria-pressed', String(revealSecrets));
    const content = byId('pv-content'); content.replaceChildren();
    if (wholeProject) {
      if (!hasRecords) content.append(element('p', 'pv-empty', '这个项目还没有资料，点击右上方“导入资料”添加。'));
      for (const record of projectRecords()) {
        const section = element('section', 'pv-overview-item'); const header = element('div', 'pv-section-heading');
        const left = element('div', 'pv-actions'); left.append(element('h3', '', record.name), element('span', 'pv-type', formats[record.format].short));
        const actions = element('div', 'pv-actions');
        const open = element('button', 'pv-button cursor-interaction'); open.type = 'button'; ui.setAction(open, 'arrow-up-right', '单独查看 ' + record.name); open.addEventListener('click', () => selectRecord(record.id));
        const rename = element('button', 'pv-button'); rename.type = 'button'; rename.dataset.renameRecord = record.id; ui.setAction(rename, 'text-cursor-input', '重命名 ' + record.name); rename.addEventListener('click', () => renameRecord(record.id, rename));
        const remove = element('button', 'pv-button pv-button-danger'); remove.type = 'button'; remove.dataset.deleteRecord = record.id; ui.setAction(remove, 'trash-2', '删除资料 ' + record.name); remove.addEventListener('click', () => deleteRecord(record.id));
        actions.append(open, rename, remove); header.append(left, actions);
        const view = element('div', 'pv-doc'); renderSource(view, maskSource(record.source, record.format, revealSecrets), record.format); section.append(header, view); content.append(section);
      }
    } else renderSource(content, maskSource(current.source, current.format, revealSecrets), current.format, sourceView);
  }
  function sampleRecord(format) { return demoRecords.find(record => record.format === format); }
  function setImportSource(source) { importOriginalSource = source; byId('pv-import-editor').value = source; }
  function importSource() {
    const value = byId('pv-import-editor').value;
    return value === importOriginalSource.replace(/\r\n?/g, '\n') ? importOriginalSource : value;
  }
  function fillExample() {
    const sample = sampleRecord(importFormat);
    importName = ''; importHint = null; setImportSource(sample.source); importFormat = detectContentFormat(sample.source);
  }
  function resolvedImportName() {
    if (importName) return importName;
    const base = { text: '资料', env: '环境配置', json: '配置资料', markdown: '文档' }[importFormat];
    let name = base + formats[importFormat].ext; let suffix = 2;
    while (projectRecords().some(record => record.name === name)) name = base + ' (' + suffix++ + ')' + formats[importFormat].ext;
    return name;
  }
  function resizeEditor() { const editor = byId('pv-import-editor'); editor.style.height = 'auto'; editor.style.height = Math.max(260, editor.scrollHeight + 2) + 'px'; }
  function renderImport() {
    byId('pv-import-heading').textContent = editingId ? '编辑资料' : '导入资料';
    ui.setAction(byId('pv-import-add'), 'save', editingId ? '保存修改' : '保存到项目');
    byId('pv-import-project').textContent = projects[project];
    byId('pv-chosen-file').textContent = importName || '自动识别格式并命名';
    byId('pv-import-preview-type').textContent = formats[importFormat].short;
    byId('pv-import-preview-type').dataset.format = importFormat;
    const source = importSource(); let error = '';
    if (source.trim() && importFormat === 'json') { try { JSON.parse(source); } catch (_) { error = 'JSON 格式有误，请检查逗号、引号和括号。'; } }
    byId('pv-import-error').textContent = error; byId('pv-import-error').hidden = !error;
    const bundle = detectBundle(source, importFormat);
    byId('pv-import-bundle-label').hidden = !bundle || Boolean(editingId);
    byId('pv-import-bundle-text').textContent = '作为项目资料包导入（' + (bundle?.length || 0) + ' 份资料）';
    byId('pv-import-add').disabled = !storageReady || saving || !source.trim() || Boolean(error);
    renderSource(byId('pv-import-preview'), maskSource(source, importFormat), importFormat);
    if (!source.trim()) byId('pv-import-preview').append(element('p', 'pv-caption', '输入内容后显示对应类型的预览'));
    resizeEditor();
  }
  function fencedCode(source, language) {
    const runs = source.match(/`+/g) || []; const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return fence + language + '\n' + source + '\n' + fence;
  }
  function envQuote(text) { return /[\r\n']/.test(text) ? JSON.stringify(text) : "'" + text + "'"; }
  function exportRecords() { return exportScope === 'project' || selected === null ? projectRecords() : [currentRecord()]; }
  function exportText() {
    const files = exportRecords().map(record => ({ name: record.name, format: record.format, content: maskSource(record.source, record.format, byId('pv-export-secrets').checked) }));
    if (exportScope === 'current' && files.length === 1 && files[0].format === exportFormat) return files[0].content;
    if (exportFormat === 'json') return JSON.stringify({ kind: 'project-vault', version: 1, project: projects[project], files }, null, 2);
    if (exportFormat === 'markdown') return '# ' + (exportScope === 'project' ? projects[project] : files[0].name) + '\n\n' + files.map(file => (exportScope === 'project' ? '## ' + file.name + '\n\n' : '') + (file.format === 'markdown' ? file.content : fencedCode(file.content, file.format))).join('\n\n');
    if (exportFormat === 'env') return (exportScope === 'project' ? 'PROJECT_NAME=' + envQuote(projects[project]) + '\n\n' : '') + files.map((file, index) => {
      const prefix = exportScope === 'project' ? 'FILE_' + (index + 1) + '_' : '';
      return '# ' + file.name + '\n' + prefix + 'NAME=' + envQuote(file.name) + '\n' + prefix + 'FORMAT=' + envQuote(file.format) + '\n' + prefix + 'CONTENT=' + envQuote(file.content);
    }).join('\n\n');
    return files.map(file => exportScope === 'project' ? file.name + '\n' + '─'.repeat(18) + '\n' + file.content : file.content).join('\n\n');
  }
  function exportFilename() {
    if (exportScope === 'current' && currentRecord()?.format === exportFormat) return currentRecord().name;
    const name = exportScope === 'project' || selected === null ? projects[project] : currentRecord().name.replace(/\.(?:txt|json|md|markdown|env)$/i, '');
    return name + formats[exportFormat].ext;
  }
  function renderExport() {
    byId('pv-export-project').textContent = projects[project]; byId('pv-export-format').value = exportFormat; byId('pv-export-scope').value = exportScope;
    byId('pv-export-scope').querySelector('[value="current"]').disabled = selected === null;
    byId('pv-export-type').textContent = formats[exportFormat].short; byId('pv-export-filename').textContent = exportFilename();
    byId('pv-export-switch').hidden = exportFormat !== 'markdown';
    byId('pv-export-preview-button').setAttribute('aria-pressed', String(!exportSourceView)); byId('pv-export-source-button').setAttribute('aria-pressed', String(exportSourceView));
    renderSource(byId('pv-export-preview'), exportText(), exportFormat, exportSourceView);
    const sameFormat = exportScope === 'current' && currentRecord()?.format === exportFormat;
    byId('pv-export-rule').textContent = sameFormat ? '同格式导出保留原始结构；敏感字段按下方选项处理。' : exportFormat === 'json' ? 'JSON 包含文件名称、原始类型和正文，方便保留完整资料。' : exportFormat === 'env' ? '跨格式内容写入 CONTENT 字段，换行转为转义字符。' : exportFormat === 'markdown' ? '正文按资料分段，其他格式放入对应语言的代码块。' : 'TXT 保留正文；导出整个项目时按文件分段。';
  }
  function render() {
    for (const name of ['library', 'import', 'export']) byId(name === 'library' ? 'pv-library' : 'pv-' + name + '-pane').hidden = route !== name;
    renderSidebar();
    if (route === 'library') renderLibrary(); else if (route === 'import') renderImport(); else renderExport();
    syncMainScroll();
    refreshIcons();
  }
  function syncMainScroll() { mainPane.classList.toggle('pv-main-scrolled', mainPane.scrollTop > 48); }
  mainPane.addEventListener('scroll', syncMainScroll, { passive: true });
  function selectRecord(id) { selected = id; route = 'library'; sourceView = false; revealSecrets = false; mainPane.scrollTop = 0; feedback(''); render(); saveChoice(); }
  function setRoute(value) {
    if (saving || deleting || renaming) return;
    if (value !== 'library' && !Object.hasOwn(projects, project)) { openProjectForm(); feedback('请先新建项目'); return; }
    if (value === 'export' && !projectRecords().length) { feedback('项目暂无资料，请先导入资料'); return; }
    route = value; mainPane.scrollTop = 0; revealSecrets = false; feedback('');
    if (route === 'import') { editingId = null; importName = ''; importHint = null; importFormat = 'text'; setImportSource(''); }
    if (route === 'export') { exportScope = selected === null ? 'project' : 'current'; exportFormat = currentRecord()?.format || 'markdown'; exportSourceView = false; byId('pv-export-secrets').checked = false; }
    render(); saveChoice();
  }
  function saveChoice() {
    localStorage.setItem('project-vault-ui', JSON.stringify({ project, selected, sourceView }));
  }
  function showFailure(error) {
    const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    feedback(message || '操作失败，请重试。');
    ui.toast('操作失败', message || '请稍后重试。', 'error');
  }
  function openProjectForm() { byId('pv-project-create').hidden = false; byId('pv-project-name').focus(); }
  function validateRecordName(value, record) {
    let name = value.trim();
    if (!name) return { name, error: '请输入资料名称。' };
    if (name !== record.name && !name.includes('.')) name += formats[record.format].ext;
    let error = '';
    if (name.length > 255) error = '名称不能超过 255 个字符（包含后缀）。';
    else if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /\.$/.test(name)) error = '名称不能包含 \\ / : * ? " < > |，也不能以点结尾。';
    else if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) error = '这个名称为 Windows 保留名称，请换一个。';
    else if (name !== record.name && records.some(item => item.project === record.project && item.id !== record.id && item.name.normalize('NFC').toLocaleLowerCase() === name.normalize('NFC').toLocaleLowerCase())) error = '当前项目已存在同名资料，请换一个名称。';
    return { name, error };
  }
  async function renameRecord(id, trigger = byId('pv-rename')) {
    const record = records.find(item => item.id === id && item.project === project);
    if (!record || !storageReady || saving || deleting || renaming) return;
    const previousName = record.name;
    const target = { id: record.id, project: record.project, format: record.format, name: previousName };
    renaming = true;
    try {
      const name = await ui.renameDocument({
        name: previousName, formatLabel: formats[record.format].short, extension: formats[record.format].ext,
        validate: value => validateRecordName(value, target),
        onSave: name => name === previousName ? true : commitMutation(() => { records.find(item => item.id === id && item.project === record.project).name = name; })
      });
      if (name === null || name === previousName) return;
      if (editingId === id) importName = name;
      byId('pv-search').value = ''; render(); saveChoice();
      feedback('名称已更新：' + name); ui.toast('重命名成功', name);
      const replacement = [...root.querySelectorAll('[data-rename-record], [data-record]')].find(node => node.dataset.renameRecord === id || node.dataset.record === id);
      (trigger?.isConnected ? trigger : replacement || byId('pv-rename')).focus();
    } catch (error) { showFailure(error); }
    finally { renaming = false; }
  }
  async function deleteRecord(id) {
    const record = records.find(item => item.id === id && item.project === project);
    if (!record || !storageReady || saving || deleting || renaming) return;
    deleting = true;
    try {
      if (!await ui.confirmDelete({ kind: 'record', name: record.name })) return;
      const position = projectRecords().findIndex(item => item.id === id);
      if (await commitMutation(() => { const index = records.findIndex(item => item.id === id); if (index >= 0) records.splice(index, 1); })) {
        const next = selected === id ? (projectRecords()[position] || projectRecords()[position - 1])?.id || null : selected;
        selectRecord(next); feedback('已删除资料：' + record.name);
        ui.toast('删除成功', record.name);
        (next === null ? byId('pv-overview') : byId('pv-delete')).focus();
      }
    } catch (error) { showFailure(error); }
    finally { deleting = false; }
  }
  async function deleteProject() {
    if (!Object.hasOwn(projects, project) || !storageReady || saving || deleting || renaming) return;
    const projectId = project; const name = projects[projectId]; const count = projectRecords().length;
    const position = Object.keys(projects).indexOf(projectId);
    deleting = true;
    try {
      if (!await ui.confirmDelete({ kind: 'project', name, count })) return;
      if (await commitMutation(() => {
        delete projects[projectId];
        for (let index = records.length - 1; index >= 0; index--) if (records[index].project === projectId) records.splice(index, 1);
      })) {
        const remaining = Object.keys(projects); project = remaining[position] || remaining[position - 1] || null;
        editingId = null; byId('pv-import-editor').value = ''; byId('pv-search').value = '';
        selectRecord(projectRecords()[0]?.id || null);
        feedback('已删除项目“' + name + '”及 ' + count + ' 份资料');
        ui.toast('项目已删除', name + ' · ' + count + ' 份资料');
        (project ? byId('pv-project-trigger') : byId('pv-project-new')).focus();
      }
    } catch (error) { showFailure(error); }
    finally { deleting = false; }
  }
  function detectBundle(source, format) {
    if (format !== 'json') return null;
    try {
      const value = JSON.parse(source);
      if (value.kind !== 'project-vault' || value.version !== 1 || !Array.isArray(value.files) || !value.files.length) return null;
      return value.files.every(file => typeof file.name === 'string' && file.name.trim() && Object.hasOwn(formats, file.format) && typeof file.content === 'string') ? value.files : null;
    } catch (_) { return null; }
  }
  async function commitMutation(change) {
    if (!storageReady || saving) return false;
    const previous = JSON.parse(JSON.stringify({ projects, records }));
    const controls = Array.from(root.querySelectorAll('button, input, select, textarea')).map(node => [node, node.disabled]);
    controls.forEach(([node]) => { node.disabled = true; });
    saving = true; byId('pv-save-status').textContent = '保存中…';
    try {
      change();
      await api.save({ schemaVersion: 1, projects: { ...projects }, records: records.map(record => ({ ...record })) });
      byId('pv-save-status').textContent = '已加密保存';
      return true;
    } catch (error) {
      for (const key of Object.keys(projects)) delete projects[key]; Object.assign(projects, previous.projects);
      records.splice(0, records.length, ...previous.records);
      byId('pv-save-status').textContent = '保存失败'; showFailure(error); return false;
    } finally { saving = false; controls.forEach(([node, disabled]) => { node.disabled = disabled; }); }
  }
  try {
    const loaded = await api.load();
    if (loaded.store) {
      for (const key of Object.keys(projects)) delete projects[key]; Object.assign(projects, loaded.store.projects);
      records.splice(0, records.length, ...loaded.store.records);
    }
    storageReady = true;
    platform = loaded.platform;
    byId('pv-save-status').textContent = loaded.protection;
    byId('pv-platform-caption').textContent = '正式版 ' + loaded.version + ' · ' + loaded.protection;
    byId('pv-import-protection').textContent = '保存在本机，使用当前' + (loaded.platform === 'darwin' ? 'macOS 账户和钥匙串' : 'Windows 账户') + '加密';
  } catch (error) { byId('pv-save-status').textContent = '资料库读取失败'; showFailure(error); }
  try {
    const state = JSON.parse(localStorage.getItem('project-vault-ui') || 'null');
    project = state && Object.hasOwn(projects, state.project) ? state.project : Object.keys(projects)[0] || null;
    selected = records.some(record => record.project === project && record.id === state?.selected) ? state.selected : records.find(record => record.project === project)?.id || null;
    sourceView = Boolean(state?.sourceView);
  } catch (_) { project = Object.keys(projects)[0] || null; selected = records.find(record => record.project === project)?.id || null; }
  byId('pv-project').addEventListener('change', () => { project = byId('pv-project').value; byId('pv-search').value = ''; selectRecord(projectRecords()[0]?.id || null); });
  byId('pv-search').addEventListener('input', () => { renderSidebar(); refreshIcons(); });
  byId('pv-overview').addEventListener('click', () => selectRecord(null));
  byId('pv-view-preview').addEventListener('click', () => { sourceView = false; render(); saveChoice(); });
  byId('pv-view-source').addEventListener('click', () => { sourceView = true; render(); saveChoice(); });
  byId('pv-reveal').addEventListener('click', () => { revealSecrets = !revealSecrets; render(); });
  byId('pv-copy').addEventListener('click', () => copyText((selected === null ? projectRecords() : [currentRecord()]).map(record => (selected === null ? record.name + '\n\n' : '') + maskSource(record.source, record.format, revealSecrets)).join('\n\n'), byId('pv-copy')));
  byId('pv-import-open').addEventListener('click', () => setRoute('import'));
  byId('pv-export-open').addEventListener('click', () => setRoute('export'));
  byId('pv-import-back').addEventListener('click', () => setRoute('library'));
  byId('pv-export-back').addEventListener('click', () => setRoute('library'));
  byId('pv-import-editor').addEventListener('input', () => { importFormat = importHint || detectContentFormat(byId('pv-import-editor').value); renderImport(); refreshIcons(); });
  byId('pv-import-example').addEventListener('click', () => { fillExample(); renderImport(); refreshIcons(); feedback('已填入当前类型的演示内容'); });
  byId('pv-choose-file').addEventListener('click', async () => {
    try {
      const file = await api.openFile(); if (!file) return;
      importName = file.name; importHint = formatFromFilename(file.name);
      importFormat = importHint || detectContentFormat(file.content);
      setImportSource(file.content); renderImport(); refreshIcons();
    } catch (error) { showFailure(error); }
  });
  byId('pv-import-add').addEventListener('click', async () => {
    if (byId('pv-import-add').disabled) return;
    const bundle = !editingId && byId('pv-import-bundle').checked ? detectBundle(importSource(), importFormat) : null;
    const isEditing = Boolean(editingId);
    const id = editingId || crypto.randomUUID();
    const ok = await commitMutation(() => {
      if (bundle) {
        for (const file of bundle) records.push({ id: crypto.randomUUID(), project, name: file.name.trim().slice(0, 240), format: file.format, note: '项目资料包', source: file.content });
      } else {
        const record = { id, project, name: resolvedImportName(), format: importFormat, note: editingId ? '本地资料' : '导入资料', source: importSource() };
        const existing = records.findIndex(item => item.id === editingId);
        if (existing >= 0) records[existing] = record; else records.push(record);
      }
    });
    if (ok) {
      const resultId = bundle ? records.at(-1).id : id;
      editingId = null; byId('pv-search').value = ''; selectRecord(resultId);
      feedback(bundle ? '项目资料包已导入并加密保存' : '资料已加密保存');
      ui.toast(isEditing ? '修改已保存' : '导入成功', bundle ? bundle.length + ' 份资料已加密保存' : currentRecord().name + ' · 已加密保存');
    }
    else renderImport();
  });
  byId('pv-edit').addEventListener('click', () => {
    const record = currentRecord(); if (!record) return;
    route = 'import'; editingId = record.id; importFormat = record.format; importHint = record.format; importName = record.name;
    setImportSource(record.source); render();
  });
  byId('pv-delete').addEventListener('click', () => deleteRecord(selected));
  byId('pv-rename').addEventListener('click', () => renameRecord(selected));
  root.addEventListener('keydown', event => {
    if (event.key !== 'F2' || event.isComposing || event.target.closest('input, textarea, [contenteditable="true"]') || route !== 'library') return;
    const file = event.target.closest('[data-record]'); const id = file?.dataset.record || selected;
    if (!id) return;
    event.preventDefault(); renameRecord(id, file || byId('pv-rename'));
  });
  byId('pv-project-delete').addEventListener('click', deleteProject);
  byId('pv-project-new').addEventListener('click', openProjectForm);
  byId('pv-project-example').addEventListener('click', async () => {
    if (!storageReady || saving || deleting || renaming || root.querySelector('dialog[open]')) return;
    if (route === 'import' || !byId('pv-project-create').hidden) { ui.toast('请先完成当前编辑', '保存或退出编辑后，再导入示例项目。', 'error'); return; }
    const plan = planExampleImport({ projects, records }, () => crypto.randomUUID());
    if (plan.existingProjectId) {
      project = plan.existingProjectId; byId('pv-search').value = ''; selectRecord(null);
      ui.toast('已打开标准示例', '包含 TXT、ENV、JSON、MD 四份虚构资料。'); return;
    }
    if (await commitMutation(() => { Object.assign(projects, plan.snapshot.projects); records.push(...plan.snapshot.records); })) {
      project = plan.projectId; byId('pv-search').value = ''; selectRecord(null);
      ui.toast('标准示例已导入', '已创建独立项目，可以自由编辑或删除。');
    }
  });
  byId('pv-project-create-cancel').addEventListener('click', () => { byId('pv-project-create').hidden = true; });
  byId('pv-project-create-save').addEventListener('click', async () => {
    const name = byId('pv-project-name').value.trim(); if (!name) { feedback('请输入项目名称'); return; }
    const id = crypto.randomUUID();
    if (await commitMutation(() => { projects[id] = name; })) { project = id; byId('pv-project-create').hidden = true; byId('pv-project-name').value = ''; byId('pv-search').value = ''; selectRecord(null); feedback('项目已创建'); }
  });
  byId('pv-export-format').addEventListener('change', () => { exportFormat = byId('pv-export-format').value; exportSourceView = false; renderExport(); refreshIcons(); saveChoice(); });
  byId('pv-export-scope').addEventListener('change', () => { exportScope = byId('pv-export-scope').value; renderExport(); refreshIcons(); saveChoice(); });
  byId('pv-export-preview-button').addEventListener('click', () => { exportSourceView = false; renderExport(); refreshIcons(); saveChoice(); });
  byId('pv-export-source-button').addEventListener('click', () => { exportSourceView = true; renderExport(); refreshIcons(); saveChoice(); });
  byId('pv-export-secrets').addEventListener('change', () => { renderExport(); refreshIcons(); });
  byId('pv-export-copy').addEventListener('click', () => copyText(exportText(), byId('pv-export-copy')));
  byId('pv-export-save').addEventListener('click', async () => {
    try { const result = await api.saveFile({ name: exportFilename(), content: exportText(), format: exportFormat }); if (!result.canceled) { feedback('已导出：' + result.name); ui.toast('导出成功', result.name); } }
    catch (error) { showFailure(error); }
  });
  byId('pv-data-directory').addEventListener('click', async () => { try { await api.openDataDirectory(); } catch (error) { showFailure(error); } });
  byId('pv-github').addEventListener('click', async () => { try { await api.openExternal(repositoryUrl); } catch (error) { showFailure(error); } });
  api.onCommand(command => { if (command === 'import' || command === 'export') setRoute(command); });
  root.addEventListener('click', event => {
    const link = event.target.closest('a[href]'); if (!link) return;
    event.preventDefault(); api.openExternal(link.href).catch(showFailure);
  });
  render();
  createUpdateControls(root, { api, ui, refreshIcons, platform, canInstall: () => {
    if (saving || deleting || renaming) return '请等待当前操作完成。';
    if (!storageReady) return '请先成功读取资料库。';
    if (route === 'import' || !byId('pv-project-create').hidden) return '请先保存或退出当前编辑，再安装更新。';
    return '';
  } });
  document.body.dataset.appReady = 'true';

})();
