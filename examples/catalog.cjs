const bundle = require('./project-vault-example.json');
const EXAMPLE_PROJECT_ID = 'example';
const ids = { markdown: 'guide', text: 'accounts', env: 'environment', json: 'settings' };
const notes = { markdown: '导入、预览、编辑与导出操作指南', text: '虚构账号、服务器与常用链接', env: '应用、数据库、缓存与存储分组', json: '嵌套对象、数组与不同数据类型' };

function createExampleStore(projectId = EXAMPLE_PROJECT_ID, recordId = file => ids[file.format]) {
  return {
    schemaVersion: 1,
    projects: { [projectId]: bundle.project },
    records: bundle.files.map(file => ({ id: recordId(file), project: projectId, name: file.name, format: file.format, source: file.content, note: notes[file.format] }))
  };
}

function planExampleImport(store, newId) {
  for (const [projectId, name] of Object.entries(store.projects)) {
    const records = store.records.filter(record => record.project === projectId);
    if ((name === bundle.project || name.startsWith(bundle.project + ' (')) && records.length === bundle.files.length && bundle.files.every(file => records.some(record => record.name === file.name && record.format === file.format && record.source === file.content))) return { existingProjectId: projectId };
  }
  const projectId = newId();
  const snapshot = createExampleStore(projectId, () => newId());
  let name = bundle.project;
  let suffix = 2;
  const names = new Set(Object.values(store.projects));
  while (names.has(name)) name = bundle.project + ' (' + suffix++ + ')';
  snapshot.projects[projectId] = name;
  return { projectId, snapshot };
}

module.exports = { EXAMPLE_PROJECT_ID, createExampleStore, planExampleImport };
