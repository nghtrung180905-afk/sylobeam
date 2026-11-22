<div align="center">
  <img src="./assets/logo.svg" alt="SyloBeam Logo" width="88" height="88" />
  <h1>SyloBeam</h1>
  <p><strong>Zero-Friction P2P File Transfer &amp; 60Hz Remote Desktop Control — Direct over Wi-Fi, LAN &amp; 4G/5G</strong></p>

  <p>
    <a href="https://sylobeam.pages.dev/"><img src="https://img.shields.io/badge/Live%20Demo-sylobeam.pages.dev-1d8cff?style=for-the-badge" alt="Live Demo" /></a>
    <img src="https://img.shields.io/badge/Protocol-WebRTC%20P2P%20%2B%20E2EE-10b981?style=for-the-badge" alt="WebRTC P2P E2EE" />
    <img src="https://img.shields.io/badge/Remote%20Desktop-60Hz%20DXGI%20%26%20GPU-6366f1?style=for-the-badge" alt="60Hz DXGI" />
    <img src="https://img.shields.io/badge/License-MIT-white?style=for-the-badge" alt="MIT License" />
  </p>

  <p>
    <a href="https://sylobeam.pages.dev/"><strong>Open Web App</strong></a> ·
    <a href="#how-it-works">How It Works</a> ·
    <a href="#option-2-windows-desktop-app-60hz-dxgi-remote-control--auto-save-folder">Windows App</a> ·
    <a href="https://github.com/nghtrung180905-afk/sylobeam/releases/latest"><strong>Download Release</strong></a> ·
    <a href="#tiếng-việt--giới-thiệu-nhanh">Tiếng Việt</a>
  </p>
</div>

---

![SyloBeam English Dark Mode Preview](./docs/preview-en.png)

## Why SyloBeam?

**SyloBeam** lets you send original-quality photos, multi-gigabyte videos, files, clipboard text, and **remotely control your Windows PC at up to 60Hz** straight from your phone or another computer — with **no login, no cloud file storage, and no file size limits**.

* **Instant Pairing:** Open [`sylobeam.pages.dev`](https://sylobeam.pages.dev/) on both devices, scan the QR code or enter the 6-character code, and connect in seconds.
* **True Peer-to-Peer Speed:** Files stream directly device-to-device via **WebRTC DataChannel** with adaptive `256 KB` LAN / `64 KB` cellular chunking and backpressure flow control — zero RAM crashes even on mobile Safari/Chrome.
* **Works Behind Strict 4G/5G NAT:** Automatically upgrades or falls back to a stateless **Cloudflare Edge E2EE WebSocket Relay** (Durable Objects) when symmetric mobile NAT blocks direct WebRTC.
* **60Hz Remote Desktop (PC ↔ Mobile/Web):** Native **DXGI Desktop Duplication (`IDXGIOutputDuplication`)** + WebRTC hardware video encoding + unordered low-latency UDP DataChannel for responsive touch/trackpad mouse, pinch-to-zoom, and full Vietnamese/Unicode keyboard input.
* **End-to-End Security:** Encrypted transport (**DTLS 1.3 / AES-256-GCM**), **6-digit SAS** verification code, **two-way explicit consent** before any file transfer or remote control, **SHA-256** per-file integrity check, and instant **`Ctrl + Alt + Esc`** emergency kill switch on PC.
* **Modern Studio UI:** Built-in **English / Tiếng Việt** language switcher in Settings, dual **Dark Mode** & **Lightning (Light) Mode**, real-time **WebGL 3D NASA Blue Marble Earth** with rotating satellite cloud layer, custom download folder picker, and installable PWA.

---

## How It Works

```mermaid
flowchart LR
  A["Phone / Browser\n(iOS, Android, macOS, Windows)"] <-->|"1. Handshake (QR / 6-char code)"| S["Signaling\n(PeerJS / Edge Inbox)"]
  A <-->|"2a. Direct WebRTC P2P\nDTLS 1.3 / AES-256-GCM\n(LAN / Wi-Fi / WAN)"| B["PC / Target Device\n(Web or SyloBeam Desktop)"]
  A -.->|"2b. Auto Fallback on 4G/5G NAT\nStateless E2EE WebSocket Relay"| R["Cloudflare Edge\nDurable Object RelayHub"]
  R -.-> B
  B -->|"DXGI 60Hz Capture +\nWin32 Input Injection"| OS["Windows OS"]
```

1. **Zero-Knowledge Architecture:** Files and screen frames are never persisted on any server. On LAN/Wi-Fi, traffic stays 100% inside your local network.
2. **Three-Tier Adaptive Screen Engine:**
   * **Tier 1 (GPU WebRTC H.264/VP8):** Hardware-accelerated video stream via Edge/Chrome MediaStream (`NVENC` / `QuickSync` / `AMF`).
   * **Tier 2 (Native DXGI Desktop Duplication):** Lightweight C# binary (`desktop-app/SwiftDropCapture.cs`) capturing directly in VRAM at ~4ms per frame with live resolution/FPS switching.
   * **Tier 3 (Unordered Fast-UDP / Relay Fallback):** Automatically keeps remote control responsive over 4G/5G.
3. **Zero External CDN Runtime Dependencies:** All libraries (`PeerJS`, `qrcode.js`), fonts (`Space Grotesk`), and NASA satellite Earth textures are self-hosted under strict `Content-Security-Policy: default-src 'self'`.

---

## Quick Start

### Option 1: Use Online Instantly (No Install)
1. Open **[https://sylobeam.pages.dev/](https://sylobeam.pages.dev/)** on Device A and Device B.
2. Scan the QR code or enter the 6-character device code and click **Kết nối**.
3. Confirm the two-way prompt and drag-and-drop files or start remote control.

### Option 2: Windows Desktop App (60Hz DXGI Remote Control + Auto-Save Folder)
1. Download **`SyloBeam-Setup.exe`** from the [Releases](../../releases) page (or click **Tải App** on [`sylobeam.pages.dev`](https://sylobeam.pages.dev/)).
2. Run `SyloBeam-Setup.exe` to install SyloBeam with Desktop & Start Menu shortcuts and Windows uninstaller support.
3. Press **`Ctrl + Alt + Esc`** at any time to immediately revoke remote control.

### Option 3: Run Locally / Self-Host
No build step is required for the static web frontend:

```bash
# Serve locally with Node.js or Python
npx serve -l 8080
# or
python -m http.server 8080
```

To self-host the optional 4G/5G Cloudflare Edge Relay:
```bash
cd swiftdrop-edge-vn
npx wrangler deploy
```

---

## Project Structure

```text
├── index.html                    # Main PWA interface (Dark & Lightning themes)
├── app.js                        # WebRTC P2P engine, 256KB chunking, E2EE Relay, Remote Control & WebGL 3D Earth
├── styles.css                    # Self-hosted precompiled Tailwind + custom studio theme
├── sw.js                         # Service Worker offline cache
├── manifest.json                 # PWA manifest
├── _headers                      # Strict CSP & security headers for Cloudflare Pages
├── assets/                       # Logo SVG/ICO, Space Grotesk font, NASA Blue Marble + Clouds textures
├── vendor/                       # Self-hosted PeerJS & QRCode libraries
├── desktop-app/                  # Windows Native Launcher, DXGI Capture, Win32 Input, Installer & Electron wrapper
└── swiftdrop-edge-vn/            # Stateless Cloudflare Worker + Durable Object E2EE Relay
```

---

## Tiếng Việt — Giới Thiệu Nhanh

**SyloBeam** là phần mềm **truyền file P2P tốc độ cao** và **điều khiển máy tính từ xa 60Hz** hoạt động ngay trên trình duyệt & Windows, không cần đăng nhập và không lưu file lên máy chủ trung gian:

* **Truyền ảnh gốc, video, file dung lượng lớn không giới hạn:** Chạy thẳng giữa điện thoại và máy tính qua Wi-Fi/LAN hoặc tự động xuyên mạng 4G/5G.
* **Điều khiển PC mượt 60Hz từ điện thoại:** Hỗ trợ cảm ứng trực tiếp & trackpad, phóng to/thu nhỏ 2 ngón, gõ tiếng Việt đầy đủ, chụp màn hình siêu nhanh bằng DXGI GPU.
* **Bảo mật đầu-cuối:** Mã hóa DTLS / AES-256-GCM, mã xác thực 6 số SAS, hỏi xác nhận hai chiều, kiểm tra toàn vẹn SHA-256 từng file và phím tắt ngắt khẩn cấp `Ctrl + Alt + Esc`.
* **Giao diện song ngữ & 3D:** Hỗ trợ chuyển **Tiếng Việt / English** trong Cài đặt, chế độ tối **Dark** & sáng **Lightning**, mô phỏng Trái Đất 3D vệ tinh NASA theo thời gian thực.
* **Dùng ngay:** Truy cập **[https://sylobeam.pages.dev/](https://sylobeam.pages.dev/)** hoặc tải bộ cài Windows **`SyloBeam-Setup.exe`** từ trang [Releases](https://github.com/nghtrung180905-afk/sylobeam/releases/latest).

![SyloBeam Vietnamese Dark Mode Preview](./docs/preview-dark.png)

---

## License

Released under the [MIT License](./LICENSE).
