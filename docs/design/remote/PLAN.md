# ReelForge Remote — rencana implementasi

Status: tahap 1 (fondasi) selesai di branch `feat/phone-remote`, belum di-commit. Mockup: `mockup.html` (screenshot: `mockup.png`).

## Tujuan

Mengontrol ReelForge yang berjalan di Mac dari HP, lewat relay milik sendiri yang di-deploy di Railway —
pola yang sama dengan `seeker remote`. Dari HP bisa: melihat proyek dan job, menyuruh AI Director,
meninjau lalu Apply/Reject proposal, render export dan mengunduh hasilnya, mengirim video dari HP ke proyek,
dan menerima notifikasi.

Bedanya dengan connector Claude/ChatGPT yang sudah ada (`packages/mcp/src/remote/`): connector memberi
kendali ke **model AI pihak lain** lewat MCP + ngrok. Remote ini memberi kendali ke **HP kamu sendiri**,
tanpa ngrok, tanpa membuka port, dan isi percakapannya tidak bisa dibaca relay.

## Cara SEEKER melakukannya (yang ditiru)

Dibaca dari `~/seeker/remote-server/server.mjs` dan `~/seeker/src/remote.mjs`.

```
 HP (PWA)  ──HTTPS──▶  relay di Railway  ◀──HTTPS (keluar saja)──  Mac (daemon)
            /api/*      kotak surat, tidak       /agent/*
                        bisa membaca isinya
```

- **Satu rahasia, dua turunan.** `secret` 32 byte acak disimpan di Mac. `token = HMAC(secret,"…-auth-v1")`
  membuka relay; `key = HMAC(secret,"…-enc-v1")` mengenkripsi isi (AES-256-GCM, `iv ‖ ciphertext ‖ tag`,
  base64 — format yang sama dengan WebCrypto di browser). Relay hanya diberi `SHA-256(token)` lewat env var,
  jadi relay tidak bisa membaca maupun memalsukan apa pun.
- **Pairing = satu link** `https://<relay>/#k=<secret>`. Fragment `#` tidak pernah dikirim ke server; PWA
  menurunkan token + key sendiri.
- **Relay tanpa dependensi dan tanpa database** (satu file Node, ±320 baris): log event terenkripsi di memori
  (maks 3000 entri / 12 MB, snapshot mengosongkan log), SSE ke HP dan ke Mac, `blob` (file sekali ambil,
  TTL 10 menit) dan `chunk` (file besar dipecah, backpressure 507). Lockout 10 salah token per IP / 15 menit,
  IP dari `x-forwarded-for` hop pertama di Railway.
- **Mac hanya koneksi keluar**: `GET /agent/stream` (SSE perintah dari HP) + `POST /agent/events`
  (event terenkripsi). Reconnect dengan backoff 1 s → 30 s; setiap konek ulang mengirim snapshot penuh.
- **Perintah dari HP**: `{id, at, type, …}` terenkripsi; ditolak kalau `id` sudah pernah dilihat atau `at`
  terlalu jauh dari jam Mac (anti-replay). Dispatch dengan `switch (type)` — daftar putih, bukan proxy umum.
- **Push notification** langsung Mac → layanan push HP (Web Push), relay tidak terlibat.
- **App lock** di HP (Face ID / PIN 6 digit, PBKDF2), 3 PIN salah = unpair.

## Arsitektur ReelForge Remote

| Bagian | Lokasi | Isi |
| --- | --- | --- |
| Relay + PWA | `apps/remote/` (folder yang di-deploy) | `server.mjs` disalin dari SEEKER (Apache-2.0, kode kamu sendiri), nama env `REELFORGE_REMOTE_AUTH`; `public/` = PWA hasil build |
| PWA | `apps/remote/public/` | ES module biasa tanpa build step (seperti relay aslinya): deploy = salin folder, tidak ada build di Railway. Warna disalin dari `tokens.css` desktop; CSP relay melarang inline style, jadi semua di `style.css` |
| Daemon | `packages/remote/` | `keys.ts` (derive/seal/unseal), `daemon.ts` (loop relay, outbox, snapshot), `commands.ts` (daftar putih perintah → store engine), `transfer.ts` (chunk naik/turun), `push.ts` |
| Engine | `packages/server/src/index.ts` | `RemoteManager` diinjeksi seperti `ConnectorManager`: route `/v1/remote` (status, start, stop, setup, unpair) |
| Desktop | `ConnectorSettings.tsx` → section baru **Phone remote** di Settings | URL relay, nilai `REELFORGE_REMOTE_AUTH` (Copy), QR + link pairing, daftar HP, Start/Stop, auto-start |
| CLI | `reelforge remote --setup / --url / start` | memakai manager yang sama, seperti `reelforge connector` |

Daemon memanggil **store engine secara langsung di proses yang sama** (ProjectStore, TimelineStore,
proposals, RenderRunner), bukan REST lokal — sama seperti connector yang berbagi Render/AnalysisRunner.
Tidak ada path file dari HP yang pernah dipakai: HP menyebut `projectId`, `assetId`, `jobId`, tidak pernah path.

## Perintah HP → Mac (daftar putih)

| type | Dipetakan ke | Catatan |
| --- | --- | --- |
| `sync` | snapshot | daftar proyek, job aktif, proposal menunggu, status Mac |
| `project.open` | ringkasan proyek | durasi, format, jumlah klip per track, thumbnail poster (blob) |
| `ai.ask` | `propose()` | prompt AI Director; provider = yang dipilih di desktop; consent eksternal tetap dari desktop |
| `proposal.apply` / `proposal.reject` | `proposals.apply/reject` | **keputusan baru, lihat Keamanan** |
| `undo` / `redo` | `projects.undo/redo` | |
| `render.start` | `createRenderJob` | preset saja (9:16 1080p, 1:1, 16:9); output ke folder exports default, tidak bisa memilih path |
| `job.cancel` / `job.retry` | runner | |
| `file.get` | chunk turun | hasil render atau preview 720p; ukuran ditampilkan dulu, unduh atas izin HP |
| `media.add` | chunk naik → `importMedia` | file masuk `<home>/inbox/` dulu, divalidasi demuxer per ekstensi |
| `captions.generate` | captions/generate | |
| `push.subscribe` / `push.prefs` | Web Push | render selesai, proposal siap, job gagal |
| `ping` | — | round-trip di Home |

Tidak dari HP: hapus proyek, relink aset, workflow, fx bake manual, setelan API key, connector Claude/ChatGPT.

## Event Mac → HP

`snapshot` (state penuh), `job.progress` (dibatasi 1×/detik per job), `proposal.ready`, `project.changed`
(revisi baru), `agent.online/offline` dari relay. Thumbnail poster ≤ 60 KB per proyek; frame preview dan video
lewat blob/chunk sesuai permintaan, tidak pernah di log (satu gambar mendorong ratusan event keluar).

## Video besar

Relay menahan maks 40 MB per arah sekaligus, dan Railway membayar egress. Jadi:
- Default unduh = **preview 720p** (job preview yang sudah ada); hasil export penuh hanya kalau diminta,
  ukurannya ditampilkan dulu.
- Chunk 1 MB terenkripsi, dikirim berurutan dengan backpressure (pola `transfer.mjs` SEEKER).
- Upload dari HP sama, naik ke inbox; batas per file bisa diatur (default 500 MB).

## Keamanan

- **Apply dari HP adalah wewenang baru.** Aturan saat ini: proposal hanya di-apply lewat tombol desktop atau
  `ai apply --yes`. HP yang sudah di-pair memegang rahasia pemilik, jadi diperlakukan seperti desktop —
  tapi ini perlu keputusan kamu (lihat Pertanyaan). Model AI tetap tidak pernah bisa apply sendiri.
- Isi selalu terenkripsi ujung ke ujung; relay hanya tahu hash token.
- Anti-replay (`id` + `at`), lockout per IP, CSP `default-src 'self'`, HSTS — semuanya dari SEEKER.
- App lock wajib sebelum Apply/Render dari HP (disarankan).
- Unpair / link bocor: rotate `secret` dari Settings → relay diberi nilai baru → semua HP lama mati.

## Tahapan

1. ✅ **Fondasi** (2026-11-18) — salin relay + tesnya, `packages/remote/keys.ts` + tes kompatibilitas WebCrypto,
   daemon loop + snapshot, `RemoteManager` + route engine, section Settings (URL relay, nilai auth, QR, Start/Stop).
   Selesai kalau: relay lokal + HP (Playwright 390 px) melihat daftar proyek dan status online.
   Terbukti: tes `packages/remote/test`, `apps/remote/test`, route di `server.test.ts`; e2e Chromium: Start dari
   Settings → QR (didekode, isinya = link pairing) → HP 390 px melihat proyek + Online, update langsung saat proyek
   dibuat di Mac, tetap ter-pair setelah reload, "Mac offline" saat Stop. CLI `reelforge remote` belum dibuat.
2. **Pantau** — Home, Projects, detail proyek (poster, ringkasan timeline), job progress, push notification.
3. ✅ **AI Director dari HP** (2026-11-18) — kirim prompt (pilih model dari daftar Mac; izin provider eksternal tetap
   dari desktop), progres + Cancel, proposal (ringkasan, peringatan, daftar perubahan, tanda basi), Apply/Reject,
   Undo/Redo. Apply tercatat `by: api`, `channel: phone-remote:apply`. AI Director desktop kini memuat ulang daftar
   proposal tiap 4 detik. Terbukti: tes `remote.test.ts` stage 3; e2e Chromium 390 px dengan Ollama qwen2.5:14b
   sungguhan (57 dtk → proposal → Apply → Undo → Redo → Cancel). App lock belum dibuat.
4. **Render & unduh** — preset, progress, unduh preview/export via chunk, cancel/retry.
5. **Kirim media dari HP** — upload chunk ke inbox → import → muncul di library; captions generate.
6. **Deploy** — `cd apps/remote && railway init && railway up`, `railway variable set REELFORGE_REMOTE_AUTH=…`,
   `railway domain`; cek `/healthz` dan bahwa `/assets/*.js` yang tersaji memang build baru. README bagian Remote.

Tiap tahap: tes daemon dengan relay sungguhan di proses (seperti `test/remote.test.mjs` SEEKER), tes relay,
dan layar dilihat di Chromium 390 px. Tahap 6 dan setiap `railway up` menunggu izin kamu.

## Keputusan (2026-11-18)

1. **Apply proposal dari HP: boleh.** HP yang sudah di-pair diperlakukan seperti desktop; app lock tetap
   disarankan sebelum Apply/Render.
2. **Relay terpisah**, project Railway baru bernama **`forge-remote`**.
3. **Pairing pakai QR** (dependensi generator QR di desktop) + link + Copy sebagai cadangan.
