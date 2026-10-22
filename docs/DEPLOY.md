# Herkese açık demo: VPS kurulumu

Bu rehber Leash Agent'ı bir Linux sunucuda **demo** olarak yayına alır: zincir Avalanche **Fuji testnet**,
borsa **taklit** (varsayılan) ya da bir **OKX demo hesabı**. Gerçek para hareket etmez. Gerçek parayla
canlıya alma bu rehberin kapsamında değildir.

Çalışan servisler (`docker-compose.yml`):

| Servis | Ne yapar |
|---|---|
| `gateway` | L3–L7 gateway + executor + dashboard (`scripts/fuji-gateway.ts`). Policy'yi Fuji `PolicyRegistry`'den doğrular, kararları `DecisionLog`'a yazar, `POST /v1/credits` (x402, mock ödeme) sunar. Veriler `leash-data` volume'unda (SQLite). |
| `caddy` | 80/443'ü dinler, gateway'e yönlendirir. Alan adı verilirse HTTPS sertifikasını kendisi alır. SSE akışını tamponlamaz. |

## 1. Gerekenler

- Ubuntu/Debian bir VPS (1 vCPU / 1 GB RAM yeter), 80 ve 443 portları açık.
- Docker + Docker Compose eklentisi: `curl -fsSL https://get.docker.com | sh`
- **`LOGGER_PRIVATE_KEY`**: Fuji'deki `DecisionLog`'a yazma yetkisi olan anahtar (Kişi 3'te; ayrı deploy için
  `fuji-p1.json` kullanılıyorsa Kişi 1'de). Bu anahtarın Fuji AVAX'ı olmalı. **Sohbete, koda, git'e koyma** —
  yalnızca sunucudaki `.env` dosyasına.
- İsteğe bağlı: bir alan adı (A kaydı sunucunun IP'sine yönlenmiş) → otomatik HTTPS.
- İsteğe bağlı: OKX **demo** API anahtarları (Read ayrı, Trade ayrı; Withdraw kapalı).

## 2. Kurulum

```bash
git clone https://github.com/ulukansarikaya/leashagent.git && cd leashagent
cp .env.example .env
chmod 600 .env
nano .env    # LOGGER_PRIVATE_KEY, DEPLOYER_ADDRESS, SITE_ADDRESS (alan adı ya da :80)
docker compose up -d --build
docker compose logs -f gateway   # "Leash Agent gateway on …" ve "dashboard …/?policyId=0x…" satırları
```

Dashboard: `http(s)://<alan-adı-veya-ip>/?policyId=<loglardaki policyId>`

Kontrol:

```bash
curl -s http://<alan-adı-veya-ip>/v1/health    # {"status":"ok", … "chain":{"outbox":{…}}}
```

## 3. OKX demo hesabıyla

`.env` içinde `OKX_MODE=atk`, `OKX_PROFILE=demo`, `OKX_SITE=global` ve `OKX_READ_*` / `OKX_TRADE_*` doldurulur,
sonra `docker compose up -d`. Fuji'deki demo policy'nin `accountRef`'i bu OKX hesabının olmalıdır
(`scripts/fuji-demo-policy.ts`). Market alım, `docs/okx-atk-spike.md` S5 doğrulanana kadar kapalıdır.

## 4. TEE (isteğe bağlı)

Sıradan bir VPS'te TEE donanımı yoktur. `.env`'de `TEE_MODE=simulated` ile attestation protokolü uçtan uca
çalışır ve dashboard'da "simülasyon" olarak görünür, ama ek güvenlik sağlamaz. Gerçek TEE (Intel TDX) için
Phala Cloud'da bir TDX makinesi kullanılır: `deploy/phala/docker-compose.yml` ve adımlar
[`docs/TEE.md`](TEE.md) içinde ("Deploy on Phala Cloud").

## 5. Güncelleme / durdurma

```bash
git pull && docker compose up -d --build   # güncelle (veriler volume'da kalır)
docker compose down                        # durdur (veriler kalır)
docker compose down -v                     # durdur ve TÜM verileri sil (SQLite + sertifikalar)
```

## Güvenlik notları

- Yazma uç noktaları imza ister: emirler agent'ın EIP-712 imzası, onay/durdurma owner cüzdanının imzası.
  İmzasız ya da yanlış imzalı istekler reddedilir.
- Uygulama düzeyinde istek hızı sınırı yok (yalnızca policy'nin dakikalık emir limiti var). Herkese açık
  uzun süreli yayında Caddy önüne bir hız sınırı ya da sağlayıcının güvenlik duvarı eklenmeli.
- `GUARD_SIGNING_KEY` boşsa gateway her başlangıçta yeni bir yetki anahtarı üretir; executor aynı süreçte
  olduğu için bu sorun değildir.
- `.env` dosyası `chmod 600` olmalı ve git'e girmemeli (`.gitignore`'da).
