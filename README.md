# MongoDB sharding and replication seminar demo

MongoDB runs in Docker. The Node.js API and React/Vite UI run directly on Windows so the backend can use Docker Desktop to stop and restart the demo Primary.

Runbook and 6-step talk track for the group: [docs/demo-guide.md](docs/demo-guide.md).

## 1. Start MongoDB

Requires Docker Desktop with Compose v2. From this directory, start only the router (Compose starts its MongoDB dependencies and the replica set/sharding setup jobs):

```powershell
docker compose up -d mongos
```

Wait for the `mongos` service to become healthy:

```powershell
docker compose ps -a
```

The cluster has two three-node shard replica sets, a three-node config server replica set, and one `mongos`. MongoDB data stays in named Docker volumes.

After `mongos` is healthy, run the sharding setup job once:

```powershell
docker compose up sharding-init
```

Backend unit tests (no cluster or Docker needed):

```powershell
cd E:\seminar-demo\backend
npm test
```

## 2. Start the backend on Windows

In a PowerShell window:

```powershell
cd E:\seminar-demo\backend
npm ci
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/seminar?retryWrites=true"
npm start
```

The backend uses Docker Desktop's Windows named pipe (auto-detecting `dockerDesktopLinuxEngine` or `docker_engine`) to control only the three allowlisted Shard 1 containers.

## 3. Start the frontend on Windows

In a second PowerShell window:

```powershell
cd E:\seminar-demo\frontend
npm ci
npm run dev
```

Open <http://localhost:5173>.

## Code map

| Question | Where to look |
| --- | --- |
| Cluster topology, ports, volumes | `docker-compose.yml` |
| Create replica sets, elect first Primary | `mongo/init-replica-sets.js` |
| Add shards, choose the hashed shard key | `mongo/init-sharding.js` |
| Read cluster status, seed, failover, SSE push | `backend/routes/api.js` |
| Read a copy directly from a Secondary | `backend/replication-check.js` |
| Pick a docId that routes to shard1, parse mongos explain | `backend/shard-routing.js` |
| CORS, error shape | `backend/app.js` |
| UI rendering, SSE client, Vietnamese log translation | `frontend/src/App.jsx` |

## Demo actions

- **Generate sample data** upserts 10,000 deterministic documents, so repeated clicks do not duplicate them.
- **Test read / write** picks a `docId` that hashes to shard1, then inserts, reads and removes it through `mongos`; the log names the shard and the Primary that served the write.
- **Stop Shard 1 Primary** discovers the current Primary from replica set status and stops only its allowlisted demo container.
- **Restart stopped node** starts that Shard 1 member again.
- The UI shows per-shard storage counts, replica set member states, and observed primary changes. Shard distribution is not guaranteed to be 50/50.

## Local-only notes

MongoDB has no authentication in this classroom setup. `mongos` and the six shard members are published only on `127.0.0.1` for the local backend. Do not expose these ports to a network, attach untrusted containers, or adapt this configuration for production. The backend has access to Docker Desktop through its named pipe, so keep the API bound to localhost as configured.

Stop MongoDB containers and keep sample data:

```powershell
docker compose down
```

Remove the MongoDB containers and all demo database volumes:

```powershell
docker compose down -v
```
