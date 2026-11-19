// Tìm bản sao của document trên một node Secondary. Trả null nếu chưa node nào có
// (ví dụ vừa ghi xong, replication chưa kịp).
async function findSecondaryCopy(docId, shardClients, getReplicaSetStatus) {
  let lastError;

  for (const [shard, clients] of Object.entries(shardClients)) {
    let status;
    try {
      status = await getReplicaSetStatus(clients);
    } catch (error) {
      lastError = error;
      continue;
    }

    // Chỉ xét Secondary đang khoẻ; clients[index] khớp members[index] vì cùng thứ tự khai báo.
    for (const [index, member] of status.members.entries()) {
      if (member.stateStr !== 'SECONDARY' || member.health !== 1) continue;

      let document;
      try {
        document = await clients[index]
          .db('seminar')
          .collection('documents')
          .findOne({ docId }, { readPreference: 'secondary' });
      } catch (error) {
        lastError = error;
        continue;
      }

      if (document) return { shard, secondary: member.name, document };
    }
  }

  // Không tìm thấy bản sao; nếu có lỗi kết nối thì ném lỗi gốc để dễ debug.
  if (lastError) throw lastError;
  return null;
}

module.exports = { findSecondaryCopy };
