const assert = require('node:assert/strict');
const test = require('node:test');
const { shardsFromExplain } = require('./shard-routing');

test('reads shard names from a targeted and a scatter plan', () => {
  const targeted = { queryPlanner: { winningPlan: { stage: 'SINGLE_SHARD', shards: [{ shardName: 'shard1' }] } } };
  const scatter = {
    queryPlanner: {
      winningPlan: { stage: 'SHARD_MERGE', shards: [{ shardName: 'shard1' }, { shardName: 'shard2' }] },
    },
  };
  assert.deepEqual(shardsFromExplain(targeted), ['shard1']);
  assert.deepEqual(shardsFromExplain(scatter), ['shard1', 'shard2']);
  assert.equal(shardsFromExplain({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }), null);
});
