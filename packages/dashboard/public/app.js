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
  0: "kimlik / imza", 1: "şema / araç", 2: "yetki", 3: "policy doğrulanamadı", 4: "servis kredisi yok (x402)",
  100: "durduruldu", 101: "izinsiz enstrüman", 102: "izinsiz araç", 103: "tek emir limiti", 104: "açık pozisyon limiti", 105: "emir hızı",
  106: "günlük zarar limiti", 107: "fiyat sapması", 108: "satılacak bakiye yok", 110: "bayat veri",
  201: "prompt injection şüphesi", 202: "görevle tutarsız", 203: "auditor engelledi",
  301: "auditor insana sordu", 302: "auditor erişilemedi", 303: "onay eşiği üstü",
  401: "yetki geçersiz", 402: "yetki süresi doldu", 403: "emir değiştirilmiş", 404: "tekrar kullanım", 405: "policy değişti / durduruldu",
};
const CHAIN_LABEL = { pending: "kuyrukta", submitted: "gönderildi", confirmed: "zincirde ✓", dead: "başarısız ✗", retry: "yeniden deneniyor" };
/** Execution statuses that mean an exchange write was attempted. */
const WRITE_STATUSES = new Set(["SUBMITTED", "ACKNOWLEDGED", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED_BY_OKX", "UNKNOWN"]);

const $ = (id) => document.getElementById(id);
const orders = new Map();
let policy = null, policyId = null, paused = false, account = null, lastHash = null, chainOk = true, explorer = null;
const now = () => Math.floor(Date.now() / 1000);
const nonce16 = () => "0x" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 10)}…` : "");
const reason = (c) => (c === undefined || c === null ? "" : `${String(c).padStart(3, "0")} ${REASONS[c] ?? ""}`);
const num = (x) => (x === undefined || x === null ? "" : Number(x).toLocaleString("tr-TR", { maximumFractionDigits: 2 }));

// ---------------------------------------------------------------------------------------------- status

function teeLabel(tee) {
  if (!tee || tee === "disabled") return { text: "TEE kapalı", cls: "" };
  const live = (tee.accepted ?? []).some((a) => a.signer?.toLowerCase() === tee.signer?.toLowerCase());
  if (tee.mode === "simulated") return { text: `TEE simülasyon ${live ? "✓" : "✗"} (donanım yok)`, cls: "s-PENDING" };
  return { text: `TEE ${tee.mode} ${live ? "attested ✓" : "attestation yok ✗"}`, cls: live ? "s-ALLOWED" : "s-BLOCKED" };
}

async function refreshStatus() {
  try {
    const h = await fetch("/v1/health").then((r) => r.json());
    explorer = h.explorer ?? null;
    const t = teeLabel(h.tee);
    $("teePill").textContent = t.text; $("teePill").className = `pill ${t.cls}`;
    const a = h.auditor;
    $("auditorPill").textContent = a ? `auditor: ${a.provider}${a.role !== "production" ? ` (${a.role})` : ""}` : "auditor";
    $("auditorPill").className = `pill ${a && a.role !== "production" ? "s-PENDING" : ""}`;
    const o = h.chain?.outbox;
    if (!o) $("kChain").innerHTML = "zincir kanıtı kapalı";
    else {
      const open = (o.pending ?? 0) + (o.submitted ?? 0);
      $("kChain").innerHTML = `<b class="c-confirmed big">${o.confirmed ?? 0}</b> zincirde · <span class="c-pending">${open} kuyrukta</span>` +
        (o.dead ? ` · <span class="c-dead">${o.dead} başarısız</span>` : "") +
        `<br>${open ? "gecikme yürütmeyi etkilemez" : "tüm kayıtlar zincirde"}${explorer ? "" : " · simüle zincir"}`;
    }
    if (policyId) {
      const c = await fetch(`/v1/credits/${policyId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      $("kCredits").textContent = c ? c.available : "—";
    }
  } catch { /* keep last view */ }
}

async function loadPolicy() {
  const health = await fetch("/v1/health").then((r) => r.json());
  // policyId comes from ?policyId=…; the TEST/DEMO gateway also advertises it in /v1/health.
  policyId = new URLSearchParams(location.search).get("policyId") ?? health.policyId;
  if (!policyId) throw new Error("policyId missing: open the dashboard with ?policyId=0x…");
  const p = await fetch(`/v1/policy/${policyId}`).then((r) => r.json());
  policy = p.policy;
  paused = p.paused;
  const limit = (k) => policy.limits?.[k] ?? policy[k];
  const auditorOn = policy.auditor ? policy.auditor.mode === "enabled" : !!policy.auditorEnabled;
  const chain = typeof p.chain === "string" ? p.chain
    : p.chain?.verified ? `hash zincirle doğrulandı ✓ (${p.chain.source})` : `doğrulanamadı ✗ ${p.chain?.reason ?? ""}`;
  $("policySummary").textContent = `v${policy.policyVersion} · tek emir ≤ ${limit("maxOrderNotionalUsdt")} USDT · onay > ${limit("escalateAboveUsdt")} USDT · ${chain}`;
  const rows = [
    ["policyId", policy.binding?.policyId ?? policy.policyId], ["sürüm", policy.policyVersion],
    ["sahip (owner)", policy.binding?.owner ?? policy.owner], ["agent (ERC-8004)", policy.binding?.agentId ?? policy.agentId],
    ["accountRef", short(policy.binding?.accountRef)], ["görev", policy.mandate], ["enstrümanlar", policy.allowedInstruments.join(", ")],
    ["tek emir limiti", `${limit("maxOrderNotionalUsdt")} USDT`], ["açık pozisyon limiti", `${limit("maxOpenNotionalUsdt") ?? "—"} USDT`],
    ["onay eşiği", `${limit("escalateAboveUsdt")} USDT`], ["günlük zarar limiti", `${limit("maxDailyLossUsdt") ?? "—"} USDT`],
    ["fiyat sapması", `${limit("maxPriceDeviationBps") ?? "—"} bps`], ["auditor", auditorOn ? "açık" : "kapalı"],
    ["policyHash", short(p.policyHash)], ["zincir", chain],
  ];
  $("policyBody").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  renderPaused();
}

function renderPaused() {
  $("pausedPill").textContent = paused ? "DURDURULDU" : "aktif";
  $("pausedPill").className = "pill " + (paused ? "s-BLOCKED" : "s-ALLOWED");
  $("pauseBtn").textContent = paused ? "Devam ettir" : "Acil durdur";
}

// ---------------------------------------------------------------------------------------------- events

/** The real gateway's intent_received carries no order; the normalized order comes from GET /v1/intents/:id. */
const orderRequested = new Set();
async function loadOrder(requestId) {
  if (orderRequested.has(requestId)) return;
  orderRequested.add(requestId);
  try {
    const d = await fetch(`/v1/intents/${encodeURIComponent(requestId)}`).then((r) => r.json());
    if (d.order) { upsert(requestId, { order: d.order }); render(); }
  } catch { /* row keeps showing without order details */ }
}

function upsert(requestId, patch) {
  const o = orders.get(requestId) ?? { requestId, ts: now() };
  Object.assign(o, patch);
  orders.set(requestId, o);
  return o;
}

function onEvent(ev) {
  if (lastHash && ev.prevHash !== lastHash) chainOk = false;
  lastHash = ev.hash;
  $("chainOk").innerHTML = chainOk ? '<span class="s-ALLOWED">bağlı ✓</span>' : '<span class="s-BLOCKED">KIRIK ✗</span>';

  const p = ev.payload ?? {};
  const id = ev.requestId ?? p.requestId;
  switch (ev.type) {
    case "intent_received":
      upsert(id, { ts: ev.ts, order: p.order, reason: p.agentReason, verdict: "RECEIVED" });
      if (!p.order) loadOrder(id);
      break;
    case "intent_rejected":
      if (id) upsert(id, { ts: ev.ts, verdict: p.status, code: p.reasonCode, note: p.message, stage: "L3" });
      break;
    case "decision": {
      const verdict = p.expired ? "EXPIRED" : p.reasonCode === 4 ? "REJECTED_PAYMENT" : p.kind === "BLOCK" ? "BLOCKED" : p.kind === "PENDING" ? "PENDING" : "ALLOW";
      upsert(id, {
        verdict, code: p.kind === "ALLOW" ? undefined : p.reasonCode, human: p.human, evidence: p.evidenceHash,
        notional: p.notionalUsdt ?? p.ruleResult?.derived?.notionalUsdt, risk: p.riskIncreasing ?? p.ruleResult?.derived?.riskIncreasing,
        violations: p.violations ?? p.ruleResult?.violations?.map((v) => v.code) ?? [], auditor: p.auditorOutput ?? orders.get(id)?.auditor,
      });
      break;
    }
    case "approval":
      upsert(id, { approval: p.decision });
      break;
    case "authorization_issued":
      upsert(id, { verdict: "ALLOWED", basis: p.basis });
      break;
    case "execution":
      if (p.rejectedByExecutor) upsert(id, { okx: String(p.outcome ?? "rejected").toUpperCase(), okxCode: p.reasonCode, okxNote: p.message });
      else upsert(id, { okx: String(p.status ?? "").toUpperCase(), simulated: p.simulated });
      break;
    case "pause":
      paused = p.paused; renderPaused();
      break;
    case "chain_write":
      if (id && p.kind === "decision") upsert(id, { chain: p.state, chainTx: p.txHash ?? orders.get(id)?.chainTx });
      refreshStatus();
      break;
  }

  const li = document.createElement("li");
  li.innerHTML = `<code>${new Date(ev.ts * 1000).toLocaleTimeString()}</code> <b>${esc(ev.type)}</b> ${esc(id ? short(id) : "")} <span class="muted">${esc(feedDetail(ev))}</span>`;
  $("feed").prepend(li);
  scheduleRender();
}

function feedDetail(ev) {
  const p = ev.payload ?? {};
  if (ev.type === "decision") return p.kind === "ALLOW" ? "ALLOW" : `${p.kind ?? ""} ${reason(p.reasonCode)}`;
  if (ev.type === "read_recorded") return `flags=[${(p.summary?.flags ?? []).join(",")}] sentiment=${p.summary?.sentiment}`;
  if (ev.type === "intent_rejected") return `${p.status} ${p.message ?? ""}`;
  if (ev.type === "execution") return p.rejectedByExecutor ? `executor: ${p.outcome} ${reason(p.reasonCode)}` : `${p.status}${p.simulated ? " (simüle)" : ""}`;
  if (ev.type === "chain_write") return `${p.state}${p.kind ? " " + p.kind : ""}${p.eventSeq ? " #" + p.eventSeq : ""}${p.txHash ? " tx " + short(p.txHash) : ""}${p.error ? " — " + p.error : ""}`;
  return "";
}

// ---------------------------------------------------------------------------------------------- render

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function verdictCell(o) {
  const v = o.verdict ?? "—";
  const cls = /ALLOW/.test(v) ? "b-allow" : v === "PENDING" ? "b-pending" : v === "RECEIVED" ? "b-neutral" : "b-block";
  const label = { ALLOW: "İZİN", ALLOWED: "İZİN", BLOCKED: "ENGEL", PENDING: "ONAY BEKLİYOR", REJECTED_PAYMENT: "402 KREDİ YOK",
    REJECTED_AUTH: "KİMLİK RED", REJECTED_SCHEMA: "ŞEMA RED", REJECTED_POLICY: "POLICY RED", REJECTED_BY_HUMAN: "OWNER REDDETTİ",
    EXPIRED: "SÜRESİ DOLDU", RECEIVED: "değerlendiriliyor" }[v] ?? v;
  const human = o.approval ? `<br><small class="muted">owner ${o.approval === "approve" ? "onayladı → yeniden kontrol" : "reddetti"}</small>` : "";
  return `<span class="badge ${cls}">${esc(label)}</span>${o.code !== undefined ? `<br><small>${esc(reason(o.code))}</small>` : ""}${human}`;
}

function okxCell(o) {
  if (o.okx && WRITE_STATUSES.has(o.okx)) return `<span class="s-${esc(o.okx)}">${esc(o.okx)}</span>${o.simulated ? ' <small class="muted">(simüle)</small>' : ""}`;
  if (o.okx) return `<span class="s-BLOCKED">${esc(o.okx)}</span><br><small>L6: ${esc(reason(o.okxCode))}</small><br><small class="nowrite">OKX'e yazılmadı</small>`;
  if (o.verdict === "ALLOWED") return '<span class="muted">gönderiliyor…</span>';
  if (o.verdict && o.verdict !== "RECEIVED" && o.verdict !== "PENDING") return '<span class="nowrite">yazılmadı</span>';
  return '<span class="muted">—</span>';
}

function chainCell(o) {
  if (!o.chain) return o.stage === "L3" ? '<span class="muted">L3 reddi (zincire yazılmaz)</span>' : '<span class="muted">—</span>';
  const tx = o.chainTx ? (explorer ? `<br><a href="${esc(explorer)}/tx/${esc(o.chainTx)}" target="_blank" rel="noopener">${esc(short(o.chainTx))}</a>` : `<br><code>${esc(short(o.chainTx))}</code>`) : "";
  return `<span class="c-${esc(o.chain)}">${esc(CHAIN_LABEL[o.chain] ?? o.chain)}</span>${tx}`;
}

function render() {
  const list = [...orders.values()].sort((a, b) => b.ts - a.ts);
  $("orders").innerHTML = list.length ? list.map((o) => {
    const ord = o.order
      ? `<b>${esc((o.order.side ?? o.order.tool).toUpperCase())}</b> ${esc(o.order.sz ?? "")} ${esc(o.order.instId ?? "")} <span class="muted">${esc(o.order.ordType ?? "")}${o.order.px ? " @" + esc(num(o.order.px)) : ""}</span>`
      : `<span class="muted">${esc(o.note ?? "—")}</span>`;
    const why = o.reason ? `<br><small class="muted">“${esc(o.reason.slice(0, 100))}”</small>` : "";
    const risk = o.notional !== undefined
      ? `${esc(num(o.notional))} USDT${o.risk ? ' <small class="muted">risk ↑</small>' : ""}<br><small>${o.violations?.length ? `<span class="s-BLOCKED">ihlal: ${o.violations.map((c) => esc(reason(c))).join(", ")}</span>` : '<span class="s-ALLOWED">kurallar ✓</span>'}</small>`
      : '<span class="muted">—</span>';
    const aud = o.auditor ? `<small>enjeksiyon ${esc(o.auditor.injectionSuspicion)} · tutarlılık ${esc(o.auditor.consistency)}<br><span class="muted">${esc(o.auditor.provider)}</span></small>`
      : [201, 202, 203, 301, 302].includes(o.code) ? `<small class="s-BLOCKED">${esc(reason(o.code))}</small>` : '<span class="muted">—</span>';
    return `<tr><td><code>${new Date(o.ts * 1000).toLocaleTimeString()}</code></td><td>${ord}${why}</td><td>${risk}</td><td>${aud}</td><td>${verdictCell(o)}</td><td>${okxCell(o)}</td><td>${chainCell(o)}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="muted">Henüz emir yok</td></tr>';

  // An ALLOW the executor refused (REVOKED / EXPIRED at L6) counts as stopped, not allowed.
  const stoppedAtL6 = (o) => o.okx && !WRITE_STATUSES.has(o.okx);
  const allow = list.filter((o) => (o.verdict === "ALLOW" || o.verdict === "ALLOWED") && !stoppedAtL6(o)).length;
  const pend = list.filter((o) => o.verdict === "PENDING");
  const blocked = list.filter((o) => stoppedAtL6(o) || (o.verdict && !["ALLOW", "ALLOWED", "PENDING", "RECEIVED"].includes(o.verdict)));
  const written = list.filter((o) => o.okx && WRITE_STATUSES.has(o.okx));
  $("kAllow").textContent = allow; $("kBlock").textContent = blocked.length; $("kPending").textContent = pend.length;
  $("kWrites").textContent = written.length;
  const blockedWrites = blocked.filter((o) => o.okx && WRITE_STATUSES.has(o.okx)).length;
  $("kWritesNote").innerHTML = `engellenen ${blocked.length} emirde <b class="${blockedWrites ? "s-BLOCKED" : "s-ALLOWED"}">${blockedWrites} yazma</b>`;
  $("kPayments").textContent = `${list.filter((o) => o.verdict === "REJECTED_PAYMENT").length}× 402`;

  $("pendingCard").classList.toggle("has", pend.length > 0);
  $("pending").innerHTML = pend.length ? pend.map((o) => `<div class="pend">
      <div><b>${esc((o.order?.side ?? "").toUpperCase())} ${esc(o.order?.sz)} ${esc(o.order?.instId)}</b> @ ${esc(num(o.order?.px) || "market")}
      <span class="muted">· ${esc(num(o.notional))} USDT · ${esc(reason(o.code))}</span></div>
      <div class="actions"><button class="ok" data-approve="${esc(o.requestId)}">Onayla</button><button class="danger" data-reject="${esc(o.requestId)}">Reddet</button></div></div>`).join("")
    : '<p class="muted">Yok</p>';
}

// ---------------------------------------------------------------------------------------------- owner actions

async function signTyped(primaryType, message) {
  if (!window.ethereum) {
    // Local demo only (TEST/DEMO mock gateway started with INSECURE_OWNER=1).
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
  if (owner && account.toLowerCase() !== owner.toLowerCase()) alert("Bu cüzdan policy sahibi değil; imzalar reddedilecek.");
}

async function decideApproval(requestId, decision) {
  const detail = await fetch(`/v1/intents/${encodeURIComponent(requestId)}`).then((r) => r.json());
  const msg = { requestId, policyId, normalizedOrderHash: detail.normalizedOrderHash, decision, nonce: nonce16(), expiresAt: now() + 120 };
  const ownerSignature = await signTyped("ApprovalDecision", msg);
  const res = await fetch("/v1/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...msg, ownerSignature }) }).then((r) => r.json());
  if (res.status === "ERROR" || res.message) alert(res.message ?? "onay reddedildi");
}

async function togglePause() {
  const msg = { policyId, paused: !paused, nonce: nonce16(), issuedAt: now() };
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

// ---------------------------------------------------------------------------------------------- start

await loadPolicy().catch((e) => ($("policyBody").innerHTML = `<dt>hata</dt><dd>${esc(e.message)}</dd>`));
await refreshStatus();
setInterval(refreshStatus, 3000);
const es = new EventSource("/v1/events");
es.onopen = () => { $("conn").textContent = "canlı"; $("conn").className = "pill s-ALLOWED"; };
es.onerror = () => { $("conn").textContent = "bağlantı koptu"; $("conn").className = "pill s-BLOCKED"; };
// The gateway sends named SSE events (`event: <AuditEvent.type>`), which EventSource delivers only to matching
// listeners; the TEST/DEMO gateway sends unnamed ones, delivered to onmessage.
const AUDIT_EVENT_TYPES = ["intent_received", "intent_rejected", "decision", "approval", "authorization_issued",
  "execution", "reconciliation", "pause", "policy_loaded", "read_recorded", "chain_write"];
const handle = (m) => onEvent(JSON.parse(m.data));
for (const t of AUDIT_EVENT_TYPES) es.addEventListener(t, handle);
es.onmessage = handle;
