const test = require('node:test');
const assert = require('node:assert/strict');
const bundle = require('../examples/project-vault-example.json');
const { createExampleStore, planExampleImport } = require('../examples/catalog.cjs');

test('standard bundle can restore all four original formats with valid JSON and ENV groups', () => {
  assert.equal(bundle.kind, 'project-vault'); assert.equal(bundle.version, 1);
  assert.deepEqual(bundle.files.map(file => file.format).sort(), ['env', 'json', 'markdown', 'text']);
  assert.equal(new Set(bundle.files.map(file => file.name)).size, 4);
  const configuration = JSON.parse(bundle.files.find(file => file.format === 'json').content);
  assert.equal(configuration.demo_only, true);
  const env = bundle.files.find(file => file.format === 'env').content;
  for (const group of ['app', 'database', 'redis', 'storage']) assert.ok(env.includes('[' + group + ']'));
  for (const file of bundle.files) {
    assert.ok(file.content.length > 100); assert.ok(!file.content.includes('{{'));
    const addresses = file.content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    for (const address of addresses) assert.ok(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.0\.0\.)/.test(address), 'Example IP must be reserved for documentation.');
  }
});

test('editing a seeded example never changes the reusable standard data', () => {
  const first = createExampleStore(); first.records[0].source = 'My own changes'; first.projects.example = 'My project';
  const second = createExampleStore();
  assert.equal(second.projects.example, bundle.project); assert.equal(second.records[0].source, bundle.files[0].content);
});

test('import reuses a complete existing example without allocating IDs or changing data', () => {
  const store = createExampleStore(), before = JSON.stringify(store);
  const result = planExampleImport(store, () => { throw new Error('Should not allocate IDs'); });
  assert.deepEqual(result, { existingProjectId: 'example' }); assert.equal(JSON.stringify(store), before);
});

test('import preserves modified examples and creates unique project and record IDs', () => {
  const store = createExampleStore(); store.records[0].source += '\nPersonal notes';
  const before = JSON.stringify(store); let counter = 0;
  const plan = planExampleImport(store, () => 'new-' + ++counter);
  assert.equal(JSON.stringify(store), before); assert.equal(plan.snapshot.projects[plan.projectId], bundle.project + ' (2)');
  assert.equal(new Set([plan.projectId, ...plan.snapshot.records.map(record => record.id)]).size, 5);
  const next = { ...store, projects: { ...store.projects, ...plan.snapshot.projects }, records: [...store.records, ...plan.snapshot.records] };
  assert.deepEqual(planExampleImport(next, () => { throw new Error('Should reuse the complete second example'); }), { existingProjectId: plan.projectId });
});
