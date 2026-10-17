// Bekçi dashboard: consumes only HTTP + SSE (§15.2). Owner actions are signed in the wallet
// (EIP-712, eth_signTypedData_v4); the dashboard never holds a key.
const DOMAIN = { name: "Bekci", version: "1", chainId: 43113 };
const DOMAIN_TYPE = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }];
const TYPES = {
  ApprovalDecision: [
    { name: "requestId", type: "string" }, { name: "policyId", type: "bytes32" }, { name: "normalizedOrderHash", type: "bytes32" },
    { name: "decision", type: "string" }, { name: "nonce", type: "bytes16" }, { name: "expiresAt", type: "uint64" },
  ],
  PauseCommand: [
    { name: "policyId", type: "bytes32" }, { name: "paused", type: "bool" }, { name: "nonce", type: "bytes16" }, { name: "issuedAt", type: "uint64" },
  ],
};
const REASONS = {
  0: "kimlik/delegasyon", 1: "şema/araç", 2: "yetki", 3: "politika doğrulanamadı", 4: "servis kredisi yok",
  100: "durduruldu", 101: "enstrüman", 102: "araç", 103: "tek emir limiti", 104: "açık pozisyon", 105: "hız", 106: "günlük zarar",
  107: "fiyat sapması", 110: "bayat veri", 201: "enjeksiyon şüphesi", 202: "görevle tutarsız", 203: "auditor engelledi",
  301: "auditor insana sordu", 302: "auditor erişilemez", 303: "eşik üstü",
};

const $ = (id) => document.getElementById(id);
const orders = new Map();
let policy = null, paused = false, account = null, lastHash = null, chainOk = true;
const now = () => Math.floor(Date.now() / 1000);
const nonce16 = () => "0x" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 10)}…` : "");

async function loadPolicy() {
  const health = await fetch("/v1/health").then((r) => r.json());
  paused = health.paused;
  // The mock exposes the demo policy id via health-less lookup; real gateway: configured id.
  const id = new URLSearchParams(location.search).get("policyId") ?? window.BEKCI_POLICY_ID ?? ("0x" + "b3".repeat(32));
  const p = await fetch(`/v1/policy/${id}`).then((r) => r.json());
  policy = p.policy;
  paused = p.paused;
  const rows = [
    ["policyId", short(policy.policyId)], ["sürüm", policy.policyVersion], ["sahip", policy.owner], ["agent", policy.agentId],
    ["görev", policy.mandate], ["enstrümanlar", policy.allowedInstruments.join(", ")],
    ["tek emir max", `${policy.maxOrderNotionalUsdt} USDT`], ["onay eşiği", `${policy.escalateAboveUsdt} USDT`],
    ["auditor", policy.auditorEnabled ? "açık" : "kapalı"], ["policyHash", short(p.policyHash)], ["zincir", p.chain],
  ];
  $("policyBody").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  renderPaused();
}

function renderPaused() {
  $("pausedPill").textContent = paused ? "DURDURULDU" : "aktif";
  $("pausedPill").className = "pill " + (paused ? "s-BLOCKED" : "s-ALLOWED");
  $("pauseBtn").textContent = paused ? "Devam ettir" : "Acil durdur";
}

function upsert(requestId, patch) {
  const o = orders.get(requestId) ?? { requestId, ts: now() };
  Object.assign(o, patch);
  orders.set(requestId, o);
  return o;
}

function onEvent(ev) {
  // Verify the hash chain linkage as events arrive.
  if (lastHash && ev.prevHash !== lastHash) chainOk = false;
  lastHash = ev.hash;
  $("chainOk").textContent = chainOk ? "bağlı ✓" : "KIRIK ✗";

  const p = ev.payload ?? {};
  if (ev.type === "intent_received") upsert(ev.requestId, { ts: ev.ts, order: p.order, reason: p.agentReason, status: "RECEIVED" });
  if (ev.type === "intent_rejected" && ev.requestId) upsert(ev.requestId, { ts: ev.ts, status: p.status, code: p.reasonCode, note: p.message });
  if (ev.type === "decision") {
    const st = p.expired ? "EXPIRED" : p.kind === "ALLOW" ? "ALLOWED" : p.kind === "BLOCK" ? "BLOCKED" : "PENDING";
    upsert(ev.requestId, { status: st, code: p.reasonCode, evidence: p.evidenceHash, auditor: p.auditorOutput });
  }
  if (ev.type === "approval") upsert(ev.requestId, { status: p.decision === "approve" ? "APPROVED" : "REJECTED_BY_HUMAN" });
  if (ev.type === "execution") upsert(ev.requestId, { status: (p.status ?? "").toUpperCase(), simulated: p.simulated });
  if (ev.type === "pause") { paused = p.paused; renderPaused(); }

  const li = document.createElement("li");
  li.innerHTML = `<code>${new Date(ev.ts * 1000).toLocaleTimeString()}</code> <b>${esc(ev.type)}</b> ${esc(ev.requestId ? short(ev.requestId) : "")} <span class="muted">${esc(feedDetail(ev))}</span>`;
  $("feed").prepend(li);
  render();
}

function feedDetail(ev) {
  const p = ev.payload ?? {};
  if (ev.type === "decision") return `${p.kind ?? ""} ${p.reasonCode ?? ""} ${REASONS[p.reasonCode] ?? ""}`;
  if (ev.type === "read_recorded") return `flags=[${(p.summary?.flags ?? []).join(",")}] sentiment=${p.summary?.sentiment}`;
  if (ev.type === "intent_rejected") return `${p.status} ${p.message ?? ""}`;
  if (ev.type === "execution") return `${p.status}${p.simulated ? " (simüle)" : ""}`;
  return "";
}

function render() {
  const list = [...orders.values()].sort((a, b) => b.ts - a.ts);
  $("orders").innerHTML = list.map((o) => {
    const ord = o.order ? `${o.order.side ?? ""} ${o.order.sz ?? ""} ${o.order.instId ?? ""} ${o.order.ordType ?? ""} ${o.order.px ? "@" + o.order.px : ""}` : esc(o.note ?? "—");
    const a = o.auditor ? `tutarlılık ${o.auditor.consistency} · enjeksiyon ${o.auditor.injectionSuspicion} · ${o.auditor.provider}` : "";
    return `<tr><td><code>${new Date(o.ts * 1000).toLocaleTimeString()}</code></td><td>${esc(ord)}<br><small class="muted">${esc((o.reason ?? "").slice(0, 140))}</small></td>
      <td class="s-${esc(o.status)}">${esc(o.status)}${o.simulated ? " <small class=muted>(simüle)</small>" : ""}</td>
      <td>${o.code ?? ""} <small class="muted">${esc(REASONS[o.code] ?? "")}</small></td><td><small>${esc(a)}</small></td><td><code>${esc(short(o.evidence))}</code></td></tr>`;
  }).join("");
  const pend = list.filter((o) => o.status === "PENDING");
  $("pending").innerHTML = pend.length ? pend.map((o) => `<div class="pend"><b>${esc(o.order?.side)} ${esc(o.order?.sz)} ${esc(o.order?.instId)}</b> @ ${esc(o.order?.px ?? "market")}
    <div class="muted">${o.code} ${esc(REASONS[o.code] ?? "")}</div>
    <div class="actions"><button class="ok" data-approve="${esc(o.requestId)}">Onayla</button><button class="danger" data-reject="${esc(o.requestId)}">Reddet</button></div></div>`).join("") : '<p class="muted">Yok</p>';
}

async function signTyped(primaryType, message) {
  if (!window.ethereum) {
    // Local demo only (mock gateway started with INSECURE_OWNER=1).
    if (confirm("Cüzdan yok. Yerel demo için imzasız gönderilsin mi? (Sadece INSECURE_OWNER=1 mock gateway kabul eder)")) return "0x";
    throw new Error("wallet required");
  }
  if (!account) await connect();
  const data = { domain: DOMAIN, types: { EIP712Domain: DOMAIN_TYPE, [primaryType]: TYPES[primaryType] }, primaryType, message };
  return window.ethereum.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(data)] });
}

async function connect() {
  if (!window.ethereum) return alert("EIP-1193 cüzdan bulunamadı");
  [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  $("connectWallet").textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
  if (policy && account.toLowerCase() !== policy.owner.toLowerCase()) alert("Bu cüzdan politika sahibi değil; imzalar reddedilecek.");
}

async function decideApproval(requestId, decision) {
  const detail = await fetch(`/v1/intents/${encodeURIComponent(requestId)}`).then((r) => r.json());
  const msg = { requestId, policyId: policy.policyId, normalizedOrderHash: detail.normalizedOrderHash, decision, nonce: nonce16(), expiresAt: now() + 120 };
  const ownerSignature = await signTyped("ApprovalDecision", msg);
  const res = await fetch("/v1/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...msg, ownerSignature }) }).then((r) => r.json());
  upsert(requestId, { status: res.status, code: res.reasonCode ?? orders.get(requestId)?.code });
  if (res.message) alert(res.message);
  render();
}

async function togglePause() {
  const msg = { policyId: policy.policyId, paused: !paused, nonce: nonce16(), issuedAt: now() };
  const ownerSignature = await signTyped("PauseCommand", msg);
  const res = await fetch("/v1/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...msg, ownerSignature }) }).then((r) => r.json());
  if (!res.ok) alert(res.message ?? "durdurma reddedildi");
}

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.dataset?.approve) decideApproval(t.dataset.approve, "approve").catch((x) => alert(x.message));
  if (t.dataset?.reject) decideApproval(t.dataset.reject, "reject").catch((x) => alert(x.message));
});
$("connectWallet").onclick = () => connect().catch((x) => alert(x.message));
$("pauseBtn").onclick = () => togglePause().catch((x) => alert(x.message));

await loadPolicy().catch(() => ($("policyBody").innerHTML = "<dt>hata</dt><dd>politika okunamadı</dd>"));
const es = new EventSource("/v1/events");
es.onopen = () => { $("conn").textContent = "canlı"; $("conn").className = "pill s-ALLOWED"; };
es.onerror = () => { $("conn").textContent = "bağlantı koptu"; $("conn").className = "pill s-BLOCKED"; };
es.onmessage = (m) => onEvent(JSON.parse(m.data));
