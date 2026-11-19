# Demo guide: Sharding + Replication with MongoDB

For team members: how to run the demo, the 6-step talk track for presenting to the class, and answers to common questions.

## What this demo proves

The local MongoDB cluster has 2 shards, each a 3-node replica set:

```
React UI + Express API  (localhost:5173 / 4000)
            │
            ▼
         mongos  (localhost:27017)      ← router, the app only talks to this node
        /              \
   shard1RS           shard2RS          ← sharding: splits data horizontally
  shard1a            shard2a
  shard1b            shard2b            ← replication: each shard keeps 3 copies
  shard1c            shard2c
        \              /
         configRS (config1, config2, config3)  ← stores chunk/shard metadata
```

- **Sharding (horizontal):** 10,000 documents `demo-00001`…`demo-10000` are spread across shard1 and shard2 by `hash(docId)`. Each document lives physically on exactly one shard.
- **Replication (vertical):** within each shard all 3 nodes hold a copy of the same data. One node is **Primary** (accepts writes), two are **Secondary**.
- **Failover:** when the Primary dies, the replica set elects a new Primary within seconds. The app keeps writing with no config change.

## Running the demo

Requirements: Docker Desktop running, Node.js installed. Open PowerShell in the repo directory.

```powershell
# 1. Start the MongoDB cluster (first run takes a while: replica sets are created)
docker compose up -d mongos
docker compose ps -a          # wait for seminar-mongos to be healthy

# 2. Configure sharding — run once per fresh set of volumes
docker compose up sharding-init

# 3. Backend (first PowerShell window)
cd E:\seminar-demo\backend
npm ci
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/seminar?retryWrites=true"
npm start

# 4. Frontend (second window)
cd E:\seminar-demo\frontend
npm ci
npm run dev
```

Open <http://localhost:5173>. If you have run it before, the data is still in the Docker volumes, so you can skip `sharding-init` (re-running it is safe — the script checks for existing state).

The backend controls Docker through Docker Desktop's named pipe, but may only stop/start the 3 allowlisted containers `seminar-shard1a|b|c`. It never touches shard2 or the config servers.

## The 6-step UI walkthrough

After each step, point at the **cluster map** or the **terminal** below so the class sees the result. The UI updates over SSE, so no F5 needed.

### Step 01 — Generate sample data

Click **Tạo dữ liệu mẫu** (Generate sample data). The backend upserts 10,000 documents into `seminar.documents` through `mongos`.

> Say: "The app doesn't know where the data lives. It hands a document to `mongos`, which hashes `docId` and decides which shard gets it."

Result: the **distribution bar** shows roughly 5,009 / 4,991 documents.

> Say: "Not exactly 5,000/5,000 because hashing splits by value range; MongoDB doesn't promise an even split. These numbers are **physical documents**, not live node counts."

Clicking step 01 again does not add data — the upsert keys on `docId`.

### Step 02 — Test read / write

Click **Thử đọc / ghi** (Test read/write). The backend first runs `explain` on `mongos` to find a `docId` that routes to **shard1**, then inserts that temporary document, reads it back, and deletes it.

> Say: "The write goes through the router; the router picks a shard by hash; then the replica set picks that shard's Primary to write. I deliberately picked a key that lands on shard1, so you can see which node accepted it."

Result: the terminal logs the `docId`, the shard (`shard1`) and **which member is Primary at that moment**. This proves shard1 itself accepted the write, not just "some shard in the cluster".

### Step 03 — Verify a replica copy

Click **Kiểm tra bản sao** (Verify replica copy). The backend picks a `demo-*` document, finds the shard holding it, then connects **directly** to a Secondary to read it.

> Say: "This is the proof of replication: the same record exists on a Secondary node, not just the Primary. With only one copy, that node dying would mean data loss."

Result: the terminal names the Secondary and shard where the copy was read.

### Step 04 — Stop Shard 1's Primary

Click **Tắt Primary của Shard 1** (Stop Shard 1 Primary). The backend reads the replica set status to find the current Primary, then runs `docker stop` on exactly that container.

> Say: "I'm not stopping a fixed node name. The backend asks the replica set who the Primary is and only then stops it, because the Primary can change after each election."

Result: after ~2 seconds the node's card turns **red / Unavailable** on the map.

> Say: "The node is dead, but its data still has 2 copies on the other two nodes."

### Step 05 — Verify the new Primary can write

Wait until the map shows a different node as **PRIMARY** in shard1 (usually a few seconds), then **click step 02 again**.

> Say: "The replica set just elected a new Primary. I'll run read/write again — it still succeeds, even though the old Primary is down."

The test document is chosen so that `mongos` routes it to **shard1**, and the terminal prints the Primary that served the write. So the claim is checkable: that node name in the terminal should match the new **PRIMARY** on the cluster map. If they differ, the log is telling you the truth and the map is one second behind — say so instead of guessing.

> Say: "This is the key difference: replication keeps the write **alive**; sharding decides **which shard** the write lives on. Killing one node doesn't change the 5,009/4,991 split, because the documents still belong to the same shards — only the replica set inside shard1 elected a new Primary."

### Step 06 — Restart the stopped node

Click **Khởi động lại node đã tắt** (Restart stopped node). The backend runs `docker start` on the container it stopped.

> Say: "The node comes back as a **Secondary**, it doesn't take the Primary role back. It syncs the data it missed from the current Primary."

Result: the card is no longer red, and the label is SECONDARY.

## Questions the class may ask

**Why isn't the split exactly 5,000/5,000?**
Hashing splits data by value range, not by counting documents. With 10,000 records, a gap of a few dozen is normal. MongoDB does not guarantee an even split.

**After the Primary is stopped, where do writes go?**
The replica set elects a new Primary within that shard. `mongos` updates its topology automatically and sends writes to the new Primary; the app doesn't need to know.

**What if 2 of the 3 nodes are down?**
With one node left there is no majority (2/3), so no Primary can be elected and **writes fail**. This is why replica sets use an odd node count and a minimum of 3.

**Why do we need `mongos`?**
The app connects to a single address. `mongos` uses metadata from the config servers to know which chunk sits on which shard, and merges results from multiple shards.

**Why does the UI update so fast?**
The backend pushes state over SSE (`GET /api/stream`) instead of the frontend polling. When you click stop, the backend also marks the node OFFLINE immediately instead of waiting for the MongoDB heartbeat (~10 seconds).

**Is data lost when the machine shuts down?**
No. Data lives in Docker named volumes. `docker compose down` keeps the volumes; only `docker compose down -v` wipes them.

## Cleanup after the demo

```powershell
# Stop containers, keep data for next time
docker compose down

# Remove all demo data too
docker compose down -v
```

Stop the two `npm start` / `npm run dev` windows (Ctrl+C) before shutting the machine down.

## Common problems

- **`mongos` never becomes healthy:** check `docker compose logs replica-sets-init mongos`. Usually a stale volume with a half-configured replica set — try `docker compose down -v` and start over.
- **UI shows "Mất kết nối luồng trực tiếp" or "Không gọi được backend ở cổng 4000":** the backend isn't running or was stopped; check the backend window and port 4000.
- **UI shows "Một node MongoDB đã tắt hoặc Docker chưa chạy":** Docker Desktop was closed or a container died; run `docker compose ps -a`.
- **Step 06 says there is no node to restart:** the backend was restarted, so it lost the in-memory `stoppedContainer` state. Restart the backend **before** the demo, not in the middle.
- **Port already in use:** check `Get-NetTCPConnection -LocalPort 27017,4000,5173`.
- **Cannot stop the container:** the backend needs Docker Desktop running. It tries `dockerDesktopLinuxEngine` then `docker_engine`; set `DOCKER_SOCKET` to override.

## Safety notes

This configuration is for a local demo only: MongoDB has no authentication and ports bind to `127.0.0.1` only. Do not expose it to a LAN and do not use it in production.
