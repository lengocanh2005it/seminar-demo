// Tách riêng để test được mà không phải require api.js (file đó mở Docker client + setInterval).
// explain trên mongos trả queryPlanner.winningPlan.shards cho cả SINGLE_SHARD và SHARD_MERGE;
// collection chưa shard thì không có mảng này.
function shardsFromExplain(plan) {
  const shards = plan?.queryPlanner?.winningPlan?.shards;
  if (!Array.isArray(shards)) return null;
  return shards.map((entry) => entry.shardName).filter(Boolean);
}

module.exports = { shardsFromExplain };
