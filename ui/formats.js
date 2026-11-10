// Read section boundaries without treating a quoted multiline value as configuration.
export function scanEnv(source) {
  let quote = null;
  return (source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []).filter(Boolean).map(raw => {
    const text = raw.replace(/(?:\r\n|\r|\n)$/, '');
    const ending = raw.slice(text.length);
    const continuation = quote !== null;
    const section = !continuation && text.match(/^[ \t]*\[([^\[\]\r\n]+)\][ \t]*([#;].*)?$/);
    const assignment = !continuation && !section && text.match(/^(\s*(?:export\s+)?[\w.-]+\s*=\s*)(.*)$/);
    let value = continuation ? text : assignment?.[2] || '';
    if (!continuation && /^["'`]/.test(value)) { quote = value[0]; value = value.slice(1); }
    if (quote) {
      for (let index = 0; index < value.length; index++) {
        if (value[index] === '\\' && quote !== "'") { index++; continue; }
        if (value[index] === quote) { quote = null; break; }
      }
    }
    return { raw, text, ending, continuation, section: section && section[1].trim() ? { name: section[1].trim(), comment: section[2] || '' } : null, assignment };
  });
}

export function splitEnvSections(source) {
  const sections = [];
  let current = { name: null, comment: '', body: '', source: '' };
  let hasSections = false;
  for (const line of scanEnv(source)) {
    if (line.section) {
      if (current.source.trim()) sections.push(current);
      current = { ...line.section, body: '', source: line.raw };
      hasSections = true;
    } else { current.body += line.raw; current.source += line.raw; }
  }
  if (current.source.trim()) sections.push(current);
  return hasSections ? sections : [];
}

export function maskEnv(source, sensitive) {
  let hiddenValue = false;
  return scanEnv(source).map(line => {
    if (line.continuation) return hiddenValue ? line.ending : line.raw;
    hiddenValue = Boolean(line.assignment && sensitive.test(line.assignment[1]) && line.assignment[2].trim());
    return hiddenValue ? line.assignment[1] + '[已隐藏]' + line.ending : line.raw;
  }).join('');
}

export function formatFromFilename(name) {
  if (/(^|\.)env($|\.)/i.test(name)) return 'env';
  if (/\.json$/i.test(name)) return 'json';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.txt$/i.test(name)) return 'text';
  return null;
}

export function detectContentFormat(source) {
  const text = source.trim();
  if (!text) return 'text';
  try { JSON.parse(text); return 'json'; } catch (_) { /* Continue with the other formats. */ }
  const lines = scanEnv(text).filter(line => line.text.trim() && !/^\s*[#;]/.test(line.text));
  if (lines.some(line => line.section || line.assignment) && lines.every(line => line.section || line.assignment || line.continuation)) return 'env';
  if (/^\s{0,3}(?:#{1,6}\s+|`{3,}|~{3,}|>\s+|[-*+]\s+|\d+[.)]\s+)/m.test(text) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(\S+\)|^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/m.test(text)) return 'markdown';
  if (text.startsWith('{') || /^\[\s*(?:[\[{"\d-]|true\b|false\b|null\b|$)/.test(text)) return 'json';
  return 'text';
}
