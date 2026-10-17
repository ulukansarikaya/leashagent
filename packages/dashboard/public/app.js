// Leash Agent dashboard: consumes only HTTP + SSE (§15.2). Owner actions are signed in the wallet
// (EIP-712, eth_signTypedData_v4); the dashboard never holds a key.
const DOMAIN = { name: "LeashAgent", version: "1", chainId: 43113 };
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

const CHAIN_LABEL = { pending: "kuyrukta", submitted: "gönderildi", confirmed: "zincirde ✓", dead: "başarısız ✗", retry: "yeniden deneniyor" };

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
  // policyId comes from ?policyId=…; the TEST/DEMO mock also advertises it in /v1/health.
  const id = new URLSearchParams(location.search).get("policyId") ?? health.policyId;
  if (!id) throw new Error("policyId missing: open the dashboard with ?policyId=0x…");
  const p = await fetch(`/v1/policy/${id}`).then((r) => r.json());
  policy = p.policy;
  paused = p.paused;
  const rows = [
    ["policyId", short(policy.policyId ?? policy.binding?.policyId)], ["sürüm", policy.policyVersion],
    ["sahip", policy.binding?.owner ?? policy.owner], ["agent", policy.binding?.agentId ?? policy.agentId],
    ["ERC-8004", policy.binding ? `${short(policy.binding.agentRegistry)} #${policy.binding.agentRegistryId}` : "—"],
    ["accountRef", short(policy.binding?.accountRef)],
    ["görev", policy.mandate], ["enstrümanlar", policy.allowedInstruments.join(", ")],
    ["tek emir max", `${policy.maxOrderNotionalUsdt} USDT`], ["onay eşiği", `${policy.escalateAboveUsdt} USDT`],
    ["auditor", policy.auditorEnabled ? "açık" : "kapalı"], ["policyHash", short(p.policyHash)], ["zincir", p.chain],
  ];
  $("policyBody").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  renderPaused();
}

/**
 * Outbox counters from GET /v1/health → `chain.outbox` = {pending, submitted, confirmed, dead}
 * (Person 3's OutboxStats). A gateway without chain evidence reports `chain: "disabled"`.
 */
let chainTimer = null;
async function refreshChainStats() {
  clearTimeout(chainTimer);
  try {
    const h = await fetch("/v1/health").then((r) => r.json());
    const o = h.chain?.outbox;
    $("creditMode").textContent = h.credits ? `kredi modu: ${h.credits}` : "";
    if (!o) { $("chainStats").innerHTML = '<p class="muted">zincir kanıtı kapalı</p>'; $("chainNote").textContent = ""; return; }
    $("chainStats").innerHTML = ["pending", "submitted", "confirmed", "dead"]
      .map((k) => `<div><b class="c-${k}">${o[k] ?? 0}</b><small>${CHAIN_LABEL[k]}</small></div>`).join("");
    const open = (o.pending ?? 0) + (o.submitted ?? 0);
    $("chainNote").textContent = o.dead ? `${o.dead} kayıt kalıcı olarak başarısız — operatör müdahalesi gerekli. Yürütme etkilenmez (INV-15).`
      : open ? `${open} kayıt zincire yazılmayı bekliyor (gecikme yürütmeyi etkilemez).` : "tüm kayıtlar zincirde.";
  } catch { /* health unavailable; keep last view */ }
  finally { chainTimer = setTimeout(refreshChainStats, 3000); }
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
    // ALLOW is only a decision; ALLOWED is set when the authorization is issued.
    const st = p.expired ? "EXPIRED" : p.reasonCode === 4 ? "REJECTED_PAYMENT" : p.kind === "BLOCK" ? "BLOCKED" : p.kind === "PENDING" ? "PENDING" : "POLICY_CHECKED";
    // An ALLOW decision carries reasonCode 0, which is not a reason (000 = identity rejection).
    upsert(ev.requestId, { status: st, code: p.kind === "ALLOW" ? undefined : p.reasonCode, evidence: p.evidenceHash, auditor: p.auditorOutput });
  }
  if (ev.type === "approval") upsert(ev.requestId, { status: p.decision === "approve" ? "APPROVED" : "REJECTED_BY_HUMAN" });
  if (ev.type === "authorization_issued") upsert(ev.requestId, { status: "ALLOWED", basis: p.basis });
  if (ev.type === "execution") upsert(ev.requestId, { status: (p.status ?? "").toUpperCase(), simulated: p.simulated });
  if (ev.type === "pause") { paused = p.paused; renderPaused(); }
  // Chain evidence per order: the decision record's state (pending → confirmed | dead).
  if (ev.type === "chain_write" && ev.requestId && p.kind === "decision") upsert(ev.requestId, { chain: p.state, chainTx: p.txHash ?? orders.get(ev.requestId)?.chainTx });
  if (ev.type === "chain_write") refreshChainStats();

  const li = document.createElement("li");
  li.innerHTML = `<code>${new Date(ev.ts * 1000).toLocaleTimeString()}</code> <b>${esc(ev.type)}</b> ${esc(ev.requestId ? short(ev.requestId) : "")} <span class="muted">${esc(feedDetail(ev))}</span>`;
  $("feed").prepend(li);
  render();
}

function feedDetail(ev) {
  const p = ev.payload ?? {};
  if (ev.type === "decision") return p.kind === "ALLOW" ? "ALLOW" : `${p.kind ?? ""} ${p.reasonCode ?? ""} ${REASONS[p.reasonCode] ?? ""}`;
  if (ev.type === "read_recorded") return `flags=[${(p.summary?.flags ?? []).join(",")}] sentiment=${p.summary?.sentiment}`;
  if (ev.type === "intent_rejected") return `${p.status} ${p.message ?? ""}`;
  if (ev.type === "execution") return `${p.status}${p.simulated ? " (simüle)" : ""}`;
  if (ev.type === "chain_write") return `${p.state}${p.kind ? " " + p.kind : ""}${p.eventSeq ? " #" + p.eventSeq : ""}${p.txHash ? " tx " + short(p.txHash) : ""}${p.error ? " — " + p.error : ""}`;
  return "";
}

function render() {
  const list = [...orders.values()].sort((a, b) => b.ts - a.ts);
  $("orders").innerHTML = list.map((o) => {
    const ord = o.order ? `${o.order.side ?? ""} ${o.order.sz ?? ""} ${o.order.instId ?? ""} ${o.order.ordType ?? ""} ${o.order.px ? "@" + o.order.px : ""}` : esc(o.note ?? "—");
    const a = o.auditor ? `tutarlılık ${o.auditor.consistency} · enjeksiyon ${o.auditor.injectionSuspicion} · ${o.auditor.provider}` : "";
    const pay = o.status === "REJECTED_PAYMENT" ? '<br><small class="muted">x402 kredisi gerekli</small>' : "";
    const chain = o.chain ? `<span class="c-${esc(o.chain)}">${esc(CHAIN_LABEL[o.chain] ?? o.chain)}</span>${o.chainTx ? `<br><code>${esc(short(o.chainTx))}</code>` : ""}` : '<span class="muted">—</span>';
    return `<tr><td><code>${new Date(o.ts * 1000).toLocaleTimeString()}</code></td><td>${esc(ord)}<br><small class="muted">${esc((o.reason ?? "").slice(0, 140))}</small></td>
      <td class="s-${esc(o.status)}">${esc(o.status)}${o.simulated ? " <small class=muted>(simüle)</small>" : ""}</td>
      <td>${o.code ?? ""} <small class="muted">${esc(REASONS[o.code] ?? "")}</small>${pay}</td><td><small>${esc(a)}</small></td><td><code>${esc(short(o.evidence))}</code></td><td>${chain}</td></tr>`;
  }).join("");
  $("paymentCount").textContent = list.filter((o) => o.status === "REJECTED_PAYMENT").length;
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
  const owner = policy?.binding?.owner ?? policy?.owner;
  if (owner && account.toLowerCase() !== owner.toLowerCase()) alert("Bu cüzdan politika sahibi değil; imzalar reddedilecek.");
}

async function decideApproval(requestId, decision) {
  const detail = await fetch(`/v1/intents/${encodeURIComponent(requestId)}`).then((r) => r.json());
  const msg = { requestId, policyId: policy.binding?.policyId ?? policy.policyId, normalizedOrderHash: detail.normalizedOrderHash, decision, nonce: nonce16(), expiresAt: now() + 120 };
  const ownerSignature = await signTyped("ApprovalDecision", msg);
  const res = await fetch("/v1/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...msg, ownerSignature }) }).then((r) => r.json());
  upsert(requestId, { status: res.status, code: res.reasonCode ?? orders.get(requestId)?.code });
  if (res.message) alert(res.message);
  render();
}

async function togglePause() {
  const msg = { policyId: policy.binding?.policyId ?? policy.policyId, paused: !paused, nonce: nonce16(), issuedAt: now() };
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
refreshChainStats();
