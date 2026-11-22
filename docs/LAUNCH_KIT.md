# Bộ Công Cụ Quảng Bá & Tiếp Cận Cộng Đồng — SyloBeam

File này tổng hợp các bước nhanh và mẫu bài đăng sẵn để bạn copy-paste lên các kênh công nghệ nhằm thu hút người dùng & Star trên GitHub.

---

## Bước 1 (10 giây): Gắn ảnh Social Preview cho link GitHub
1. Truy cập **`https://github.com/nghtrung180905-afk/sylobeam/settings`**.
2. Cuộn xuống mục **Social preview** → bấm **Edit** → **Upload an image...**
3. Chọn file **`docs/social-preview.png`** (`1280×640` đã cắt chuẩn sẵn từ giao diện Dark Mode).

Sau bước này, mỗi lần bạn dán link `https://github.com/nghtrung180905-afk/sylobeam` lên Facebook, Messenger, Discord, Reddit hay X sẽ tự hiện thẻ ảnh xem trước cực đẹp.

---

## Bước 2: Bài đăng mẫu theo từng cộng đồng (Copy & Dán)

### 1. Facebook / J2TEAM Community / Hội nhóm IT Việt Nam
> **[Share Tool Miễn Phí] SyloBeam — Truyền file P2P không giới hạn & Điều khiển PC 60Hz ngay trên trình duyệt (Mã nguồn mở)**
>
> Mình mới hoàn thiện **SyloBeam**, một ứng dụng web + Windows nhỏ gọn giúp gửi ảnh gốc, video nặng hàng GB và điều khiển máy tính từ xa ngay trên iPhone/Android mà **không cần đăng nhập, không lưu file lên server**.
>
> **Điểm nổi bật:**
> - **Quét QR / Nhập mã 6 ký tự là kết nối ngay** giữa điện thoại & PC.
> - **Truyền thẳng P2P (WebRTC)** tốc độ cao trong LAN/Wi-Fi, tự động chuyển qua **Edge Relay mã hóa E2EE** khi dùng mạng 4G/5G bị chặn NAT.
> - **Điều khiển PC 60Hz (DXGI GPU Capture):** vuốt di chuột hoặc chạm trực tiếp trên màn hình điện thoại, zoom 2 ngón, gõ tiếng Việt Unicode, khóa máy / thu hồi tức thì bằng `Ctrl + Alt + Esc`.
> - **Bảo mật đầu-cuối:** DTLS 1.3 / AES-256-GCM, xác thực 6 số SAS, hỏi đồng ý 2 chiều, kiểm tra toàn vẹn SHA-256 từng file.
> - Hỗ trợ Dark / Lightning theme & chuyển ngôn ngữ **Tiếng Việt / English**.
>
> Dùng thử ngay (không cần cài đặt): https://sylobeam.pages.dev/
> Mã nguồn & Bộ cài Windows (`SyloBeam-Setup.exe`): https://github.com/nghtrung180905-afk/sylobeam

---

### 2. VOZ / Tinh Tế / Viblo (Bài chia sẻ kỹ thuật ngắn)
> **Tiêu đề:** [Giới thiệu] SyloBeam — Truyền file ngang hàng P2P + Điều khiển PC 60Hz DXGI xuyên 4G/5G (Web & Windows)
>
> Chia sẻ với anh em dự án **SyloBeam** mình vừa build xong (mã nguồn mở MIT):
> - Truyền file dung lượng lớn theo chunk thích ứng (256KB trên Wi-Fi / 64KB trên 4G) có Backpressure nên gửi file nặng trên Safari iPhone vẫn mượt, không tràn RAM.
> - Kết hợp **Cloudflare Workers + Durable Objects** làm Relay WebSocket phi trạng thái (zero-storage, mã hóa E2EE) giúp xuyên Symmetric NAT 4G/5G khi P2P trực tiếp không bắt tay được.
> - Trên Windows có app nhẹ (~1.2MB) tích hợp **DXGI Desktop Duplication** (`IDXGIOutputDuplication`) và **Win32 Input Injection** cho độ trễ thấp tới 60Hz, không cần cài server phức tạp.
>
> Link chạy thử ngay: https://sylobeam.pages.dev/
> Repo GitHub & file cài đặt Windows: https://github.com/nghtrung180905-afk/sylobeam
> Mời anh em dùng thử và góp ý thêm!

---

### 3. Hacker News (`Show HN`)
> **Title:** `Show HN: SyloBeam – Browser & Windows P2P file transfer and 60Hz DXGI remote control`
> **URL:** `https://sylobeam.pages.dev/`
>
> **Comment đầu tiên (đăng ngay dưới bài):**
> Hi HN! I built SyloBeam (`https://github.com/nghtrung180905-afk/sylobeam`) for fast, zero-login device-to-device file transfer and 60Hz Windows remote desktop right from mobile or desktop browsers.
>
> Key technical details:
> - Direct WebRTC DataChannel with adaptive `256 KB` LAN / `64 KB` cellular chunking & `bufferedAmount` backpressure, plus per-file SHA-256 verification and 6-digit SAS MITM verification.
> - Automatic fallback to a stateless Cloudflare Durable Objects WebSocket relay (`Zero storage`, E2EE) when strict carrier 4G/5G symmetric NAT blocks ICE.
> - Optional lightweight ~1.2 MB Windows companion installer (`SyloBeam-Setup.exe`) using native DXGI Desktop Duplication (`IDXGIOutputDuplication`), hardware WebRTC encoding, Win32 Unicode input injection, and a `Ctrl+Alt+Esc` hardware kill switch.
> - Supports English & Vietnamese in Settings, Dark / Lightning Light themes, and zero external runtime CDN dependencies (`CSP: default-src 'self'`).

---

### 4. Reddit (`r/selfhosted`, `r/opensource`, `r/SideProject`)
> **Title:** `I built SyloBeam: Zero-login WebRTC P2P file sharing & 60Hz DXGI remote PC control (MIT Open Source)`
>
> Hey everyone! I just open-sourced **SyloBeam**, a lightweight P2P file transfer and remote PC tool you can use directly in the browser or self-host on static hosting + Cloudflare Workers.
>
> **What it does:**
> - Pair Phone ↔ PC in seconds via QR code or a 6-character room code (no accounts, no file size caps, zero server file storage).
> - Encrypted transport (DTLS / AES-256-GCM) + 6-digit SAS check + two-way consent prompt + SHA-256 file integrity verification.
> - Falls back seamlessly to a stateless Cloudflare Edge WebSocket relay when cellular 4G/5G NAT prevents direct P2P.
> - Includes a lightweight native Windows installer (`SyloBeam-Setup.exe`) with 60Hz DXGI screen capture, custom save folder, and `Ctrl+Alt+Esc` instant disconnect.
>
> Live Demo: https://sylobeam.pages.dev/
> GitHub & Releases: https://github.com/nghtrung180905-afk/sylobeam

---

### 5. Product Hunt & AlternativeTo
* **Tagline (60 ký tự):** `Zero-login P2P file share & 60Hz PC control in browser`
* **AlternativeTo (Gắn thay thế cho):** `AirDrop`, `PairDrop`, `Snapdrop`, `LocalSend`, `AnyDesk`, `Parsec`
* **Website / Source:** `https://sylobeam.pages.dev/` · `https://github.com/nghtrung180905-afk/sylobeam`
