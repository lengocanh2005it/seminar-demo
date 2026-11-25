import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./App.css";

const API = "http://localhost:4000/api";

const BUSY_LABELS = {
  seed: "tạo dữ liệu mẫu",
  "read-write": "thử đọc / ghi",
  replication: "kiểm tra bản sao",
  stop: "tắt Primary",
  restart: "khởi động lại node",
};

// Gọi REST tới backend; body lỗi luôn có { error } nên hiển thị thẳng được.
async function request(path, method = "GET") {
  const response = await fetch(`${API}${path}`, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Yêu cầu thất bại (${response.status})`);
  return body;
}

function StatePill({ state }) {
  const primary = state === "PRIMARY";
  return <span className={`state-pill ${primary ? "primary" : "secondary"}`}>{state || "KHÔNG RÕ"}</span>;
}

// Lỗi mạng của fetch/driver là tiếng Anh kỹ thuật; đổi sang câu nói được trước lớp.
function describeError(message) {
  if (/Failed to fetch|Load failed/i.test(message)) return "Không gọi được backend ở cổng 4000. Kiểm tra cửa sổ backend còn chạy không.";
  if (/ECONNREFUSED 127\.0\.0\.1:(271|272)\d\d/.test(message)) return "Một node MongoDB đã tắt hoặc Docker chưa chạy. Kiểm tra bằng: docker compose ps -a";
  if (/Origin not allowed/i.test(message)) return "Sai địa chỉ mở UI. Hãy mở http://localhost:5173 (không dùng IP máy).";
  return message;
}

function translateEvent(message) {
  // Backend giữ log tiếng Anh (dễ grep/so khớp), chỉ dịch ở lớp hiển thị.
  return message
    .replace(/^Inserted (\d+) new documents; collection total=(\d+)$/, "Đã thêm $1 bản ghi mới; tổng collection = $2")
    .replace(/^Read\/write succeeded via mongos \((.+)\) → (.+) · targeted$/, "Đọc/ghi thành công qua mongos ($1) → $2 · đúng shard")
    .replace(/^Read\/write succeeded via mongos \((.+)\) → shard unknown \(collection not sharded or not created yet\)$/, "Đọc/ghi thành công qua mongos ($1) → chưa xác định shard (collection chưa shard hoặc chưa có dữ liệu)")
    .replace(/^Verified (.+) on Secondary (.+) \((.+)\)$/, "Đã xác minh $1 trên Secondary $2 ($3)")
    .replace(/^Captured pre-failover copy of (.+) \(Primary (.+)\)$/, "Đã chụp bản ghi $1 trước failover (Primary $2)")
    .replace(/^Skipped pre-failover copy: (.+)$/, "Bỏ qua bản chụp trước failover: $1")
    .replace(/^Stopped current Primary (.+) \((.+)\)$/, "Đã tắt Primary hiện tại $1 ($2)")
    .replace(/^(.+): new primary observed (.+) \(previous (.+)\)$/, "$1: phát hiện Primary mới $2 (trước đó $3)")
    .replace(/^Restarted (.+); waiting for it to rejoin the replica set$/, "Đã khởi động lại $1; chờ node tham gia lại replica set")
    .replace(/^Generate sample data before verifying a replica copy$/, "Hãy tạo dữ liệu mẫu trước khi kiểm tra bản sao")
    .replace(/^No healthy Secondary has (.+) yet; wait briefly and retry$/, "Chưa có Secondary khoẻ chứa $1; đợi một chút rồi thử lại")
    .replace(/^Replica copy of (.+) does not match$/, "Bản sao của $1 không khớp")
    .replace(/^Restart (.+) before stopping another Primary$/, "Hãy khởi động lại $1 trước khi tắt Primary khác")
    .replace(/^No stopped Shard 1 node is recorded\. Stop the current Primary first\.$/, "Chưa ghi nhận node Shard 1 nào bị tắt. Hãy tắt Primary hiện tại trước.")
    .replace(/^Could not map Shard 1 Primary to an allowed demo container$/, "Không ánh xạ được Primary Shard 1 sang container demo cho phép")
    .replace(/^Write succeeded but read did not find the document$/, "Ghi thành công nhưng không đọc được bản ghi");
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("seminar-demo-theme") === "dark" ? "dark" : "light");
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [proofs, setProofs] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pulseNode, setPulseNode] = useState("");
  const pulseTimer = useRef(null);

  // Đổi theme bằng data-theme trên <html>; localStorage để reload vẫn giữ lựa chọn.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("seminar-demo-theme", theme);
  }, [theme]);

  // Nháy card của node được nhắc trong sự kiện mới nhất, để mắt người xem không phải
  // tự dò tên trong log rồi tìm lên sơ đồ.
  const applySnapshot = useCallback((nextStatus, nextEvents, nextProofs) => {
    setStatus(nextStatus);
    setEvents(nextEvents);
    setProofs(nextProofs);
    const match = nextEvents[0]?.message.match(/shard[12][abc]/);
    clearTimeout(pulseTimer.current);
    if (!match) return;
    setPulseNode(match[0]);
    pulseTimer.current = setTimeout(() => setPulseNode(""), 2500);
  }, []);

  useEffect(() => () => clearTimeout(pulseTimer.current), []);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextEvents] = await Promise.all([request("/status"), request("/events")]);
      applySnapshot(nextStatus, nextEvents.events, nextEvents.proofs);
    } catch (err) {
      setError(describeError(err.message));
    }
  }, [applySnapshot]);

  // SSE thay cho polling: backend đẩy status + events mỗi khi có thay đổi.
  // EventSource tự reconnect, nên onerror chỉ cần báo cho người dùng.
  useEffect(() => {
    const stream = new EventSource(`${API}/stream`);
    // Nối lại được thì xoá banner "mất kết nối" cũ.
    stream.onopen = () => setError("");
    stream.onmessage = ({ data }) => {
      const { status: nextStatus, events: nextEvents, proofs: nextProofs } = JSON.parse(data);
      applySnapshot(nextStatus, nextEvents, nextProofs);
    };
    stream.onerror = () => setError("Mất kết nối luồng trực tiếp. Đang thử lại…");
    return () => {
      stream.close();
    };
  }, [applySnapshot]);

  // Mỗi nút: gọi action -> gọi lại /status + /events để đồng bộ ngay,
  // không chờ nhịp push kế tiếp của SSE.
  async function act(name, path) {
    setBusy(name);
    setError("");
    try {
      await request(path, "POST");
      await refresh();
    } catch (err) {
      setError(describeError(err.message));
    } finally {
      setBusy("");
    }
  }

  // Dữ liệu dẫn xuất cho phần hiển thị; không lưu vào state để tránh trùng nguồn sự thật.
  const distribution = status?.distribution || [];
  const total = status?.totalDocuments || 0;
  const distributionTotal = distribution.reduce((sum, item) => sum + item.documents, 0);
  const shards = status?.shards || [];
  const replicaSets = status?.replicaSets || [];
  // events là log backend (giới hạn 60 dòng), dùng luôn để tô trạng thái ✓ cho các bước.
  const completed = new Set(events.map((event) => event.operation));
  const readWriteCount = events.filter((event) => event.operation === "read-write").length;
  const actionState = (name, operation) => `${busy === name ? "is-running" : ""} ${completed.has(operation) ? "is-done" : ""}`;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">M</span><span>SEMINAR LAB <i>/</i> DỮ LIỆU PHÂN TÁN</span></div>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "light" ? "Chuyển sang giao diện tối" : "Chuyển sang giao diện sáng"}
            aria-pressed={theme === "dark"}
            title={theme === "light" ? "Chuyển sang giao diện tối" : "Chuyển sang giao diện sáng"}
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
          </button>
          <div className={`connection ${status?.connected ? "online" : "offline"}`}>
            <span className="dot" /> {status?.connected ? "Đã kết nối cụm" : "Đang kết nối cụm"}
          </div>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">ĐIỆN TOÁN DI ĐỘNG & PHỔ BIẾN · DEMO TRỰC TIẾP</p>
          <h1>Sharding <span>+</span> Replication</h1>
          <p className="lede">Quan sát MongoDB chia bản ghi, nhân bản dữ liệu và bầu Primary mới khi một node gặp sự cố.</p>
        </div>
        <div className="architecture-tag"><span>10</span><small>container<br />MongoDB</small></div>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="panel topology-panel">
        <div className="panel-heading"><div><p className="eyebrow">SƠ ĐỒ CỤM</p><h2>Một yêu cầu đi qua MongoDB</h2></div><span className="live-label"><span className="dot" /> CẬP NHẬT TRỰC TIẾP</span></div>
        <p className="walkthrough-copy">Ứng dụng chỉ nói với <strong>mongos</strong>. Bộ định tuyến chọn <strong>shard</strong> (chia dữ liệu); replica set chọn <strong>Primary</strong> (nhận lệnh ghi).</p>
        {/* Sơ đồ: app -> mongos -> 2 shard, mỗi shard 3 node. Số liệu lấy từ /status. */}
        <div className="topology-flow">
          <div className="topology-block app-block">
            <span className="topology-glyph app-glyph" aria-hidden="true">UI</span>
            <span><strong>Ứng dụng web</strong><small>React UI + Express API</small></span>
          </div>
          <span className="topology-arrow" aria-hidden="true">↓</span>
          <div className="topology-block router-block">
            <span className="topology-glyph router-glyph" aria-hidden="true">↔</span>
            <span><strong>mongos</strong><small>{status?.connected ? "Bộ định tuyến · đã kết nối" : "Bộ định tuyến · đang chờ"}</small></span>
            <span className="router-port">27017</span>
          </div>
        </div>
          <div className="topology-branch" aria-hidden="true"><i /><i /></div>
        <div className="topology-shards">
          {shards.map((shard, index) => {
            // Ghép shard với replica set theo tên (shard1 -> shard1RS) để vẽ các node.
            const replicaSet = replicaSets.find((set) => set.name === shard.id);
            const documentCount = distribution.find((item) => item.shard === shard.id)?.documents || 0;
            return (
              <article className={`shard-block shard-block-${index + 1}`} key={shard.id}>
                <div className="shard-heading">
                  <span className="shard-cube" aria-hidden="true"><i /><i /><i /></span>
                  <span className="shard-heading-copy"><small>SHARD DỮ LIỆU {index + 1}</small><strong>{shard.id}</strong></span>
                  <span className="shard-doc-count">{documentCount.toLocaleString("vi-VN")} bản ghi</span>
                </div>
                <div className="replica-node-grid">
                  {(replicaSet?.members || []).map((member) => (
                    // health === 0 hoặc state OFFLINE (backend gắn khi vừa stop) => card đỏ.
                    <div className={`node-card ${member.state === "PRIMARY" ? "is-primary" : ""} ${member.health === 1 ? "is-healthy" : "is-down"} ${pulseNode === member.name.split(":")[0] ? "is-pulse" : ""}`} key={member.name}>
                      <span className="node-heading"><span className="node-cube" aria-hidden="true"><i /><i /><i /></span><strong>{member.name.split(":")[0]}</strong></span>
                      <StatePill state={member.state} />
                      <small className="node-health"><i />{member.health === 1 ? "Hoạt động" : "Không sẵn sàng"}</small>
                    </div>
                  ))}
                  {!replicaSet?.members?.length && <p className="empty-state">Đang chờ trạng thái replica set…</p>}
                </div>
              </article>
            );
          })}
          {!shards.length && <p className="empty-state">Đang chờ sơ đồ shard…</p>}
        </div>
        <div className="topology-footer">
          <div className="replication-guide"><span className="guide-primary" />Primary nhận write<span className="guide-arrow" aria-hidden="true">→</span><span className="guide-secondary" />Secondary giữ bản sao</div>
          <div className="config-strip">
            <span className="config-copy"><strong>Replica set config server</strong><small>Lưu metadata định tuyến và chunk cho mongos</small></span>
            <span className="config-members"><i>config1</i><i>config2</i><i>config3</i></span>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card"><span className="metric-label">TỔNG BẢN GHI</span><strong>{total.toLocaleString("vi-VN")}</strong><span className="metric-foot">seminar.documents</span></article>
        <article className="metric-card"><span className="metric-label">SỐ SHARD</span><strong>{status?.shards?.length ?? "—"}<small> / 2</small></strong><span className="metric-foot">khóa shard băm · docId</span></article>
        <article className="metric-card"><span className="metric-label">REPLICA SET</span><strong>3<small> node / bộ</small></strong><span className="metric-foot">1 primary + 2 secondary</span></article>
        <article className="metric-card"><span className="metric-label">BỘ ĐỊNH TUYẾN</span><strong className="router-value">{status?.router || "—"}</strong><span className="metric-foot">yêu cầu do mongos định tuyến</span></article>
      </section>

      <section className="content-grid">
        <article className="panel distribution-panel">
          <div className="panel-heading"><div><p className="eyebrow">PHÂN BỔ DỮ LIỆU</p><h2>Phân bổ giữa các shard</h2></div><span className="live-label"><span className="dot" /> TRỰC TIẾP</span></div>
          <p className="panel-copy">Bản ghi được chia theo hash(docId). Thanh này đếm bản ghi nằm vật lý trên mỗi shard — không phải số node còn sống.</p>
          <div className="distribution-list">
            {distribution.length ? (
              <>
                <div className="distribution-stack" role="img" aria-label={`Phân bổ dung lượng giữa ${distribution.length} shard`}>
                  {distribution.map((item) => {
                    const share = distributionTotal ? item.documents / distributionTotal * 100 : 0;
                    return <span className="distribution-segment" key={item.shard} style={{ width: `${share}%` }} />;
                  })}
                </div>
                {distribution.map((item, index) => {
                  const share = distributionTotal ? item.documents / distributionTotal * 100 : 0;
                  return (
                    <div className="distribution-row" key={item.shard}>
                      <div className="distribution-meta"><span className={`distribution-key distribution-key-${index + 1}`} /><strong>{item.shard}</strong><span>{item.documents.toLocaleString("vi-VN")} bản ghi <b>{share.toFixed(1)}%</b></span></div>
                    </div>
                  );
                })}
              </>
            ) : (
              <p className="empty-state">Đang chờ thống kê shard…</p>
            )}
          </div>
          <div className="note"><span>i</span><p>Shard băm trải các dải hash lên chunk. Tỉ lệ thực tế có thể lệch; MongoDB không hứa chia đúng 50/50.</p></div>
        </article>

        <article className="panel controls-panel">
          <div className="panel-heading"><div><p className="eyebrow">KỊCH BẢN TƯƠNG TÁC</p><h2>6 bước trình diễn</h2></div><span className="step-index">LÀM THEO THỨ TỰ</span></div>
          <p className="walkthrough-copy">Xem bản ghi trải đều lên các shard, kiểm tra bản sao ngay trên Secondary, rồi quan sát bầu cử Primary. Sau bước 04 hãy chờ Primary mới, bấm lại bước 02, rồi kết thúc ở bước 06.</p>
          <div className="note"><span>i</span><p>Sau bước 04, node đỏ nhưng bước 02 vẫn <b>thành công</b>: lệnh ghi đi tới <b>Primary mới</b>, không đi tới node vừa tắt. Replication giữ lệnh ghi sống; sharding quyết định lệnh ghi nằm ở shard nào.</p></div>
          <div className="action-list">
            <button className={`action-button ${actionState("seed", "seed")}`} disabled={!!busy} onClick={() => act("seed", "/seed")}><span className="action-icon">01</span><span><b>Tạo dữ liệu mẫu</b><small>Thêm 10.000 bản ghi · xem phân bổ shard ở trên</small></span><span className="arrow">↗</span></button>
            <button className={`action-button ${actionState("read-write", "read-write")}`} disabled={!!busy} onClick={() => act("read-write", "/test-read-write")}><span className="action-icon">02</span><span><b>Thử đọc / ghi</b><small>Ghi, đọc, rồi xoá một bản ghi tạm</small></span><span className="arrow">↗</span></button>
            <button className={`action-button ${actionState("replication", "replication")}`} disabled={!!busy || !total} onClick={() => act("replication", "/verify-replication")}><span className="action-icon">03</span><span><b>Kiểm tra bản sao</b><small>Đọc chính bản ghi mẫu trực tiếp từ một Secondary</small></span><span className="arrow">↗</span></button>
            {/* Nút 04 bị khoá khi đã có node bị tắt: mỗi lần chỉ stop 1 node. */}
            <button className={`action-button danger ${actionState("stop", "failover")}`} disabled={!!busy || !!status?.stoppedNode} onClick={() => act("stop", "/failover/stop-primary")}><span className="action-icon">04</span><span><b>Tắt Primary của Shard 1</b><small>{status?.stoppedNode ? `Đã tắt: ${status.stoppedNode} · chờ Primary mới` : "Tắt Primary và quan sát bầu cử"}</small></span><span className="arrow">↗</span></button>
            {/* Bước 05 không có endpoint riêng: nó là "bấm lại bước 02" sau khi bầu cử xong,
                nên đánh dấu ✓ dựa trên số lần đã chạy read-write (> 1). */}
            <div className={`walkthrough-checkpoint ${readWriteCount > 1 ? "is-done" : ""}`}><span className="checkpoint-number">05</span><span><b>Kiểm tra Primary mới có ghi được</b><small>Khi sơ đồ hiện Primary mới, bấm lại bước 02 (ghi) rồi bước 03 (đọc lại đúng bản ghi cũ). Đối chiếu hai bản chụp ở bảng bằng chứng.</small></span></div>
            <button className={`action-button ${actionState("restart", "restart")}`} disabled={!!busy || !status?.stoppedNode} onClick={() => act("restart", "/failover/restart-node")}><span className="action-icon">06</span><span><b>Khởi động lại node đã tắt</b><small>Xác nhận node tham gia lại với vai trò Secondary</small></span><span className="arrow">↗</span></button>
          </div>
          {busy && <p className="busy-state"><span className="spinner" /> Đang chạy {BUSY_LABELS[busy] || busy}…</p>}
        </article>
      </section>

      {/* Nguyên document đọc trực tiếp từ từng node, không phải log tóm tắt. Bấm bước 03 trước
          và sau bước 04 để có hai bản chụp cùng docId, khác Primary. */}
      <section className="panel proof-panel">
        <div className="panel-heading"><div><p className="eyebrow">BẰNG CHỨNG BẢN SAO</p><h2>Cùng một bản ghi, đọc từ từng node</h2></div><span className="step-index">BƯỚC 03</span></div>
        {proofs.length ? (
          <div className="proof-grid">
            {proofs.map((proof) => (
              <article className="proof-card" key={proof.id}>
                <header>
                  <strong>{proof.trigger === "before-stop" ? `Trước khi tắt ${proof.primary?.split(":")[0]} (tự chụp)` : proof.stoppedNode ? `Sau khi tắt ${proof.stoppedNode}` : "Cụm đủ 3 node"}</strong>
                  <time>{new Date(proof.at).toLocaleTimeString([], { hour12: false })}</time>
                </header>
                <p className="proof-meta">docId <code>{proof.docId}</code> · {proof.shard} · Primary lúc đọc: <b>{proof.primary?.split(":")[0] ?? "không rõ"}</b></p>
                {[{ node: "mongos", role: "ROUTER", document: proof.viaMongos }, ...proof.copies].map((copy) => (
                  <div className="proof-copy" key={copy.node}>
                    <div><b>{copy.node.split(":")[0]}</b> <StatePill state={copy.role} /></div>
                    <pre>{copy.document ? JSON.stringify(copy.document, null, 2) : copy.error || "Chưa có bản ghi"}</pre>
                  </div>
                ))}
              </article>
            ))}
          </div>
        ) : <p className="empty-state">Chưa có bản chụp. Bấm bước 03; bấm lại sau khi bầu Primary mới để so sánh.</p>}
      </section>

      <section className="events-panel">
        <div className="terminal-window">
          <div className="terminal-chrome">
            <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
            <span className="terminal-title">backend@seminar-demo: ~ / nhat-ky.log</span>
            <span className={`terminal-live ${status?.connected ? "connected" : ""}`}><i />{status?.connected ? "ĐANG PHÁT TRỰC TIẾP" : "ĐANG KẾT NỐI"}</span>
          </div>
          <div className="terminal-screen" role="log" aria-live="polite" aria-label="Luồng sự kiện backend">
            <div className="terminal-command"><span>$</span><code>GET /api/stream <i>· SSE trực tiếp</i></code></div>
            {events.length ? events.slice(0, 12).reverse().map((event) => (
              <div className={`terminal-line ${event.operation}`} key={event.id}>
                <span className="terminal-prompt" aria-hidden="true">›</span>
                <time>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
                <span className={`terminal-operation ${event.operation}`}>[{event.operation.toUpperCase()}]</span>
                <code className="terminal-id">#{event.id}</code>
                <span className="terminal-message">{translateEvent(event.message)}</span>
              </div>
            )) : <div className="terminal-empty"><span>›</span> Chưa có sự kiện. Bắt đầu với bước 01 ở trên.</div>}
          </div>
          <div className="terminal-statusbar"><span>seminar-demo · luồng sự kiện backend</span><span>{events.length} sự kiện · mới nhất ở dưới</span></div>
        </div>
      </section>

      <footer><span>CỤM LOCAL · DOCKER COMPOSE</span><span>Sharding & bầu cử có sẵn trong MongoDB</span></footer>
    </main>
  );
}

