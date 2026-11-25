const assert = require('node:assert/strict');
const test = require('node:test');
const { readMemberCopies } = require('./replication-check');

test('reads the document from every healthy member with the matching read preference', async () => {
  const calls = [];
  const sample = { docId: 'demo-00042', value: 42 };
  const makeClient = (member, result) => ({
    db: () => ({
      collection: () => ({
        findOne: async (filter, options) => {
          calls.push({ member, filter, options });
          if (result instanceof Error) throw result;
          return result;
        },
      }),
    }),
  });
  const clients = [
    makeClient('shard1a', sample),
    makeClient('shard1b', new Error('Offline member must not be queried')),
    makeClient('shard1c', new Error('connection reset')),
  ];
  const status = {
    members: [
      { name: 'shard1a:27017', stateStr: 'PRIMARY', health: 1 },
      { name: 'shard1b:27017', stateStr: 'SECONDARY', health: 0 },
      { name: 'shard1c:27017', stateStr: 'SECONDARY', health: 1 },
    ],
  };

  const result = await readMemberCopies('demo-00042', clients, async () => status);

  assert.deepEqual(result, [
    { node: 'shard1a:27017', role: 'PRIMARY', document: sample },
    { node: 'shard1c:27017', role: 'SECONDARY', document: null, error: 'connection reset' },
  ]);
  assert.deepEqual(calls, [
    { member: 'shard1a', filter: { docId: 'demo-00042' }, options: { readPreference: 'primary' } },
    { member: 'shard1c', filter: { docId: 'demo-00042' }, options: { readPreference: 'secondary' } },
  ]);
});
