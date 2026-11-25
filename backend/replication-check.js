// Đọc document trực tiếp từ MỌI member khoẻ của một shard (Primary + Secondary), kèm vai trò.
// Trả về từng bản đọc thô để UI hiển thị nguyên văn; không kết luận thay người xem.
// document = null nghĩa là node đó chưa có bản ghi (replication chưa kịp) hoặc đọc lỗi (có error).
async function readMemberCopies(docId, clients, getReplicaSetStatus) {
  const status = await getReplicaSetStatus(clients);

  // clients[index] khớp members[index] vì cùng thứ tự khai báo.
  const reads = status.members.map(async (member, index) => {
    if (member.health !== 1 || !['PRIMARY', 'SECONDARY'].includes(member.stateStr)) return null;
    const role = member.stateStr;
    try {
      const document = await clients[index]
        .db('seminar')
        .collection('documents')
        .findOne({ docId }, { readPreference: role === 'PRIMARY' ? 'primary' : 'secondary' });
      return { node: member.name, role, document };
    } catch (error) {
      return { node: member.name, role, document: null, error: error.message };
    }
  });

  return (await Promise.all(reads)).filter(Boolean);
}

module.exports = { readMemberCopies };
