# ReelForge — Product Requirements Document

- **Version:** 1.0
- **Status:** Engineering-ready Draft
- **Product:** ReelForge — Open-Source AI Video Editing Engine
- **Platform awal:** macOS Apple Silicon
- **Arsitektur:** Hybrid Desktop Studio + Automation Engine + MCP
- **Lisensi target:** Apache-2.0
- **UI reference:** [design/edit-studio-mockup.png](design/edit-studio-mockup.png)

## 1. Product Overview

ReelForge adalah aplikasi video editing berbasis AI yang menggabungkan kemampuan nonlinear video editing profesional dengan automation engine yang dapat dikendalikan menggunakan bahasa natural.

Produk harus dapat digunakan melalui:

- Desktop Studio untuk editing manual dan AI-assisted editing.
- AI Director bawaan aplikasi, dengan pilihan provider AI.
- MCP Server untuk integrasi dengan ChatGPT, Claude, Gemini CLI, dan MCP client kompatibel.
- CLI dan API untuk menjalankan workflow otomatis tanpa membuka desktop editor.

Semua antarmuka wajib menggunakan satu editing core, satu representasi timeline, dan satu sistem penyimpanan proyek.

Product positioning: The Open-Source AI-Native Video Editing Engine.

Tagline: Describe it. Edit it. Ship it.

## 2. Product Goals

### Primary Goals

- **G-01 — Automated Video Creation.** Pengguna dapat mengimpor footage dan menghasilkan draft video vertikal melalui instruksi natural language.
- **G-02 — Editable AI Output.** Hasil AI harus berupa timeline yang sepenuhnya dapat diedit, bukan video yang sudah diratakan menjadi satu file.
- **G-03 — Cross-AI Integration.** AI provider eksternal dapat membaca proyek, memberikan edit proposal, mengubah timeline dengan persetujuan, dan meminta render melalui API yang konsisten.
- **G-04 — Local-First.** Media dan proyek dapat diproses secara lokal tanpa akun cloud. Layanan AI eksternal bersifat opsional.
- **G-05 — Non-Destructive Editing.** Original footage tidak boleh dimodifikasi oleh proses editing.
- **G-06 — Extensible Open Source.** Komunitas dapat menambahkan AI provider, efek, workflow recipe, dan integration adapter.

### Non-Goals untuk Alpha

ReelForge Alpha tidak ditujukan sebagai pengganti penuh Adobe Premiere Pro atau DaVinci Resolve.

Cloud collaboration, template marketplace, mobile editing, generative text-to-video, dan direct social publishing tidak termasuk MVP.

## 3. Target Users

- **Content Creator** — Membutuhkan cara cepat untuk mengubah footage menjadi video Instagram Reels, TikTok, atau YouTube Shorts.
- **Social Media Marketer** — Membutuhkan editing berulang menggunakan template branding dan workflow otomatis.
- **Professional Editor** — Membutuhkan AI untuk mempercepat pekerjaan, tanpa kehilangan kontrol atas clip, timing, audio, color grading, dan caption.
- **AI Developer** — Membutuhkan API, SDK, dan MCP tools untuk menjalankan video editing dari software atau AI agent eksternal.

## 4. Release Scope

| Modul | Alpha P0 | Beta P1 |
|---|---|---|
| Project Manager | Create, save, reopen, recovery | Portable packages |
| Media Library | Import, thumbnails, proxy | Advanced media management |
| Timeline | Multi-track, split, trim, undo | Advanced keyframes |
| AI Director | Proposal, approval, apply | Conversational revisions |
| Transcription | Local transcription | Translation |
| Captions | Word highlighting, presets | Advanced motion captions |
| Music | Beat detection, basic mix | Advanced audio processing |
| Color | Basic adjustments, LUT | Advanced grading |
| Render | MP4 H.264/AAC | More formats and encoders |
| Integration | Local MCP + CLI | Remote MCP + hosted gateway |
| Desktop | macOS Apple Silicon | Windows / Linux |

Prioritas P0 harus selesai dan lolos pengujian sebelum pengembangan fitur P1 dimulai secara luas.

## 5. Core User Workflow

### Workflow A — Automatic Reel Creation

1. Pengguna membuat proyek.
2. Memilih aspect ratio, resolusi, dan frame rate.
3. Mengimpor beberapa footage.
4. Sistem membuat thumbnail dan proxy.
5. Media Analysis Engine mendeteksi scene, transkrip, dan beat musik.
6. Pengguna memberi instruksi melalui AI Director.
7. AI Planner menghasilkan structured edit proposal.
8. Pengguna memeriksa perubahan dan preview.
9. Setelah disetujui, perubahan diterapkan ke timeline.
10. Pengguna dapat mengedit hasil secara manual.
11. Sistem merender video dan menyimpan output final.

### Workflow B — Conversational Editing

Pengguna memilih satu clip dan memberikan instruksi, misalnya:

> "Percepat scene ini, tambahkan zoom, dan ubah warna caption menjadi cyan."

AI menerima selection context serta current project revision, lalu mengembalikan operasi yang memengaruhi clip terkait.

AI tidak boleh mengubah clip lain tanpa alasan atau instruksi yang valid.

### Workflow C — MCP Automation

External AI client memanggil MCP tools untuk membuat proyek, membaca media, meminta analisis, membuat proposal, dan melakukan export setelah persetujuan.

Long-running operations mengembalikan job ID sehingga status dapat dipantau secara terpisah.

## 6. Functional Requirements — Project Manager

- **FR-001:** Pengguna dapat membuat, membuka, mengganti nama, dan menyimpan proyek.
- **FR-002:** Default project resolution 1080×1920 dan 30 FPS.
- **FR-003:** Proyek memiliki ID unik, schema version, dan revision number.
- **FR-004:** Setiap operasi editing disimpan secara transaksional.
- **FR-005:** Mendukung auto-save dan pemulihan setelah crash.
- **FR-006:** Proyek tetap dapat dibuka meskipun AI provider tidak tersedia.
- **FR-007:** Mendukung deteksi file sumber yang hilang dan proses relink.

**Acceptance criteria:** Proyek dengan beberapa layer video, audio, efek, dan caption dapat disimpan, ditutup, lalu dibuka kembali tanpa kehilangan edit yang sudah berhasil disimpan.

## 7. Functional Requirements — Media Engine

- **FR-008:** Mendukung input MP4, MOV, JPEG, PNG, WAV, dan MP3 dalam test matrix MVP.
- **FR-009:** Menggunakan FFprobe untuk membaca media metadata.
- **FR-010:** Membuat thumbnail serta proxy video.
- **FR-011:** Menjalankan scene detection dan transkripsi audio.
- **FR-012:** Mendeteksi beat musik.
- **FR-013:** Menampilkan progres analisis dan pesan kesalahan yang bisa ditindaklanjuti.
- **FR-014:** Semua proses analisis harus dapat dijalankan tanpa memblokir UI.

Media asli hanya dibaca, bukan ditimpa.

## 8. Functional Requirements — Timeline Engine

Timeline harus mendukung:

- Video tracks, audio tracks, overlay tracks, dan caption tracks.
- Clip trimming, splitting, moving, reordering, dan ripple editing.
- Snapping serta timeline zoom.
- Track mute, lock, hide, dan selection.
- Undo/redo dan revision history.
- Clip transform dasar.
- Clip gain, fades, dan basic transitions.

Perhitungan waktu harus menggunakan integer frames dengan rational FPS. Video yang memiliki variable frame rate harus dikonversi secara eksplisit ke project timebase.

- **FR-015:** Semua operasi editing harus bersifat atomic.
- **FR-016:** Operasi dengan revision usang wajib menghasilkan conflict error, bukan menimpa timeline.
- **FR-017:** Render graph dan preview harus membaca timeline state yang sama.
- **FR-018:** Perubahan yang ditolak oleh validator tidak boleh mengubah state proyek.

## 9. AI Director Specification

AI Director merupakan panel interaktif yang memahami project context dan selection context.

### Input

- User instruction.
- Project settings.
- Media metadata.
- Scene analysis.
- Transcript.
- Current timeline.
- Selected clips.
- Allowed editing operations.

### Output

AI harus menghasilkan struktur yang terdiri atas:

- Proposal ID.
- Project ID dan base revision.
- Daftar editing operations.
- Penjelasan perubahan.
- Warnings.
- Estimated duration.
- Approval requirement.

### Functional Rules

- **FR-019:** AI tidak boleh menghasilkan arbitrary shell execution.
- **FR-020:** AI tidak memiliki izin otomatis untuk menghapus original footage.
- **FR-021:** Setiap proposal divalidasi menggunakan schema dan semantic rules.
- **FR-022:** UI menampilkan diff antara kondisi sebelum dan sesudah.
- **FR-023:** Pengguna dapat menerima atau menolak proposal.
- **FR-024:** Proposal yang sudah diterapkan tercatat dan dapat di-undo.
- **FR-025:** API key disimpan menggunakan secure storage sistem operasi.

## 10. Caption & Typography Engine

ReelForge harus mendukung:

- Speech-to-text transcription.
- Timed subtitle segments.
- Word-level highlight bila tersedia timestamp.
- Pilihan font, ukuran, warna, stroke, dan shadow.
- Pengaturan caption safe area.
- Editing teks dan waktu secara manual.
- Setidaknya tiga caption style presets.
- Export subtitle SRT secara opsional.

Style data harus disimpan secara terpisah dari transkrip agar perubahan tampilan tidak menghilangkan konten atau timestamp.

## 11. Audio & Music Engine

Persyaratan MVP:

- Import musik dan voiceover.
- Audio waveform dalam timeline.
- Gain serta fade control.
- Beat detection dan beat grid.
- Auto-cut suggestion berdasarkan beat.
- Basic voice ducking.
- Audio clipping protection.
- Audio export AAC.

Musik harus berasal dari pengguna atau aset yang memiliki lisensi sesuai. ReelForge tidak menyediakan katalog lagu komersial tanpa lisensi.

## 12. Color & Motion Engine

MVP mencakup brightness/exposure, contrast, saturation, temperature, basic LUT presets, crop, position, scale, rotation, opacity, zoom, dan basic dissolve.

Advanced subject tracking, AI smart reframe, motion tracking, dan sophisticated grading ditetapkan sebagai fitur Beta atau berikutnya.

Setiap efek harus tersimpan sebagai parameter terstruktur dan dapat dirender ulang secara deterministik.

## 13. Rendering Specification

### Default Export

- Container: MP4.
- Video codec: H.264.
- Audio codec: AAC.
- Resolution: 1080×1920.
- Framerate: 30 FPS.
- Output mode: Portrait 9:16.

### Render Job States

`queued → analyzing → rendering → muxing → completed`

Status alternatif adalah `failed` atau `cancelled`.

Render job wajib menyediakan progress, stage, error code, retry, cancel, dan output reference.

Output disimpan melalui temporary file dan finalisasi atomik agar hasil yang gagal tidak dianggap sebagai file export final.

## 14. MCP Integration

ReelForge menyediakan dua transport utama:

- **Local MCP (P0):** stdio untuk aplikasi AI lokal yang kompatibel.
- **Remote MCP (P1):** HTTPS Streamable HTTP dengan OAuth dan project-scoped permissions.

MCP tools minimum:

- `projects.list`
- `projects.create`
- `projects.get`
- `media.import`
- `media.analyze`
- `media.get_analysis`
- `timeline.get`
- `timeline.propose_edit`
- `timeline.get_proposal`
- `timeline.apply_proposal`
- `timeline.undo`
- `captions.generate`
- `audio.detect_beats`
- `preview.create`
- `render.start`
- `jobs.get`
- `jobs.cancel`
- `outputs.get`

Tindakan yang membutuhkan persetujuan tidak boleh hanya mengandalkan pernyataan AI bahwa persetujuan sudah diberikan.

Status kompatibilitas ChatGPT, Claude, dan Gemini harus diverifikasi sesuai jenis aplikasi, protocol version, dan transport masing-masing.

## 15. REST API & CLI

### REST API

Contoh endpoint:

- `POST /v1/projects`
- `GET /v1/projects/:id`
- `POST /v1/projects/:id/assets`
- `GET /v1/projects/:id/timeline`
- `POST /v1/projects/:id/proposals`
- `POST /v1/projects/:id/proposals/:proposalId/apply`
- `POST /v1/projects/:id/preview-jobs`
- `POST /v1/projects/:id/render-jobs`
- `GET /v1/jobs/:jobId`
- `POST /v1/jobs/:jobId/cancel`

### CLI

CLI harus mendukung create project, import media, analyze, create plan, generate preview, render, inspect project, dan memantau job.

Operasi CLI harus memiliki output JSON agar mudah dibaca AI agent dan automation workflow.

## 16. Desktop UI/UX Requirements

### Design Direction

Dark professional creative software.

Visual tokens:

- Background: `#090F16`
- Surface: `#141E2B`
- Primary: `#00D5ED`
- Selection: `#186CE6`

### Screen Architecture

- **Top Bar:** Project switcher, workspace navigation, save status, undo, redo, export.
- **Left Rail:** Media, Templates, Text, Audio, Effects, Transitions, Color, Settings.
- **Left Panel:** Media Library, asset thumbnails, search, filters.
- **Center:** Preview monitor, playback controls, framing overlays.
- **Right Panel:** AI Director dan contextual Inspector.
- **Bottom:** Multi-track timeline, time ruler, track controls, waveform.

### Workspace Modes

- **Edit Studio:** Manual editing dan AI-assisted editing.
- **Automation Lab:** Workflow templates dan automation pipeline.
- **Review & Export:** Proposal review, version comparison, render queue.

Minimum layout target 1280×720 dengan collapsible panels. Baseline optimal 1440×900 ke atas.

Panel harus resizable, dengan penyimpanan layout preference.

## 17. System Architecture

ReelForge dibagi menjadi tujuh domain utama:

1. **Desktop Client:** Tauri 2, React, TypeScript.
2. **Control Layer:** MCP, REST, CLI, authorization.
3. **Application Core:** Project management, orchestration, command services.
4. **Timeline Engine:** Editing state, operations, validation, revision.
5. **Media Engine:** FFmpeg, proxy, decoding, render graph.
6. **AI Intelligence Layer:** Provider adapters, scene analysis, transcription, edit planning.
7. **Persistence Layer:** SQLite, filesystem, optional PostgreSQL dan object storage.

Pemrosesan media dilakukan pada worker terpisah agar kegagalan decoder/render tidak langsung menghentikan seluruh desktop UI.

Cloud deployment tidak menjadi ketergantungan untuk local mode.

## 18. Logical Database Model

| Entity | Tujuan |
|---|---|
| Project | Metadata proyek dan revision |
| Asset | Referensi source footage |
| Proxy | Derived media cache |
| Track | Video/audio/caption layer |
| Clip | Timeline media instance |
| Effect | Parameter efek dan transform |
| Caption | Teks dan timestamp |
| EditOperation | Audit dan undo/redo |
| AIProposal | Proposal perubahan |
| Approval | Bukti persetujuan |
| Analysis | Hasil AI/media analysis |
| RenderJob | Status proses render |
| Artifact | File hasil render |
| WorkflowRun | Riwayat automation |

SQLite menjadi sumber state untuk local project. Database harus memiliki migrations, referential integrity, dan backup/recovery support.

## 19. Security & Privacy

### Mandatory Requirements

- Default deny untuk akses filesystem dan tindakan sensitif.
- Aset diakses menggunakan project-scoped asset references.
- External AI provider tidak menerima footage atau transkrip tanpa consent.
- API credentials disimpan dalam OS Keychain.
- Seluruh parameter model divalidasi sebelum diteruskan ke editing engine.
- Tidak ada unrestricted shell command dari output AI.
- Path traversal dan symlink escape dicegah.
- MCP remote memerlukan autentikasi, scope enforcement dan origin checks.
- Job processing memiliki resource limits, timeout dan cancellation.
- Diagnostic logs menyembunyikan secrets serta informasi yang tidak diperlukan.

Project export tidak boleh mengandung API keys atau authentication tokens.

## 20. Non-Functional Requirements

### Reliability

- Basic edit operation harus tersimpan secara transaksional.
- Crash recovery mengembalikan committed revision terakhir.
- Render worker gagal tidak boleh merusak project database.
- Media offline menghasilkan error yang jelas dan relink option.

### Performance Targets

- UI startup target maksimal 5 detik pada benchmark hardware.
- Basic timeline operation target p95 maksimal 100ms untuk proyek 100 clips.
- Preview timestamp tolerance maksimal satu project frame.
- Preview proxies menggunakan progressive cache.
- Local render memiliki concurrency limit untuk menjaga responsivitas desktop.

Angka tersebut merupakan target pengujian, bukan klaim performa yang sudah diukur.

### Accessibility

Keyboard navigation, visible focus, readable labels, caption text editing tanpa drag, reduced motion preference, serta color contrast yang memadai.

## 21. Testing Requirements

- **Unit Testing:** Timebase conversion, edit commands, state serialization, undo/redo, render graph.
- **Integration Testing:** Media pipeline, SQLite persistence, AI planner schema validation, MCP tool execution.
- **End-to-End Testing:** Project creation → import → analysis → AI proposal → approval → edit → preview → export → reopen.
- **Security Testing:** Unauthorized project access, malicious filenames, invalid model output, injection attempts, filesystem traversal, stale revision.
- **Media Compatibility Testing:** Portrait, landscape, different framerates, mono/stereo, silent input, unsupported codecs, corrupted files.
- **Release Testing:** Install on clean machine, offline workflows, signed build, onboarding and recovery.

## 22. Development Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Foundation** | Monorepo, Tauri desktop shell, project schema, SQLite, design tokens, basic project CRUD, CI pipeline | Desktop dan CLI dapat membaca state proyek yang sama |
| **M1 — Editing Core** | Import media, timeline tracks, trim, split, move, undo/redo, revision handling | Editing state stabil dan tersimpan setelah restart |
| **M2 — Preview & Render** | Proxy engine, canonical render graph, playback transport, FFmpeg render jobs | Proyek 30 detik dapat di-render ke MP4 sesuai spesifikasi |
| **M3 — Media Intelligence** | Transkripsi, scene detection, beat analysis, basic caption generation | Analisis menghasilkan structured data yang dapat dikonsumsi oleh AI Planner |
| **M4 — AI Director** | Provider adapters, structured proposals, approval workflow, diff viewer | AI dapat mengusulkan, menerapkan, dan membatalkan perubahan pada timeline |
| **M5 — MCP & Automation** | Local MCP server, CLI, workflow JSON, job monitoring | AI client kompatibel dapat membuat dan memproses proyek melalui MCP |
| **M6 — Alpha Release** | Security hardening, end-to-end testing, signing, packaging, documentation, license audit | Semua mandatory release gates lulus |

## 23. Risks and Mitigation

| Risiko | Mitigasi |
|---|---|
| Preview berbeda dengan export | Canonical render graph |
| AI menghasilkan operasi salah | Typed schema dan validation |
| Footage besar membuat UI lambat | Proxies dan worker process |
| MCP compatibility berbeda | Client/version test matrix |
| Timing frame tidak akurat | Rational timebase |
| Masalah lisensi codec | Dependency/license audit |
| Kebocoran data footage | Local-first dan consent |
| Scope pengembangan membesar | P0/P1/P2 release gates |

## 24. Definition of Done — Alpha

ReelForge v0.1 Alpha dianggap selesai ketika:

- [ ] Desktop macOS Apple Silicon dapat diinstal dan dijalankan.
- [ ] Project dapat dibuat, disimpan dan dibuka kembali.
- [ ] Media dapat diimpor dan dianalisis.
- [ ] Timeline mendukung editing dasar multi-track.
- [ ] Undo/redo berfungsi konsisten.
- [ ] AI menghasilkan valid edit proposal.
- [ ] Pengguna dapat approve/reject proposal.
- [ ] Invalid AI operations tidak mengubah timeline.
- [ ] Local speech transcription dan captions bekerja.
- [ ] Beat detection menghasilkan candidate markers.
- [ ] Preview menampilkan hasil sesuai render graph.
- [ ] Export MP4 H.264/AAC dapat diselesaikan.
- [ ] Local MCP integration lulus end-to-end testing.
- [ ] CLI mendukung workflow tanpa desktop UI.
- [ ] Original footage tidak pernah ditimpa.
- [ ] Security, recovery, license, documentation dan CI checklist selesai.

## 25. Open Source Strategy

ReelForge menggunakan Apache-2.0 sebagai lisensi target untuk original source code.

Repository publik perlu menyediakan:

- README dan dokumentasi quickstart.
- CONTRIBUTING dan CODE_OF_CONDUCT.
- SECURITY policy dan vulnerability reporting.
- Issue templates serta pull request templates.
- API dan MCP documentation.
- Example workflows serta test fixtures berlisensi.
- Release notes, changelog, dan versioning policy.

Distribusi harus memperhatikan lisensi FFmpeg, dependencies, model weights, fonts, LUTs, serta batasan codec sesuai konfigurasi build.

## 26. Final Product Requirement

ReelForge harus memungkinkan seorang pengguna atau AI agent yang terotorisasi mengubah raw footage menjadi video vertikal yang editable, reproducible, reviewable, dan exportable melalui satu non-destructive editing engine.

Semua fitur lanjutan harus dibangun di atas kontrak timeline dan rendering yang sama, bukan melalui editing pipeline terpisah.

---

*Document status: Approved architecture; engineering specification ready for milestone breakdown and implementation.*
