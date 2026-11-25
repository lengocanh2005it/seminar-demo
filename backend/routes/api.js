// Toàn bộ logic demo nằm ở file này: đọc trạng thái cụm, seed dữ liệu, kiểm tra bản sao
// và stop/start container để mô phỏng failover. app.js chỉ là lớp HTTP.
const { randomUUID } = require('node:crypto');
const Docker = require('dockerode');
const express = require('express');
const { MongoClient } = require('mongodb');
const { readMemberCopies } = require('../replication-check');
const { shardsFromExplain } = require('../shard-routing');

const router = express.Router();
// Client chính nối tới mongos (router). retryWrites để driver tự thử lại một lần
// khi gặp lỗi mạng thoáng qua trong lúc bầu cử Primary.
const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/seminar?retryWrites=true', {
  serverSelectionTimeoutMS: 5000,
});
// Docker Desktop bản mới (context desktop-linux) chỉ mở pipe dockerDesktopLinuxEngine,
// bản cũ dùng docker_engine — hard-code một cái là hỏng trên máy kia. Windows không
// kiểm tra được pipe bằng fs, nên ping thử từng cái một lần rồi nhớ cái chạy được.
const windowsDockerPipes = ['//./pipe/dockerDesktopLinuxEngine', '//./pipe/docker_engine'];
let dockerPromise;
function dockerClient() {
  const socketPath = process.env.DOCKER_SOCKET || (process.platform === 'win32' ? null : '/var/run/docker.sock');
  if (socketPath) return Promise.resolve(new Docker({ socketPath }));
  dockerPromise ??= (async () => {
    for (const pipe of windowsDockerPipes) {
      const candidate = new Docker({ socketPath: pipe });
      try {
        await candidate.ping();
        return candidate;
      } catch {}
    }
    throw new Error(`Không kết nối được Docker Desktop (đã thử ${windowsDockerPipes.join(', ')})`);
  })();
  // Lỗi thì bỏ cache để lần sau thử lại thay vì kẹt vĩnh viễn ở promise đã reject.
  dockerPromise.catch(() => { dockerPromise = undefined; });
  return dockerPromise;
}
// Allowlist: backend chỉ được điều khiển 3 node của shard1. Primary map sang node
// ngoài danh sách này thì từ chối, tránh tắt nhầm shard2 hoặc config server.
const demoContainers = {
  shard1a: { host: 'shard1a:27017', container: 'seminar-shard1a' },
  shard1b: { host: 'shard1b:27017', container: 'seminar-shard1b' },
  shard1c: { host: 'shard1c:27017', container: 'seminar-shard1c' },
};
// directConnection: nối thẳng vào đúng một member, bỏ qua mongos — cần để đọc
// bản sao trên một Secondary cụ thể.
const makeMemberClient = (port) => new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  serverSelectionTimeoutMS: 1000,
});
// Thứ tự client khớp thứ tự members mà replSetGetStatus trả về (cùng thứ tự khai báo lúc init).
const shardClients = {
  shard1: [makeMemberClient(27117), makeMemberClient(27118), makeMemberClient(27119)],
  shard2: [makeMemberClient(27217), makeMemberClient(27218), makeMemberClient(27219)],
};
const events = [];
// Bằng chứng bản sao (nguyên document đọc từ từng node), mới nhất ở đầu; giữ trong RAM như events.
const proofs = [];
const streams = new Set();
let lastSnapshot = "";
let lastStatus = null;
let pushing = false;
let immediateOffline = null;
let stoppedContainer = null;
let lastPrimaries = {};
const cachedDocIds = new Map();

// Primary có thể đang tắt, nên thử lần lượt từng member tới khi có node trả lời.
async function getReplicaSetStatus(members) {
  let lastError;
  for (const member of members) {
    try {
      return await member.db('admin').command({ replSetGetStatus: 1 });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function log(operation, message, id = randomUUID().slice(0, 8)) {
  const event = { id, at: new Date().toISOString(), operation, message };
  events.unshift(event);
  events.length = Math.min(events.length, 60);
  console.log(`[${event.at}] [${id}] [${operation}] ${message}`);
}

// Đẩy snapshot trạng thái cho mọi SSE client.
// offlineHost: node vừa bị stop — đánh dấu OFFLINE ngay thay vì chờ heartbeat MongoDB (~10s).
// lastSnapshot: bỏ qua nếu không đổi; pushing: chặn hai lần push chồng nhau.
async function pushSnapshot(offlineHost) {
  if (offlineHost) immediateOffline = offlineHost;
  if (pushing || !streams.size) return;
  pushing = true;
  try {
    const offlineHost = immediateOffline;
    immediateOffline = null;
    let status;
    try {
      status = offlineHost && lastStatus
        ? { ...lastStatus, stoppedNode: stoppedContainer, replicaSets: lastStatus.replicaSets.map((set) => ({
            ...set,
            members: set.members.map((member) => member.name === offlineHost
              ? { ...member, state: 'OFFLINE', health: 0 }
              : member),
          })) }
        : await getStatus();
      if (!offlineHost) lastStatus = status;
    } catch {
      // Cụm chết: vẫn đẩy connected=false để UI không báo "Đã kết nối cụm" giả.
      status = { ...(lastStatus || {}), connected: false };
    }
    const snapshot = JSON.stringify({ status, events, proofs });
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    for (const response of streams) {
      try {
        response.write(`data: ${snapshot}\n\n`);
      } catch {
        streams.delete(response);
      }
    }
  } finally {
    pushing = false;
  }
}

// Wrapper chung cho mọi action: log lỗi, trả JSON, rồi push snapshot ngay
// để UI không phải chờ nhịp 1 giây.
function endpoint(handler) {
  return async (req, res, next) => {
    const id = randomUUID().slice(0, 8);
    res.locals.operationId = id;
    try {
      const result = await handler(id);
      res.json(result);
      setImmediate(() => pushSnapshot(result?.offlineHost));
    } catch (error) {
      log('error', error.message, id);
      next(error);
      setImmediate(pushSnapshot);
    }
  };
}

async function getStatus() {
  const database = client.db('seminar');
  const collection = database.collection('documents');
  const [hello, shards, distribution, total, replicaStatuses] = await Promise.all([
    client.db('admin').command({ hello: 1 }),
    client.db('admin').command({ listShards: 1 }),
    // storageStats.count = số document vật lý trên từng shard; total bên dưới là tổng toàn cụm.
    // Collection chưa tồn tại (chưa chạy sharding-init) thì trả rỗng thay vì làm hỏng cả /status.
    collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray().catch(() => []),
    collection.countDocuments({}),
    Promise.all(Object.entries(shardClients).map(async ([name, replicaClient]) => {
      const status = await getReplicaSetStatus(replicaClient);
      const members = status.members.map((member) => ({
        name: member.name,
        state: member.stateStr,
        health: member.health,
      }));
      const primary = members.find((member) => member.state === 'PRIMARY')?.name ?? null;
      // So với lần đọc trước để log sự kiện bầu cử Primary mới.
      if (lastPrimaries[name] && primary && lastPrimaries[name] !== primary) {
        log('failover', `${name}: new primary observed ${primary} (previous ${lastPrimaries[name]})`);
      }
      if (primary) lastPrimaries[name] = primary;
      return { name, primary, members };
    })),
  ]);

  return {
    connected: hello.ok === 1,
    // hello trên mongos trả msg "isdbgrid" — hiển thị thẳng ra UI thì vô nghĩa với
    // người xem, nên đổi lại đúng tên thành phần.
    router: hello.msg === 'isdbgrid' ? 'mongos' : hello.msg || 'mongos',
    shards: shards.shards.map((shard) => ({ id: shard._id, host: shard.host })),
    distribution: distribution.map((stat) => ({
      shard: stat.shard,
      documents: stat.storageStats?.count ?? 0,
    })),
    totalDocuments: total,
    replicaSets: stoppedContainer && demoContainers[stoppedContainer]
      ? replicaStatuses.map((set) => ({
          ...set,
          members: set.members.map((member) => member.name === demoContainers[stoppedContainer].host
            ? { ...member, state: 'OFFLINE', health: 0 }
            : member),
        }))
      : replicaStatuses,
    stoppedNode: stoppedContainer,
  };
}

// Upsert theo docId + $setOnInsert => bấm nhiều lần không nhân đôi dữ liệu.
// bulkWrite theo lô 500 để 10.000 document không thành 10.000 round trip.
async function seedDocuments(id) {
  const collection = client.db('seminar').collection('documents');
  let inserted = 0;
  const batchSize = 500;
  for (let start = 1; start <= 10000; start += batchSize) {
    const operations = Array.from({ length: Math.min(batchSize, 10001 - start) }, (_, index) => {
      const n = start + index;
      const docId = `demo-${String(n).padStart(5, '0')}`;
      return {
        updateOne: {
          filter: { docId },
          update: {
            $setOnInsert: {
              docId,
              category: ['seminar', 'replication', 'sharding'][n % 3],
              value: n,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          },
          upsert: true,
        },
      };
    });
    inserted += (await collection.bulkWrite(operations, { ordered: false })).upsertedCount;
  }
  const total = await collection.countDocuments({});
  log('seed', `Inserted ${inserted} new documents; collection total=${total}`, id);
  return { inserted, total };
}

// Ghi -> đọc lại -> xoá trong finally: lỗi giữa chừng cũng không để rác lại collection.
async function testReadWrite(id) {
  const collection = client.db('seminar').collection('documents');
  // Chọn docId có hash rơi đúng shard1 để bước 05 chứng minh được Primary mới của
  // shard1 vẫn nhận ghi, thay vì "ghi đâu đó trong cụm rồi tin là thành công".
  const shard1DocId = await pickDocIdForShard('shard1', (n) => `probe-${String(n).padStart(2, '0')}`);
  const docId = shard1DocId || `test-${id}`;
  try {
    await collection.insertOne({ docId, purpose: 'failover-check', createdAt: new Date() });
    const found = await collection.findOne({ docId });
    if (!found) throw new Error('Write succeeded but read did not find the document');
    const primary = shard1DocId ? await primaryOfShard('shard1') : null;
    const target = shard1DocId
      ? `shard1${primary ? ` · Primary ${primary}` : ''} · targeted`
      : 'shard unknown (collection not sharded or not created yet)';
    log('read-write', `Read/write succeeded via mongos (${docId}) → ${target}`, id);
    return { ok: true, docId, shard: shard1DocId ? 'shard1' : null, primary };
  } finally {
    await collection.deleteOne({ docId }).catch(() => {});
  }
}

// Hỏi mongos xem query equality trên docId bị scatter hay chỉ chạm một shard.
async function explainShards(docId) {
  try {
    const plan = await client
      .db('seminar')
      .collection('documents')
      .find({ docId })
      .explain('queryPlanner');
    const shards = shardsFromExplain(plan);
    return { sharded: shards !== null, shards: shards || [] };
  } catch {
    return { sharded: false, shards: [] };
  }
}

// Tìm một docId rơi vào shard mong muốn. Với khóa hashed, ~50% ứng viên khớp nên
// vòng lặp gần như dừng ở lần thử đầu.
// makeId(n) sinh docId ứng viên; kết quả cache theo (shard, kiểu id) để các lần bấm sau
// luôn cùng một docId — điều kiện để so sánh trước/sau failover trên đúng một bản ghi.
async function pickDocIdForShard(shardName, makeId) {
  const cacheKey = `${shardName}:${makeId(1)}`;
  if (cachedDocIds.has(cacheKey)) return cachedDocIds.get(cacheKey);
  for (let n = 1; n <= 50; n += 1) {
    const docId = makeId(n);
    const { sharded, shards } = await explainShards(docId);
    if (!sharded) return null;
    // Chunk có thể vừa migrate giữa lúc explain và lúc ghi; xác suất thấp ở demo này.
    if (shards.length === 1 && shards[0] === shardName) {
      cachedDocIds.set(cacheKey, docId);
      return docId;
    }
  }
  return null;
}

// Primary hiện tại của shard — đọc lại lúc trả log để tên node khớp đúng thời điểm.
async function primaryOfShard(shardName) {
  const members = shardClients[shardName];
  if (!members) return null;
  try {
    const status = await getReplicaSetStatus(members);
    return status.members.find((member) => member.stateStr === 'PRIMARY')?.name ?? null;
  } catch {
    return null;
  }
}

// Đọc một bản ghi cố định của shard1 qua mongos, rồi đọc lại nguyên document đó trực tiếp từ
// từng member khoẻ (Primary + Secondary) và so khớp toàn bộ trường. Cùng docId ở mọi lần bấm
// nên bản chụp trước/sau failover so sánh được với nhau. Bản chụp lưu vào `proofs` để UI
// hiển thị nguyên văn thay vì chỉ một dòng log.
async function captureReplicationProof(id, trigger) {
  const collection = client.db('seminar').collection('documents');
  const docId = (await pickDocIdForShard('shard1', (n) => `demo-${String(n).padStart(5, '0')}`)) ?? 'demo-00001';
  const viaMongos = await collection.findOne({ docId });
  if (!viaMongos) throw new Error('Generate sample data before verifying a replica copy');

  const copies = await readMemberCopies(docId, shardClients.shard1, getReplicaSetStatus);
  const secondaries = copies.filter((copy) => copy.role === 'SECONDARY' && copy.document);
  if (!secondaries.length) throw new Error(`No healthy Secondary has ${docId} yet; wait briefly and retry`);
  // Replica giữ nguyên thứ tự trường của oplog nên so chuỗi JSON là đủ chặt cho demo này.
  const expected = JSON.stringify(viaMongos);
  if (copies.some((copy) => copy.document && JSON.stringify(copy.document) !== expected)) {
    throw new Error(`Replica copy of ${docId} does not match`);
  }

  proofs.unshift({
    id,
    trigger,
    at: new Date().toISOString(),
    docId,
    shard: 'shard1',
    stoppedNode: stoppedContainer,
    primary: copies.find((copy) => copy.role === 'PRIMARY')?.node ?? null,
    viaMongos,
    copies,
  });
  proofs.length = Math.min(proofs.length, 4);

  return { docId, secondaries: secondaries.map((copy) => copy.node), primary: proofs[0].primary };
}

async function verifyReplication(id) {
  const { docId, secondaries } = await captureReplicationProof(id, 'manual');
  log('replication', `Verified ${docId} on Secondary ${secondaries.join(', ')} (shard1)`, id);
  return { ok: true, docId, shard: 'shard1', secondaries };
}

// Không hard-code node nào là Primary: hỏi replica set trước, vì sau mỗi lần bầu cử
// Primary có thể đổi. Host tìm được phải map vào allowlist ở trên.
async function stopCurrentPrimary(id) {
  if (stoppedContainer) throw new Error(`Restart ${stoppedContainer} before stopping another Primary`);
  const status = await getReplicaSetStatus(shardClients.shard1);
  const primary = status.members.find((member) => member.stateStr === 'PRIMARY');
  const target = Object.entries(demoContainers).find(([, node]) => node.host === primary?.name);
  if (!target) throw new Error('Could not map Shard 1 Primary to an allowed demo container');
  const [nodeName, node] = target;
  // Chụp bản "trước failover" ngay trước khi tắt. Lỗi (vd chưa seed) không được chặn việc tắt node.
  try {
    const before = await captureReplicationProof(id, 'before-stop');
    log('replication', `Captured pre-failover copy of ${before.docId} (Primary ${before.primary})`);
  } catch (error) {
    log('replication', `Skipped pre-failover copy: ${error.message}`);
  }
  const container = (await dockerClient()).getContainer(node.container);
  const info = await container.inspect();
  // Log trước khi dừng: docker stop mất ~1s, trong lúc đó Primary cũ nhường vai nên log
  // "Primary mới" có thể đến trước log "Đã tắt". Dòng này giữ đúng thứ tự nhân quả cho người xem.
  log('failover', `Stopping current Primary ${nodeName} (${node.container})`);
  if (info.State.Running) await container.stop({ t: 1 });
  stoppedContainer = nodeName;
  log('failover', `Stopped current Primary ${nodeName} (${node.container})`, id);
  return { stoppedNode: nodeName, primary: primary.name, offlineHost: node.host };
}

// stoppedContainer chỉ nằm trong RAM — restart backend giữa chừng sẽ mất trạng thái này.
async function restartStoppedNode(id) {
  if (!stoppedContainer || !demoContainers[stoppedContainer]) {
    throw new Error('No stopped Shard 1 node is recorded. Stop the current Primary first.');
  }
  const nodeName = stoppedContainer;
  const container = (await dockerClient()).getContainer(demoContainers[nodeName].container);
  const info = await container.inspect();
  if (!info.State.Running) await container.start();
  stoppedContainer = null;
  log('restart', `Restarted ${nodeName}; waiting for it to rejoin the replica set`, id);
  return { restartedNode: nodeName };
}

router.get('/health', (req, res) => res.json({ ok: true }));
// SSE: giữ kết nối HTTP mở và đẩy JSON mỗi khi trạng thái đổi. Frontend không polling;
// EventSource tự reconnect nếu đứt, nên không cần logic thử lại ở client.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  streams.add(res);
  lastSnapshot = "";
  res.write(': connected\n\n');
  req.on('close', () => streams.delete(res));
  setImmediate(pushSnapshot);
});
router.get('/status', endpoint(async () => getStatus()));
router.get('/events', (req, res) => res.json({ events, proofs }));
router.post('/seed', endpoint(seedDocuments));
router.post('/verify-replication', endpoint(verifyReplication));
router.post('/failover/stop-primary', endpoint(stopCurrentPrimary));
router.post('/failover/restart-node', endpoint(restartStoppedNode));
router.post('/test-read-write', endpoint(testReadWrite));

// Tick 1 giây vẫn cần: replica set có thể đổi trạng thái (bầu cử) mà không có action nào từ UI.
setInterval(pushSnapshot, 1000);

module.exports = router;
