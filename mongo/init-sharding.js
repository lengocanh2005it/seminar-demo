// Chạy một lần sau khi mongos healthy: thêm 2 shard, bật sharding cho DB,
// rồi shard collection theo khóa băm docId.
const admin = db.getSiblingDB("admin");
const shardNames = new Set(admin.runCommand({ listShards: 1 }).shards.map((shard) => shard._id));

// addShard idempotent theo tên: shard đã có thì bỏ qua (an toàn khi chạy lại).
for (const [name, connection] of [
  ["shard1", "shard1RS/shard1a:27017,shard1b:27017,shard1c:27017"],
  ["shard2", "shard2RS/shard2a:27017,shard2b:27017,shard2c:27017"],
]) {
  if (!shardNames.has(name)) {
    const result = admin.runCommand({ addShard: connection, name });
    if (result.ok !== 1) throw new Error(`Could not add ${name}: ${result.errmsg}`);
    print(`Added ${name}`);
  }
}

const enabled = admin.runCommand({ enableSharding: "seminar" });
if (enabled.ok !== 1) throw new Error(`Could not enable sharding: ${enabled.errmsg}`);
const configDb = db.getSiblingDB("config");
if (!configDb.collections.findOne({ _id: "seminar.documents", dropped: false })) {
  // Khóa hashed: MongoDB băm giá trị rồi chia theo dải hash, phân bố đều hơn khóa range.
  const result = admin.runCommand({ shardCollection: "seminar.documents", key: { docId: "hashed" } });
  if (result.ok !== 1) throw new Error(`Could not shard seminar.documents: ${result.errmsg}`);
  print("Sharded seminar.documents by hashed docId");
}

print("Sharded cluster is ready");
