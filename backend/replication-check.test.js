const assert = require('node:assert/strict');
const test = require('node:test');
const { findSecondaryCopy } = require('./replication-check');

test('finds the sample on a healthy Secondary using secondary reads', async () => {
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
  const primary = makeClient('primary', new Error('Primary must not be queried'));
  const unhealthy = makeClient('unhealthy', new Error('Unhealthy member must not be queried'));
  const lagging = makeClient('lagging', new Error('Try another Secondary'));
  const secondary = makeClient('shard2b:27017', sample);
  const shard1 = [primary, unhealthy, lagging];
  const shard2 = [makeClient('shard2a:27017', null), secondary];
  const statuses = new Map([
    [shard1, {
      members: [
        { name: 'shard1a:27017', stateStr: 'PRIMARY', health: 1 },
        { name: 'shard1b:27017', stateStr: 'SECONDARY', health: 0 },
        { name: 'shard1c:27017', stateStr: 'SECONDARY', health: 1 },
      ],
    }],
    [shard2, {
      members: [
        { name: 'shard2a:27017', stateStr: 'PRIMARY', health: 1 },
        { name: 'shard2b:27017', stateStr: 'SECONDARY', health: 1 },
      ],
    }],
  ]);

  const result = await findSecondaryCopy('demo-00042', { shard1, shard2 }, async (clients) => statuses.get(clients));

  assert.deepEqual(result, { shard: 'shard2', secondary: 'shard2b:27017', document: sample });
  assert.deepEqual(calls, [
    { member: 'lagging', filter: { docId: 'demo-00042' }, options: { readPreference: 'secondary' } },
    { member: 'shard2b:27017', filter: { docId: 'demo-00042' }, options: { readPreference: 'secondary' } },
  ]);
});
