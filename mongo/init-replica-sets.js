// Chạy một lần lúc cụm khởi động: initiate 3 replica set (config + 2 shard) rồi chờ bầu Primary.
function connectAdmin(host) {
  return new Mongo(`mongodb://${host}:27017/admin`).getDB("admin");
}

// Container đã start nhưng mongod chưa sẵn sàng; retry tới khi ping được hoặc hết 120s.
function waitForConnection(host, deadline) {
  while (true) {
    try {
      connectAdmin(host).runCommand({ ping: 1 });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${host}: ${error.message}`);
      sleep(1000);
    }
  }
}

const sets = [
  {
    name: "configRS",
    hosts: ["config1", "config2", "config3"],
    configsvr: true,
  },
  {
    name: "shard1RS",
    hosts: ["shard1a", "shard1b", "shard1c"],
  },
  {
    name: "shard2RS",
    hosts: ["shard2a", "shard2b", "shard2c"],
  },
];

for (const set of sets) {
  const deadline = Date.now() + 120000;
  waitForConnection(set.hosts[0], deadline);
  const admin = connectAdmin(set.hosts[0]);

  // Idempotent: volume cũ đã initiate rồi thì bỏ qua.
  let initialized = false;
  try {
    initialized = admin.runCommand({ replSetGetStatus: 1 }).ok === 1;
  } catch {}

  if (!initialized) {
    const config = {
      _id: set.name,
      members: set.hosts.map((host, i) => ({ _id: i, host: `${host}:27017` })),
    };
    // Config server replica set bắt buộc có configsvr: true.
    if (set.configsvr) config.configsvr = true;
    const result = admin.runCommand({ replSetInitiate: config });
    if (result.ok !== 1) throw new Error(`Could not initiate ${set.name}: ${result.errmsg}`);
    print(`Initiated ${set.name}`);
  } else {
    print(`${set.name} already initialized`);
  }

  // Initiate xong chưa có Primary ngay; chờ tới khi một member nhận isWritablePrimary.
  const memberAdmins = set.hosts.map((host) => connectAdmin(host));
  let primary = false;
  while (Date.now() < deadline && !primary) {
    for (const memberAdmin of memberAdmins) {
      try {
        if (memberAdmin.runCommand({ hello: 1 }).isWritablePrimary === true) {
          primary = true;
          break;
        }
      } catch {}
    }
    if (!primary) sleep(1000);
  }
  if (!primary) throw new Error(`Timed out waiting for ${set.name} primary`);
  print(`${set.name} primary is ready`);
}
