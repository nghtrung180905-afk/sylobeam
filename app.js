/**
 * SwiftDrop P2P — Hardened Minimalist PairDrop-Style WebRTC Engine
 * Features:
 *  - Persistent Room ID (localStorage) with automatic multi-tab fallback (sessionStorage)
 *  - 4G/5G NAT Traversal Optimization (Multi-STUN + ICE Pool 10 + Adaptive 4G Backpressure)
 *  - Mandatory Remote Consent Gate (consent-request / consent-response + optional Security PIN)
 *  - SAS 6-digit Security Verification Fingerprint (MITM protection)
 *  - Persistent Auto-Reconnect Loop after unexpected 4G/network drops + Recent Peers Memory
 *  - End-to-End SHA-256 File Integrity Verification + 64KB Chunking + Filename Sanitization
 */

(() => {
  'use strict';

  // ============================================================================
  // 1. CONSTANTS & CONFIGURATION
  // ============================================================================
  const PEER_PREFIX = 'swiftdrop-p2p-v1-';
  const RELAY_BASE_HTTP = 'https://swiftdrop-relay.swiftdrop-edge-vn.workers.dev';
  const RELAY_BASE_WS = 'wss://swiftdrop-relay.swiftdrop-edge-vn.workers.dev';
  const ROOM_ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const ROOM_ID_LENGTH = 6;

  // Adaptive Chunking & High-Speed Backpressure Constants (256KB LAN / 64KB 4G-5G)
  const CHUNK_SIZE_LAN = 256 * 1024; // 256 KB for max LAN/Wi-Fi throughput
  const CHUNK_SIZE_MOBILE = 64 * 1024; // 64 KB for 4G/5G & mobile RAM safety
  const MAX_BUFFERED_AMOUNT_WIFI = 4 * 1024 * 1024; // 4 MB high-throughput window
  const BUFFER_LOW_THRESHOLD_WIFI = 1024 * 1024; // 1 MB
  const MAX_BUFFERED_AMOUNT_4G = 512 * 1024; // 512 KB for 4G/5G/Relay bufferbloat prevention
  const BUFFER_LOW_THRESHOLD_4G = 128 * 1024; // 128 KB

  let INITIAL_DESKTOP_TOKEN = '';
  (() => {
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get('desktopToken');
      if (t) {
        INITIAL_DESKTOP_TOKEN = t;
        url.searchParams.delete('desktopToken');
        window.history.replaceState({}, document.title, url.toString());
      }
      if (!window.swiftdropDesktop && INITIAL_DESKTOP_TOKEN) {
        const rpcPost = async (action, bodyObj = {}) => {
          const res = await fetch(`/api/desktop-rpc/${action}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-SwiftDrop-Token': INITIAL_DESKTOP_TOKEN
            },
            body: JSON.stringify(bodyObj)
          });
          return res.json();
        };

        window.swiftdropDesktop = {
          isDesktop: true,
          runtime: 'native-host',
          platform: 'win32',
          getSessionToken: async () => INITIAL_DESKTOP_TOKEN,
          setRemoteControlAuth: (enabled) => rpcPost('set-auth', { enabled: Boolean(enabled) }),
          sendInput: (cmd) => {
            fetch('/api/desktop-rpc/input', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-SwiftDrop-Token': INITIAL_DESKTOP_TOKEN
              },
              body: JSON.stringify(cmd)
            }).catch(() => {});
          },
          getHardwareInfo: async () => {
            const res = await fetch(`/api/hardware-info?token=${encodeURIComponent(INITIAL_DESKTOP_TOKEN)}`, { cache: 'no-store' });
            return res.json();
          },
          getScreenInfo: async () => {
            const hw = await window.swiftdropDesktop.getHardwareInfo();
            return (hw && hw.display) || { width: 1920, height: 1080 };
          },
          getScreenSources: async () => [],
          setScreenConfig: (cfg) => rpcPost('screen-config', cfg || {}),
          stopScreenStream: () => rpcPost('screen-stop', {}),
          saveFile: async (fileName, data) => {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            const res = await fetch('/api/desktop-rpc/save-file', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-SwiftDrop-Token': INITIAL_DESKTOP_TOKEN,
                'X-File-Name': encodeURIComponent(fileName || 'swiftdrop_file')
              },
              body: bytes
            });
            return res.json();
          },
          openDownloadsFolder: (filePath) => rpcPost('open-downloads', { filePath: filePath || '' }),
          getDownloadDir: () => rpcPost('get-download-dir', {}),
          setDownloadDir: (downloadsDir) => rpcPost('set-download-dir', { downloadsDir: downloadsDir || '' }),
          chooseDownloadDir: () => rpcPost('choose-download-dir', {}),
          onEmergencyStop: (callback) => {
            if (typeof callback !== 'function' || typeof EventSource === 'undefined') return () => {};
            const es = new EventSource(`/api/desktop-events?token=${encodeURIComponent(INITIAL_DESKTOP_TOKEN)}`);
            es.onmessage = (ev) => {
              try {
                const msg = JSON.parse(ev.data);
                if (msg && msg.type === 'emergency-stop') callback();
              } catch {}
            };
            return () => es.close();
          }
        };
      }
    } catch {
      // Ignore bridge bootstrap error in regular web browsers
    }
  })();

  const IS_DESKTOP_APP = Boolean(window.swiftdropDesktop && window.swiftdropDesktop.isDesktop);

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // ~326.72
  const CONSENT_TIMEOUT_SEC = 30;
  const AUTO_RECONNECT_INTERVAL_MS = 3000;
  const WEBRTC_FALLBACK_TIMEOUT_MS = 6500;
  const ICE_DISCONNECT_GRACE_MS = 7000;
  const MAX_RECENT_PEERS = 5;

  const STORAGE_KEY_TURN = 'swiftdrop_turn_config_v1';
  const STORAGE_KEY_ROOM = 'swiftdrop_room_id_v1';
  const STORAGE_KEY_ROOM_TAB = 'swiftdrop_room_id_tab_v1';
  const STORAGE_KEY_NICKNAME = 'swiftdrop_nickname_v1';
  const STORAGE_KEY_SHARE_URL = 'swiftdrop_share_base_url_v1';
  const STORAGE_KEY_RECENT_PEERS = 'swiftdrop_recent_peers_v1';
  const STORAGE_KEY_AUTO_RECONNECT = 'swiftdrop_auto_reconnect_v1';
  const STORAGE_KEY_SECURITY_PIN = 'swiftdrop_security_pin_v1';
  const STORAGE_KEY_THEME = 'swiftdrop_theme_v1';
  const STORAGE_KEY_LANG = 'sylobeam_lang_v1';

  const I18N = {
    vi: {
      page_title: 'SyloBeam — Chia Sẻ File & Ảnh P2P Tốc Độ Cao',
      header_code: 'Mã',
      header_download_app: 'Tải App',
      header_copy_link: 'Copy Link',
      header_show_qr: 'Hiện QR',
      header_share: 'Chia sẻ',
      header_install_pwa: 'Cài App',
      title_copy_id: 'Sao chép mã phòng',
      title_regen_id: 'Đổi mã phòng mới',
      title_download_app: 'Tải bộ cài đặt SyloBeam cho Windows (.EXE)',
      title_copy_link: 'Sao chép đường dẫn kết nối nhanh',
      title_show_qr: 'Hiện mã QR kết nối nhanh',
      title_share: 'Chia sẻ liên kết',
      title_install_pwa: 'Cài đặt ứng dụng',
      title_toggle_theme: 'Chuyển chế độ Sáng (Lightning) / Tối (Dark)',
      title_transfers: 'Danh sách file đã truyền',
      title_settings: 'Cài đặt Ngôn ngữ, Giao diện, Thư mục lưu & Mạng 4G',
      hero_head_left: 'KẾT NỐI',
      hero_head_right: 'TỨC THÌ',
      hero_sub_pre: 'Quét QR hoặc nhập mã',
      hero_sub_post: 'để truyền file & điều khiển PC.',
      input_room_placeholder: 'Nhập mã thiết bị...',
      btn_connect: 'Kết nối',
      auto_reconnecting: 'Đang tự động kết nối lại...',
      btn_cancel: 'Hủy',
      recent_devices: 'Thiết bị gần đây',
      auto_reconnect: 'Tự nối lại khi rớt mạng',
      btn_clear: 'Xóa',
      tap_to_send: 'Chạm để gửi',
      host_remote_active: 'Đang cấp quyền điều khiển PC',
      btn_revoke: 'Thu hồi',
      host_gpu_req_pre: 'Điện thoại yêu cầu bật',
      btn_enable_now: 'Bật ngay',
      btn_close: 'Đóng',
      btn_send_files: 'Gửi File / Ảnh',
      btn_send_text: 'Gửi Text / Link',
      btn_remote_pc: 'Điều khiển PC',
      btn_screen_share: 'Chia sẻ màn hình',
      btn_disconnect: 'Ngắt',
      drawer_title: 'Truyền tải P2P',
      drawer_auto_download: 'Tự tải về',
      drawer_open_folder: 'Mở thư mục',
      drawer_clear_history: 'Xóa lịch sử',
      drawer_empty: 'Chưa có phiên truyền file nào. Chạm vào thiết bị trên Radar để gửi file.',
      footer_your_device: 'Thiết bị của bạn:',
      footer_settings_link: 'Cài đặt 4G & Bảo mật',
      footer_e2ee_summary: 'Mã hóa đầu-cuối (DTLS / AES-256-GCM) • Tự động xuyên 4G/5G • Toàn vẹn SHA-256',
      qr_title: 'Quét QR Kết Nối',
      qr_your_room: 'Mã phòng của bạn',
      qr_localhost_warn: 'Đang chạy tại localhost. Link & QR đã tự đổi sang địa chỉ mạng để điện thoại mở được (tránh lỗi Safari không kết nối được localhost).',
      qr_share_url_label: 'Đường dẫn chia sẻ (Tránh lỗi localhost trên điện thoại)',
      qr_share_url_placeholder: 'https://... hoặc http://192.168.1.x:8123',
      qr_copy_btn: 'Copy Link Tự Động Kết Nối',
      text_modal_title: 'Gửi Nhanh Văn Bản / Đường Link',
      text_modal_placeholder: 'Dán đường link hoặc nội dung văn bản cần gửi...',
      btn_send_now: 'Gửi ngay',
      recv_text_title: 'Tin Nhắn / Link Nhận Được',
      btn_copy_content: 'Sao chép nội dung',
      settings_title: 'Cài Đặt & Mạng WebRTC (STUN / TURN 4G)',
      settings_subtitle: 'Đảm bảo gửi file thành công 100% qua mạng di động 4G/5G',
      settings_lang_title: 'Ngôn ngữ',
      settings_lang_desc: 'Chuyển đổi ngôn ngữ hiển thị phần mềm',
      settings_theme_title: 'Giao diện hiển thị',
      settings_theme_desc: 'Chuyển đổi nhanh giữa Dark và Lightning sáng',
      settings_savedir_title: 'Thư mục lưu file nhận được',
      btn_default: 'Mặc định',
      settings_savedir_placeholder: 'Thư mục Downloads mặc định',
      btn_choose: 'Chọn...',
      settings_stun_title: 'STUN Server mặc định (Luôn bật):',
      settings_turn_enable: 'Kích hoạt TURN Server (Open Relay / Metered / Cloudflare)',
      settings_turn_desc: 'Dùng khi 2 máy khác Wi-Fi hoặc dùng mạng 4G/5G Symmetric NAT',
      settings_json_summary: 'Dán nhanh mảng JSON iceServers từ Metered Dashboard',
      settings_json_btn: 'Trích xuất từ JSON',
      settings_pin_label: 'Mã PIN Bảo Mật tùy chọn (4–8 ký tự)',
      settings_pin_placeholder: 'Để trống nếu chỉ dùng xác nhận Đồng ý',
      settings_pin_desc: 'Nếu đặt mã PIN, thiết bị khác khi muốn kết nối phải nhập đúng mã PIN này trước khi bạn phê duyệt.',
      btn_reset_default: 'Khôi phục mặc định',
      btn_save_settings: 'Lưu cấu hình',
      consent_title: 'Yêu Cầu Kết Nối P2P',
      consent_wants_pair: 'muốn ghép nối truyền file trực tiếp với thiết bị này.',
      consent_sas_title: 'Mã Xác Thực Bảo Mật (SAS)',
      consent_sas_desc: 'Kiểm tra mã này khớp với màn hình thiết bị kia để chống nghe lén MITM.',
      consent_pin_label: 'Xác nhận Mã PIN Bảo Mật của bạn (nếu cần):',
      consent_pin_placeholder: 'Nhập mã PIN bảo mật...',
      consent_trust: 'Tin cậy thiết bị này trong phiên này (Tự động nối lại khi rớt 4G)',
      consent_rc_title: 'Quyền điều khiển máy tính (Tùy chọn)',
      consent_allow_remote: 'Cho phép điều khiển chuột, bàn phím & âm lượng PC này',
      consent_allow_screen: 'Tự động chia sẻ màn hình PC độ trễ thấp',
      consent_reject: 'Từ chối',
      consent_accept: 'Đồng ý kết nối',
      pin_title: 'Yêu Cầu Mã PIN Bảo Mật',
      pin_desc: 'Thiết bị kia đang bật khóa PIN. Hãy nhập mã PIN để gửi yêu cầu kết nối:',
      pin_placeholder: 'Nhập mã PIN (4-8 ký tự)',
      pin_submit: 'Xác nhận & Gửi yêu cầu',
      rc_title_touch: 'Chuyển chế độ chạm trực tiếp hoặc rê chuột tương đối',
      rc_title_quality: 'Đổi độ phân giải & tần số quét (60Hz)',
      rc_title_fs: 'Chế độ toàn màn hình cảm ứng',
      rc_hide_keys: 'Ẩn phím',
      rc_title_hide_keys: 'Ẩn/hiện thanh phím & chuột',
      rc_hint_1: 'Vuốt để di chuột • Bật màn hình PC để chạm, vuốt & phóng to 60Hz',
      rc_hint_2: '1 ngón: Di chuột / Chạm • 2 ngón: Phóng to / Cuộn / Chuột phải',
      rc_pc_hint_1: 'Di chuột trực tiếp • Bật màn hình PC để điều khiển không cần nhấn giữ',
      rc_pc_hint_2: 'Click trái/giữa/phải, cuộn chuột & gõ bàn phím trực tiếp (hỗ trợ tiếng Việt & phím tắt)',
      rc_pc_badge: 'PC ↔ PC Trực tiếp',
      rc_view_screen: 'Xem màn hình PC (60Hz Siêu mượt)',
      rc_stop: 'Tắt',
      rc_exit_fs: '✕ Thoát toàn màn hình',
      rc_left_click: 'Chuột trái',
      rc_right_click: 'Chuột phải',
      rc_type_placeholder: 'Gõ chữ tiếng Việt gửi thẳng sang PC...',
      rc_type_btn: 'Gõ phím',
      toast_lang_changed: 'Đã chuyển ngôn ngữ sang Tiếng Việt',
      toast_theme_light: 'Đã bật chế độ Sáng (Lightning)',
      toast_theme_dark: 'Đã bật chế độ Tối (Dark)',
      save_dir_hint_pc: 'Nhập đường dẫn hoặc bấm "Chọn..." để đổi thư mục lưu tự động trên PC.',
      save_dir_hint_web_chosen: 'File nhận trên trình duyệt sẽ ghi trực tiếp vào thư mục này (khi trình duyệt cho phép).',
      save_dir_hint_web_pick: 'Bấm "Chọn..." để chọn thư mục lưu thẳng trên máy (Chrome/Edge), hoặc dùng Downloads mặc định.',
      save_dir_hint_web_auto: 'Trình duyệt hiện tại tự động lưu vào thư mục Downloads mặc định.',
      save_dir_selected_prefix: '[Thư mục đã chọn]',
      status_opening: 'Đang mở...',
      status_waiting: 'Đang chờ kết nối',
      status_connecting: 'Đang kết nối...',
      status_connected: 'Đã kết nối P2P',
      status_connected_relay: 'Đã kết nối E2EE Relay (4G)',
      status_disconnected: 'Mất kết nối',
      status_signaling_lost: 'Mất kết nối Signaling'
    },
    en: {
      page_title: 'SyloBeam — High-Speed P2P File Transfer & 60Hz Remote Control',
      header_code: 'Code',
      header_download_app: 'Get App',
      header_copy_link: 'Copy Link',
      header_show_qr: 'Show QR',
      header_share: 'Share',
      header_install_pwa: 'Install App',
      title_copy_id: 'Copy device code',
      title_regen_id: 'Generate new room code',
      title_download_app: 'Download SyloBeam Windows Installer (.EXE)',
      title_copy_link: 'Copy instant pairing link',
      title_show_qr: 'Show quick pairing QR code',
      title_share: 'Share pairing link',
      title_install_pwa: 'Install web app',
      title_toggle_theme: 'Switch Lightning (Light) / Dark theme',
      title_transfers: 'File transfer history',
      title_settings: 'Language, Theme, Save Folder & 4G Network Settings',
      hero_head_left: 'INSTANT',
      hero_head_right: 'CONNECT',
      hero_sub_pre: 'Scan QR or enter code',
      hero_sub_post: 'to transfer files & control PC.',
      input_room_placeholder: 'Enter device code...',
      btn_connect: 'Connect',
      auto_reconnecting: 'Reconnecting automatically...',
      btn_cancel: 'Cancel',
      recent_devices: 'Recent devices',
      auto_reconnect: 'Auto-reconnect on drop',
      btn_clear: 'Clear',
      tap_to_send: 'Tap to send',
      host_remote_active: 'PC remote control active',
      btn_revoke: 'Revoke',
      host_gpu_req_pre: 'Phone requests enabling',
      btn_enable_now: 'Enable now',
      btn_close: 'Close',
      btn_send_files: 'Send Files / Photos',
      btn_send_text: 'Send Text / Link',
      btn_remote_pc: 'Control PC',
      btn_screen_share: 'Share Screen',
      btn_disconnect: 'Disconnect',
      drawer_title: 'P2P Transfers',
      drawer_auto_download: 'Auto download',
      drawer_open_folder: 'Open folder',
      drawer_clear_history: 'Clear history',
      drawer_empty: 'No file transfers yet. Tap a connected device on Radar to send files.',
      footer_your_device: 'Your device:',
      footer_settings_link: '4G & Security Settings',
      footer_e2ee_summary: 'End-to-End Encrypted (DTLS / AES-256-GCM) • Auto 4G/5G Relay • SHA-256 Verified',
      qr_title: 'Scan QR to Connect',
      qr_your_room: 'Your device code',
      qr_localhost_warn: 'Running on localhost. Link & QR automatically switched to your LAN IP so mobile browsers can connect.',
      qr_share_url_label: 'Share base URL (Avoids localhost issues on mobile)',
      qr_share_url_placeholder: 'https://... or http://192.168.1.x:8123',
      qr_copy_btn: 'Copy Instant Pairing Link',
      text_modal_title: 'Quick Send Text / URL',
      text_modal_placeholder: 'Paste a URL or text message to send...',
      btn_send_now: 'Send now',
      recv_text_title: 'Received Message / Link',
      btn_copy_content: 'Copy text',
      settings_title: 'Settings & WebRTC Network (STUN / TURN 4G)',
      settings_subtitle: 'Ensure 100% transfer & remote reliability over 4G/5G mobile networks',
      settings_lang_title: 'Language',
      settings_lang_desc: 'Switch application display language',
      settings_theme_title: 'Appearance',
      settings_theme_desc: 'Quickly switch between Dark and Lightning Light mode',
      settings_savedir_title: 'Download Save Folder',
      btn_default: 'Default',
      settings_savedir_placeholder: 'Default Downloads folder',
      btn_choose: 'Browse...',
      settings_stun_title: 'Default STUN Servers (Always enabled):',
      settings_turn_enable: 'Enable TURN Server (Open Relay / Metered / Cloudflare)',
      settings_turn_desc: 'Used when devices are on strict 4G/5G Symmetric NAT networks',
      settings_json_summary: 'Quick paste iceServers JSON array from Metered Dashboard',
      settings_json_btn: 'Extract from JSON',
      settings_pin_label: 'Optional Security PIN (4–8 chars)',
      settings_pin_placeholder: 'Leave blank to use Approve button only',
      settings_pin_desc: 'When set, incoming peers must enter this PIN before your approval prompt.',
      btn_reset_default: 'Reset defaults',
      btn_save_settings: 'Save settings',
      consent_title: 'P2P Connection Request',
      consent_wants_pair: 'wants to pair directly for file transfer.',
      consent_sas_title: 'Security Verification Code (SAS)',
      consent_sas_desc: 'Verify this code matches the other screen to prevent MITM eavesdropping.',
      consent_pin_label: 'Confirm your Security PIN (if required):',
      consent_pin_placeholder: 'Enter security PIN...',
      consent_trust: 'Trust this device for this session (Auto-reconnect on 4G drop)',
      consent_rc_title: 'PC Remote Control Permission (Optional)',
      consent_allow_remote: 'Allow controlling mouse, keyboard & system volume on this PC',
      consent_allow_screen: 'Auto-start low-latency PC screen streaming',
      consent_reject: 'Decline',
      consent_accept: 'Approve connection',
      pin_title: 'Security PIN Required',
      pin_desc: 'The remote device has PIN lock enabled. Enter its PIN to send a pairing request:',
      pin_placeholder: 'Enter PIN (4-8 chars)',
      pin_submit: 'Verify & Send Request',
      rc_title_touch: 'Switch between direct touch and relative trackpad mode',
      rc_title_quality: 'Change resolution & refresh rate (60Hz)',
      rc_title_fs: 'Fullscreen touch remote mode',
      rc_hide_keys: 'Hide keys',
      rc_title_hide_keys: 'Show/hide keyboard & mouse bar',
      rc_hint_1: 'Swipe to move cursor • Enable PC screen for 60Hz touch, swipe & zoom',
      rc_hint_2: '1 finger: Move / Tap • 2 fingers: Pinch Zoom / Scroll / Right Click',
      rc_pc_hint_1: 'Move mouse directly • Enable PC screen for native hover control without click-hold',
      rc_pc_hint_2: 'Left/middle/right click, wheel scroll & type straight from your PC keyboard',
      rc_pc_badge: 'PC ↔ PC Native',
      rc_view_screen: 'View PC Screen (Smooth 60Hz)',
      rc_stop: 'Stop',
      rc_exit_fs: '✕ Exit Fullscreen',
      rc_left_click: 'Left Click',
      rc_right_click: 'Right Click',
      rc_type_placeholder: 'Type text directly to PC...',
      rc_type_btn: 'Send Text',
      toast_lang_changed: 'Language switched to English',
      toast_theme_light: 'Lightning Light mode enabled',
      toast_theme_dark: 'Dark mode enabled',
      save_dir_hint_pc: 'Enter a path or click "Browse..." to change the automatic PC save folder.',
      save_dir_hint_web_chosen: 'Received browser files will be saved directly to this folder (when permitted).',
      save_dir_hint_web_pick: 'Click "Browse..." to pick a local save folder (Chrome/Edge), or use default Downloads.',
      save_dir_hint_web_auto: 'Current browser automatically saves to the default Downloads folder.',
      save_dir_selected_prefix: '[Selected folder]',
      status_opening: 'Starting...',
      status_waiting: 'Waiting for peer',
      status_connecting: 'Connecting...',
      status_connected: 'P2P Connected',
      status_connected_relay: 'E2EE Relay Connected (4G)',
      status_disconnected: 'Disconnected',
      status_signaling_lost: 'Signaling Disconnected'
    }
  };

  const DEFAULT_STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  const ADJECTIVES = [
    'Arctic', 'Amber', 'Cosmic', 'Silent', 'Swift', 'Lunar',
    'Nordic', 'Velvet', 'Silver', 'Crystal', 'Solar', 'Zen'
  ];
  const ANIMALS = [
    'Falcon', 'Fox', 'Panda', 'Lynx', 'Dolphin', 'Heron',
    'Otter', 'Raven', 'Wolf', 'Koala', 'Tiger', 'Owl'
  ];

  // ============================================================================
  // 2. APPLICATION STATE
  // ============================================================================
  const state = {
    myRoomId: '',
    useSessionRoomFallback: false,
    myProfile: null,
    peer: null,
    activeConn: null,
    remoteRoomId: '',
    remoteProfile: null,

    // Connection & Consent Security State
    isConnecting: false,
    isInitiator: false,
    isPeerAuthorized: false,
    sessionNonce: '',
    activeSasCode: '',
    pendingPinChallenge: null,
    pendingConsent: null,
    consentCountdownTimer: null,
    trustedPeers: new Map(), // Peers we approved with trust checkbox in this session (roomId -> token)
    savedTrustTokens: new Map(), // Trust tokens given to us by remote peers for seamless 4G auto-reconnect

    // Persistent Auto-Reconnect & Hybrid Relay State
    manualDisconnect: false,
    lastConnectedPeerId: '',
    autoReconnectTimer: null,
    autoReconnectAttempt: 0,
    isCellularOrRelay: false,
    inboxWs: null,
    inboxPingTimer: null,
    inboxReconnectTimer: null,
    fallbackTriggeredForPeer: '',
    lastToastText: '',
    lastToastTime: 0,

    // Remote Control & Low-Latency Screen Sharing State
    controlConn: null, // Unordered UDP-style PeerJS DataChannel for <15ms mouse/key events
    videoFrameConn: null, // Reliable raw-binary DataChannel with backpressure dropping
    rcUdpFrameSeq: 0,
    rcUdpAssembler: null,
    rcUdpAssemblers: new Map(), // Multi-slot frameId -> { frameId, totalChunks, received, chunks, totalBytes, ts }
    remoteControlGrantedToPeer: false, // Host granted remote PC control to connected phone
    screenShareGrantedToPeer: false, // Host granted screen share to connected phone
    remoteControlAllowedByHost: false, // Phone received remote control permission from PC
    screenShareAllowedByHost: false, // Phone received screen share permission from PC
    localScreenStream: null,
    localScreenController: null,
    activeMediaCall: null,
    rcDragActive: false,
    rcSwipeDragMode: false, // false = 'Vuốt: Di chuột' (cursor glides under finger), true = 'Vuốt: Kéo thả' (1-finger direct touch drag)
    rcTouchMode: 'direct', // 'direct' (touchscreen on video) | 'trackpad' (relative)
    rcScreenQuality: 'hd60', // 'hd60' (900p 60Hz) | 'turbo' (720p 60Hz) | 'fhd60' (1080p 60Hz) | 'ultra' (2K)
    rcControlsCollapsed: false,
    rcFullscreen: false,
    rcZoom: { scale: 1, tx: 0, ty: 0 },
    rcVideoActive: false,
    rcRemoteMode: 'video',
    rcCanvasActive: false,
    rcCanvasPendingFrame: null,
    rcCanvasFrameQueue: [],
    rcCanvasDecoding: false,
    rcCanvasFrameCount: 0,
    rcCanvasBytesSum: 0,
    rcLastFrameBytes: 0,
    rcLastFrameFlags: 0,
    rcUserTouching: false,
    rcStatsTimer: null,

    // Reliable Serialized Multi-File Download Queue
    downloadQueue: [],
    isProcessingDownloads: false,
    autoDownloadBatchCount: 0,
    autoDownloadBatchTimer: null,

    pendingAutoJoinId: null,
    qrCodeInstance: null,
    shareBaseUrl: '',
    heartbeatTimer: null,
    deferredPwaPrompt: null,
    sendQueue: [],
    isSending: false,
    currentOutgoingId: null,
    incomingTransfers: new Map(),
    transferRecords: new Map(),
    theme: 'dark',
    lang: 'vi',
    desktopSaveDir: '',
    desktopDefaultSaveDir: '',
    webSaveDirHandle: null,
    earthTimer: null
  };

  // ============================================================================
  // 3. DOM ELEMENTS
  // ============================================================================
  const dom = {
    statusPill: document.getElementById('connection-status-pill'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    iceModeSummary: document.getElementById('ice-mode-summary'),

    myRoomId: document.getElementById('my-room-id'),
    hintRoomCode: document.getElementById('hint-room-code'),
    qrModalRoomId: document.getElementById('qr-modal-room-id'),
    btnCopyId: document.getElementById('btn-copy-id'),
    btnRegenerateId: document.getElementById('btn-regenerate-id'),

    btnOpenJoinModal: document.getElementById('btn-open-join-modal'),
    btnOpenQrModal: document.getElementById('btn-open-qr-modal'),
    btnShowQrInline: document.getElementById('btn-show-qr-inline'),
    btnToggleTransfers: document.getElementById('btn-toggle-transfers'),
    transferCountBadge: document.getElementById('transfer-count-badge'),
    btnInstallPwa: document.getElementById('btn-install-pwa'),
    btnToggleTheme: document.getElementById('btn-toggle-theme'),
    iconThemeSun: document.getElementById('icon-theme-sun'),
    iconThemeMoon: document.getElementById('icon-theme-moon'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    realtimeEarthCanvas: document.getElementById('realtime-earth-canvas'),
    turnActiveIndicator: document.getElementById('turn-active-indicator'),

    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    radarEmptyState: document.getElementById('radar-empty-state'),
    connectForm: document.getElementById('connect-form'),
    remoteRoomInput: document.getElementById('remote-room-input'),
    btnConnectPeer: document.getElementById('btn-connect-peer'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    btnNativeShare: document.getElementById('btn-native-share'),

    autoReconnectBanner: document.getElementById('auto-reconnect-banner'),
    autoReconnectText: document.getElementById('auto-reconnect-text'),
    btnCancelReconnect: document.getElementById('btn-cancel-reconnect'),
    recentPeersBox: document.getElementById('recent-peers-box'),
    recentPeersList: document.getElementById('recent-peers-list'),
    toggleAutoReconnect: document.getElementById('toggle-auto-reconnect'),
    btnClearRecentPeers: document.getElementById('btn-clear-recent-peers'),

    activePeerBox: document.getElementById('active-peer-box'),
    btnPeerAvatarSend: document.getElementById('btn-peer-avatar-send'),
    peerProgressRing: document.getElementById('peer-progress-ring'),
    peerDeviceIcon: document.getElementById('peer-device-icon'),
    peerRingPercent: document.getElementById('peer-ring-percent'),
    connectedPeerName: document.getElementById('connected-peer-name'),
    connectedPeerLabel: document.getElementById('connected-peer-label'),
    connectionRouteInfo: document.getElementById('connection-route-info'),
    securitySasBadge: document.getElementById('security-sas-badge'),
    activeSasCode: document.getElementById('active-sas-code'),
    hostRemoteBanner: document.getElementById('host-remote-banner'),
    btnRevokeRemoteControl: document.getElementById('btn-revoke-remote-control'),
    hostGpuRequestBanner: document.getElementById('host-gpu-request-banner'),
    btnAcceptGpu60hz: document.getElementById('btn-accept-gpu-60hz'),
    btnDismissGpu60hz: document.getElementById('btn-dismiss-gpu-60hz'),
    btnTriggerFileSelect: document.getElementById('btn-trigger-file-select'),
    btnOpenTextModal: document.getElementById('btn-open-text-modal'),
    btnOpenRemoteControl: document.getElementById('btn-open-remote-control'),
    btnToggleScreenShare: document.getElementById('btn-toggle-screen-share'),
    btnScreenShareLabel: document.getElementById('btn-screen-share-label'),
    btnDisconnectPeer: document.getElementById('btn-disconnect-peer'),

    transfersDrawer: document.getElementById('transfers-drawer'),
    btnCloseTransfers: document.getElementById('btn-close-transfers'),
    toggleAutoDownload: document.getElementById('toggle-auto-download'),
    btnDownloadAll: document.getElementById('btn-download-all'),
    btnOpenDownloads: document.getElementById('btn-open-downloads'),
    btnClearCompleted: document.getElementById('btn-clear-completed'),
    transfersEmptyState: document.getElementById('transfers-empty-state'),
    transfersList: document.getElementById('transfers-list'),

    myDeviceDisplayName: document.getElementById('my-device-display-name'),
    desktopHwBadge: document.getElementById('desktop-hw-badge'),
    btnDownloadWindowsApp: document.getElementById('btn-download-windows-app'),
    btnConfigureTurnInline: document.getElementById('btn-configure-turn-inline'),

    qrModal: document.getElementById('qr-modal'),
    btnCloseQrModal: document.getElementById('btn-close-qr-modal'),
    qrContainer: document.getElementById('qrcode-container'),
    localhostWarningBanner: document.getElementById('localhost-warning-banner'),
    shareBaseUrlInput: document.getElementById('share-base-url-input'),
    btnCopyLinkModal: document.getElementById('btn-copy-link-modal'),

    textModal: document.getElementById('text-modal'),
    btnCloseTextModal: document.getElementById('btn-close-text-modal'),
    btnCancelText: document.getElementById('btn-cancel-text'),
    sendTextForm: document.getElementById('send-text-form'),
    textMessageInput: document.getElementById('text-message-input'),

    receivedTextModal: document.getElementById('received-text-modal'),
    btnCloseReceivedText: document.getElementById('btn-close-received-text'),
    receivedTextContent: document.getElementById('received-text-content'),
    btnCopyReceivedText: document.getElementById('btn-copy-received-text'),

    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnCancelSettings: document.getElementById('btn-cancel-settings'),
    turnSettingsForm: document.getElementById('turn-settings-form'),
    btnThemeDark: document.getElementById('btn-theme-dark'),
    btnThemeLight: document.getElementById('btn-theme-light'),
    btnLangVi: document.getElementById('btn-lang-vi'),
    btnLangEn: document.getElementById('btn-lang-en'),
    saveDirSection: document.getElementById('save-dir-section'),
    saveDirInput: document.getElementById('save-dir-input'),
    btnChooseSaveDir: document.getElementById('btn-choose-save-dir'),
    btnResetSaveDir: document.getElementById('btn-reset-save-dir'),
    saveDirHint: document.getElementById('save-dir-hint'),
    turnEnabled: document.getElementById('turn-enabled'),
    turnUrl: document.getElementById('turn-url'),
    turnUsername: document.getElementById('turn-username'),
    turnCredential: document.getElementById('turn-credential'),
    turnJsonPaste: document.getElementById('turn-json-paste'),
    btnParseTurnJson: document.getElementById('btn-parse-turn-json'),
    securityPinInput: document.getElementById('security-pin-input'),
    btnResetTurn: document.getElementById('btn-reset-turn'),

    consentModal: document.getElementById('consent-modal'),
    consentCountdown: document.getElementById('consent-countdown'),
    consentPeerName: document.getElementById('consent-peer-name'),
    consentPeerId: document.getElementById('consent-peer-id'),
    consentSasCode: document.getElementById('consent-sas-code'),
    consentPinWrapper: document.getElementById('consent-pin-wrapper'),
    consentPinInput: document.getElementById('consent-pin-input'),
    consentTrustCheckbox: document.getElementById('consent-trust-checkbox'),
    consentRemoteControlBox: document.getElementById('consent-remote-control-box'),
    consentAllowRemoteCheckbox: document.getElementById('consent-allow-remote-checkbox'),
    consentAllowScreenCheckbox: document.getElementById('consent-allow-screen-checkbox'),
    btnRejectConsent: document.getElementById('btn-reject-consent'),
    btnAcceptConsent: document.getElementById('btn-accept-consent'),

    remoteControlModal: document.getElementById('remote-control-modal'),
    rcTopHeader: document.getElementById('rc-top-header'),
    rcWorkspaceWrap: document.getElementById('rc-workspace-wrap'),
    rcPeerTitle: document.getElementById('rc-peer-title'),
    rcChannelBadge: document.getElementById('rc-channel-badge'),
    rcTouchModeBtn: document.getElementById('rc-touch-mode-btn'),
    rcQualityBtn: document.getElementById('rc-quality-btn'),
    rcFullscreenBtn: document.getElementById('rc-fullscreen-btn'),
    rcToggleControlsBtn: document.getElementById('rc-toggle-controls-btn'),
    btnCloseRemoteControl: document.getElementById('btn-close-remote-control'),
    rcStageViewport: document.getElementById('rc-stage-viewport'),
    rcVideoTransformLayer: document.getElementById('rc-video-transform-layer'),
    rcTouchOverlay: document.getElementById('rc-touch-overlay'),
    rcTouchDot: document.getElementById('rc-touch-dot'),
    rcDesktopImeTrap: document.getElementById('rc-desktop-ime-trap'),
    rcHardwareCursor: document.getElementById('rc-hardware-cursor'),
    rcControlsDock: document.getElementById('rc-controls-dock'),
    rcBtnLeftClick: document.getElementById('rc-btn-left-click'),
    rcSwipeActionBtn: document.getElementById('rc-swipe-action-btn'),
    rcBtnDragToggle: document.getElementById('rc-btn-drag-toggle'),
    rcBtnRightClick: document.getElementById('rc-btn-right-click'),
    rcTextForm: document.getElementById('rc-text-form'),
    rcTextInput: document.getElementById('rc-text-input'),
    rcScreenCanvas: document.getElementById('rc-screen-canvas'),
    rcScreenVideo: document.getElementById('rc-screen-video'),
    rcScreenPlaceholder: document.getElementById('rc-screen-placeholder'),
    rcHint1: document.getElementById('rc-hint-1'),
    rcHint2: document.getElementById('rc-hint-2'),
    rcLiveScreenHud: document.getElementById('rc-live-screen-hud'),
    rcZoomResetBtn: document.getElementById('rc-zoom-reset-btn'),
    rcBtnGpuBoost: document.getElementById('rc-btn-gpu-boost'),
    rcVideoResBadge: document.getElementById('rc-video-res-badge'),
    rcBtnRequestScreen: document.getElementById('rc-btn-request-screen'),
    rcBtnStopScreen: document.getElementById('rc-btn-stop-screen'),
    rcFsExitDock: document.getElementById('rc-fs-exit-dock'),
    rcFsSwipeBtn: document.getElementById('rc-fs-swipe-btn'),
    rcBtnExitFullscreen: document.getElementById('rc-btn-exit-fullscreen'),

    pinChallengeModal: document.getElementById('pin-challenge-modal'),
    btnClosePinChallenge: document.getElementById('btn-close-pin-challenge'),
    pinChallengeForm: document.getElementById('pin-challenge-form'),
    pinChallengeInput: document.getElementById('pin-challenge-input'),

    imagePreviewModal: document.getElementById('image-preview-modal'),
    previewModalTitle: document.getElementById('preview-modal-title'),
    previewModalImg: document.getElementById('preview-modal-img'),
    btnClosePreview: document.getElementById('btn-close-preview'),

    toastContainer: document.getElementById('toast-container')
  };

  // ============================================================================
  // 4. CRYPTOGRAPHY, INTEGRITY (SHA-256) & SECURITY HELPERS
  // ============================================================================
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  class IncrementalSha256 {
    constructor() {
      this.h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
      ]);
      this.w = new Uint32Array(64);
      this.block = new Uint8Array(64);
      this.blockLen = 0;
      this.totalBytes = 0;
    }

    update(bytes) {
      let offset = 0;
      const len = bytes.length;
      this.totalBytes += len;

      while (offset < len) {
        const take = Math.min(64 - this.blockLen, len - offset);
        this.block.set(bytes.subarray(offset, offset + take), this.blockLen);
        this.blockLen += take;
        offset += take;
        if (this.blockLen === 64) {
          this._compress(this.block);
          this.blockLen = 0;
        }
      }
    }

    _compress(chunk) {
      const w = this.w;
      for (let i = 0; i < 16; i++) {
        const j = i * 4;
        w[i] = ((chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = this.h;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ ((~e) & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      this.h[0] = (this.h[0] + a) >>> 0;
      this.h[1] = (this.h[1] + b) >>> 0;
      this.h[2] = (this.h[2] + c) >>> 0;
      this.h[3] = (this.h[3] + d) >>> 0;
      this.h[4] = (this.h[4] + e) >>> 0;
      this.h[5] = (this.h[5] + f) >>> 0;
      this.h[6] = (this.h[6] + g) >>> 0;
      this.h[7] = (this.h[7] + h) >>> 0;
    }

    digestHex() {
      const bitLen = this.totalBytes * 8;
      const pad = new Uint8Array(this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen);
      pad[0] = 0x80;
      const hi = Math.floor(bitLen / 0x100000000);
      const lo = bitLen >>> 0;
      const lenPos = pad.length - 8;
      pad[lenPos] = (hi >>> 24) & 0xff;
      pad[lenPos + 1] = (hi >>> 16) & 0xff;
      pad[lenPos + 2] = (hi >>> 8) & 0xff;
      pad[lenPos + 3] = hi & 0xff;
      pad[lenPos + 4] = (lo >>> 24) & 0xff;
      pad[lenPos + 5] = (lo >>> 16) & 0xff;
      pad[lenPos + 6] = (lo >>> 8) & 0xff;
      pad[lenPos + 7] = lo & 0xff;

      let offset = 0;
      const combined = new Uint8Array(this.blockLen + pad.length);
      combined.set(this.block.subarray(0, this.blockLen), 0);
      combined.set(pad, this.blockLen);
      while (offset < combined.length) {
        this._compress(combined.subarray(offset, offset + 64));
        offset += 64;
      }

      let hex = '';
      for (let i = 0; i < 8; i++) {
        hex += this.h[i].toString(16).padStart(8, '0');
      }
      return hex;
    }
  }

  function bytesToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    const bin = unescape(encodeURIComponent(str));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder().decode(bytes);
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }

  async function sha256HexFromText(str) {
    const bytes = utf8Encode(str);
    if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      return bytesToHex(digest);
    }
    const hasher = new IncrementalSha256();
    hasher.update(bytes);
    return hasher.digestHex();
  }

  async function computeBlobSha256(blob) {
    if (!blob) return '';
    // Use native hardware-accelerated crypto.subtle for files <= 64MB
    if (
      blob.size <= 64 * 1024 * 1024 &&
      window.crypto &&
      window.crypto.subtle &&
      typeof window.crypto.subtle.digest === 'function'
    ) {
      const buf = await blob.arrayBuffer();
      const digest = await window.crypto.subtle.digest('SHA-256', buf);
      return bytesToHex(digest);
    }

    // Stream-hash large files in 2MB slices without exhausting RAM
    const hasher = new IncrementalSha256();
    const sliceSize = 2 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += sliceSize) {
      const slice = blob.slice(offset, offset + sliceSize);
      const buf = await slice.arrayBuffer();
      hasher.update(new Uint8Array(buf));
    }
    return hasher.digestHex();
  }

  function generateRandomHex(byteCount = 12) {
    const arr = new Uint8Array(byteCount);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < byteCount; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytesToHex(arr);
  }

  async function computeSasCode(roomA, roomB, nonce) {
    const sorted = [sanitizeRoomId(roomA), sanitizeRoomId(roomB)].sort();
    const hex = await sha256HexFromText(`swiftdrop-sas:${sorted[0]}:${sorted[1]}:${nonce || ''}`);
    const num = parseInt(hex.slice(0, 8), 16) % 1000000;
    const code = String(num).padStart(6, '0');
    return `${code.slice(0, 3)} ${code.slice(3, 6)}`;
  }

  function sanitizeFileName(rawName) {
    const base = (rawName || 'file_p2p')
      .toString()
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\\/]+/g, '_')
      .replace(/^\.+/, '')
      .trim();
    return base.slice(0, 180) || 'file_p2p';
  }

  // ============================================================================
  // 5. DEVICE PROFILE, UTILITY & SHARE LINK FUNCTIONS
  // ============================================================================
  function detectDeviceProfile() {
    const ua = navigator.userAgent || '';
    let os = 'Desktop';
    let deviceType = 'desktop';

    if (/iPad|Tablet/i.test(ua)) {
      os = 'iPadOS';
      deviceType = 'tablet';
    } else if (/iPhone|iPod/i.test(ua)) {
      os = 'iOS';
      deviceType = 'mobile';
    } else if (/Android/i.test(ua)) {
      os = 'Android';
      deviceType = 'mobile';
    } else if (/Windows/i.test(ua)) {
      os = 'Windows';
    } else if (/Mac OS X|Macintosh/i.test(ua)) {
      os = 'macOS';
    } else if (/Linux/i.test(ua)) {
      os = 'Linux';
    }

    let browser = 'Browser';
    if (/Zalo/i.test(ua)) browser = 'Zalo';
    else if (/FBAN|FBAV|Messenger/i.test(ua)) browser = 'Facebook';
    else if (/Line\//i.test(ua)) browser = 'LINE';
    else if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/CriOS|Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/FxiOS|Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    let nickname = localStorage.getItem(STORAGE_KEY_NICKNAME);
    if (!nickname) {
      const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      nickname = `${adj} ${animal}`;
      try {
        localStorage.setItem(STORAGE_KEY_NICKNAME, nickname);
      } catch {
        // Ignore
      }
    }

    return {
      nickname,
      os,
      browser: IS_DESKTOP_APP ? 'Desktop App' : browser,
      deviceType,
      isDesktopApp: IS_DESKTOP_APP,
      label: IS_DESKTOP_APP ? `${nickname} (${os} • Desktop App)` : `${nickname} (${os} • ${browser})`
    };
  }

  function getDeviceSvgIcon(deviceType) {
    if (deviceType === 'mobile' || deviceType === 'tablet') {
      return `
        <svg class="w-9 h-9" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      `;
    }
    return `
      <svg class="w-9 h-9" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    `;
  }

  function updateRadarRingProgress(percent, customLabel = '') {
    if (!dom.peerProgressRing) return;
    const clamped = Math.max(0, Math.min(100, percent || 0));
    const offset = RING_CIRCUMFERENCE - (clamped / 100) * RING_CIRCUMFERENCE;
    dom.peerProgressRing.style.strokeDashoffset = String(offset);

    if (dom.peerRingPercent) {
      if (customLabel) {
        dom.peerRingPercent.textContent = customLabel;
      } else if (clamped > 0 && clamped < 100) {
        dom.peerRingPercent.textContent = `${clamped}%`;
      } else {
        dom.peerRingPercent.textContent = 'Chạm để gửi';
      }
    }
  }

  function generateRoomId(length = ROOM_ID_LENGTH) {
    let result = '';
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const array = new Uint32Array(length);
      window.crypto.getRandomValues(array);
      for (let i = 0; i < length; i++) {
        result += ROOM_ID_CHARS[array[i] % ROOM_ID_CHARS.length];
      }
      return result;
    }
    for (let i = 0; i < length; i++) {
      result += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
    }
    return result;
  }

  function sanitizeRoomId(raw) {
    if (!raw) return '';
    return raw
      .toString()
      .trim()
      .toUpperCase()
      .replace(PEER_PREFIX.toUpperCase(), '')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, ROOM_ID_LENGTH);
  }

  function toFullPeerId(roomId) {
    return `${PEER_PREFIX}${sanitizeRoomId(roomId)}`;
  }

  function extractRoomIdFromPeerId(fullPeerId) {
    if (!fullPeerId) return 'UNKNOWN';
    if (fullPeerId.startsWith(PEER_PREFIX)) {
      return fullPeerId.slice(PEER_PREFIX.length).toUpperCase();
    }
    return fullPeerId.toUpperCase();
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = bytes / Math.pow(k, i);
    return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function formatSpeed(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0.00 MB/s';
    const mbps = bytesPerSecond / (1024 * 1024);
    if (mbps >= 0.1) {
      return `${mbps.toFixed(2)} MB/s`;
    }
    const kbps = bytesPerSecond / 1024;
    return `${kbps.toFixed(1)} KB/s`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function showToast(message, type = 'info') {
    const now = Date.now();
    if (message === state.lastToastText && now - state.lastToastTime < 2200) {
      return;
    }
    state.lastToastText = message;
    state.lastToastTime = now;

    // Keep at most 2 active toasts so mobile viewport stays clean
    while (dom.toastContainer.children.length >= 2) {
      dom.toastContainer.firstElementChild.remove();
    }

    const dotColors = {
      info: 'bg-zinc-300',
      success: 'bg-emerald-400',
      warning: 'bg-amber-400',
      error: 'bg-rose-400'
    };

    const toast = document.createElement('div');
    toast.className =
      'pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-2xl min-surface shadow-2xl text-xs font-medium text-zinc-100 transition-all duration-300 max-w-full';
    toast.innerHTML = `
      <span class="w-2 h-2 rounded-full shrink-0 ${dotColors[type] || dotColors.info}"></span>
      <span class="leading-snug break-words">${escapeHtml(message)}</span>
    `;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(() => toast.remove(), 250);
    }, 3600);
  }

  function isLocalhostHost(hostname) {
    const h = (hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '0.0.0.0';
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback below
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function updateLocalhostWarningUI() {
    if (!dom.localhostWarningBanner) return;
    if (isLocalhostHost(window.location.hostname)) {
      dom.localhostWarningBanner.classList.remove('hidden');
    } else {
      dom.localhostWarningBanner.classList.add('hidden');
    }
  }

  async function detectShareBaseUrl() {
    let saved = '';
    try {
      saved = (localStorage.getItem(STORAGE_KEY_SHARE_URL) || '').trim();
    } catch {
      saved = '';
    }

    const onLocalhost = isLocalhostHost(window.location.hostname);
    updateLocalhostWarningUI();

    if (saved) {
      state.shareBaseUrl = saved;
    }

    if (onLocalhost && window.location.protocol.startsWith('http')) {
      try {
        let res = await fetch('./api/host-info', { cache: 'no-store' });
        if (!res.ok) {
          res = await fetch('./host-info.json', { cache: 'no-store' });
        }
        if (res.ok) {
          const info = await res.json();
          const detected = ((info && (info.publicUrl || info.lanUrl)) || '').trim();
          const isStaleTunnel =
            !saved ||
            isLocalhostHost((() => { try { return new URL(saved).hostname; } catch { return 'localhost'; } })()) ||
            (/\.(serveousercontent\.com|lhr\.life)$/i.test((() => { try { return new URL(saved).hostname; } catch { return ''; } })()) &&
              info &&
              ((info.publicUrl && saved !== info.publicUrl) || (!info.publicUrl && info.lanUrl)));

          if (detected && isStaleTunnel) {
            state.shareBaseUrl = detected;
          }
        }
      } catch {
        // Static production hosting without /api/host-info
      }
    }

    if (dom.shareBaseUrlInput) {
      dom.shareBaseUrlInput.value = state.shareBaseUrl || (onLocalhost ? '' : window.location.origin);
    }

    if (state.myRoomId) {
      renderRoomIdAndQR(state.myRoomId);
    }
  }

  function buildShareableLink(roomId) {
    const currentUrl = new URL(window.location.href);
    const override = (state.shareBaseUrl || '').trim();
    let targetUrl;

    if (override) {
      try {
        const parsed = new URL(override);
        const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : currentUrl.pathname;
        targetUrl = new URL(basePath, parsed.origin);
      } catch {
        targetUrl = new URL(currentUrl.origin + currentUrl.pathname);
      }
    } else {
      targetUrl = new URL(currentUrl.origin + currentUrl.pathname);
    }

    targetUrl.searchParams.set('join', roomId);
    targetUrl.hash = '';
    return targetUrl.toString();
  }

  // ============================================================================
  // 6. SETTINGS (STUN/TURN, SECURITY PIN) & RECENT PEERS STORAGE
  // ============================================================================
  function loadTurnConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_TURN);
      if (!raw) {
        return { enabled: false, urls: '', username: '', credential: '' };
      }
      const parsed = JSON.parse(raw);
      return {
        enabled: Boolean(parsed.enabled),
        urls: (parsed.urls || '').trim(),
        username: (parsed.username || '').trim(),
        credential: (parsed.credential || '').trim()
      };
    } catch {
      return { enabled: false, urls: '', username: '', credential: '' };
    }
  }

  function saveTurnConfig(config) {
    localStorage.setItem(STORAGE_KEY_TURN, JSON.stringify(config));
    updateTurnIndicatorUI();
  }

  function loadSecurityPin() {
    try {
      return (localStorage.getItem(STORAGE_KEY_SECURITY_PIN) || '').trim();
    } catch {
      return '';
    }
  }

  function saveSecurityPin(pin) {
    try {
      const cleaned = (pin || '').trim().slice(0, 8);
      if (cleaned) {
        localStorage.setItem(STORAGE_KEY_SECURITY_PIN, cleaned);
      } else {
        localStorage.removeItem(STORAGE_KEY_SECURITY_PIN);
      }
    } catch {
      // Ignore
    }
  }

  function isAutoReconnectEnabled() {
    try {
      const val = localStorage.getItem(STORAGE_KEY_AUTO_RECONNECT);
      return val === null ? true : val === 'true';
    } catch {
      return true;
    }
  }

  function setAutoReconnectEnabled(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY_AUTO_RECONNECT, enabled ? 'true' : 'false');
    } catch {
      // Ignore
    }
  }

  function loadRecentPeers() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_RECENT_PEERS);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveRecentPeer(roomId, profile) {
    const cleanId = sanitizeRoomId(roomId);
    if (!cleanId) return;
    const list = loadRecentPeers().filter((p) => p.roomId !== cleanId);
    list.unshift({
      roomId: cleanId,
      nickname: (profile && profile.nickname) || `Thiết bị ${cleanId}`,
      os: (profile && profile.os) || '',
      browser: (profile && profile.browser) || '',
      deviceType: (profile && profile.deviceType) || 'desktop',
      lastSeen: Date.now()
    });
    const trimmed = list.slice(0, MAX_RECENT_PEERS);
    try {
      localStorage.setItem(STORAGE_KEY_RECENT_PEERS, JSON.stringify(trimmed));
    } catch {
      // Ignore
    }
    renderRecentPeersUI();
  }

  function clearRecentPeers() {
    try {
      localStorage.removeItem(STORAGE_KEY_RECENT_PEERS);
    } catch {
      // Ignore
    }
    renderRecentPeersUI();
  }

  function renderRecentPeersUI() {
    if (!dom.recentPeersBox || !dom.recentPeersList) return;
    const peers = loadRecentPeers().filter((p) => p.roomId !== state.myRoomId);
    if (peers.length === 0) {
      dom.recentPeersBox.classList.add('hidden');
      dom.recentPeersList.innerHTML = '';
      return;
    }

    dom.recentPeersBox.classList.remove('hidden');
    dom.recentPeersList.innerHTML = '';

    peers.forEach((peer) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'min-button px-3 py-1.5 rounded-full text-[11px] text-zinc-300 hover:text-white flex items-center gap-1.5';
      btn.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
        <span>${escapeHtml(peer.nickname)}</span>
        <span class="font-mono text-zinc-500">(${escapeHtml(peer.roomId)})</span>
      `;
      btn.addEventListener('click', () => {
        dom.remoteRoomInput.value = peer.roomId;
        connectToRemotePeer(peer.roomId);
      });
      dom.recentPeersList.appendChild(btn);
    });
  }

  function detectCellularConnection() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return false;
    const type = (conn.type || '').toLowerCase();
    const eff = (conn.effectiveType || '').toLowerCase();
    return type === 'cellular' || eff === '3g' || eff === '2g' || eff === '4g';
  }

  function getBackpressureThresholds() {
    if (state.isCellularOrRelay || detectCellularConnection()) {
      return { max: MAX_BUFFERED_AMOUNT_4G, low: BUFFER_LOW_THRESHOLD_4G };
    }
    return { max: MAX_BUFFERED_AMOUNT_WIFI, low: BUFFER_LOW_THRESHOLD_WIFI };
  }

  function getActiveChunkSize() {
    if (state.isCellularOrRelay || detectCellularConnection()) {
      return CHUNK_SIZE_MOBILE;
    }
    return CHUNK_SIZE_LAN;
  }

  function buildIceServers() {
    const iceServers = [...DEFAULT_STUN_SERVERS];
    const turnConfig = loadTurnConfig();

    if (turnConfig.enabled && turnConfig.urls) {
      const urlList = turnConfig.urls
        .split(/[\n,]+/)
        .map((u) => u.trim())
        .filter(Boolean);

      if (urlList.length > 0) {
        const turnEntry = { urls: urlList.length === 1 ? urlList[0] : urlList };
        if (turnConfig.username) turnEntry.username = turnConfig.username;
        if (turnConfig.credential) turnEntry.credential = turnConfig.credential;
        iceServers.push(turnEntry);
      }
    }

    return iceServers;
  }

  function updateTurnIndicatorUI() {
    const cfg = loadTurnConfig();
    const isTurnActive = cfg.enabled && cfg.urls.length > 0;
    const pinActive = loadSecurityPin().length > 0;
    const pinLabel = pinActive ? ' • PIN Lock' : '';

    if (isTurnActive) {
      dom.turnActiveIndicator.classList.remove('hidden');
      dom.iceModeSummary.textContent = `STUN + TURN + E2EE 4G/5G Relay${pinLabel}`;
    } else {
      dom.turnActiveIndicator.classList.add('hidden');
      dom.iceModeSummary.textContent = `WebRTC P2P + E2EE 4G/5G Auto-Relay${pinLabel}`;
    }
  }

  // ============================================================================
  // 7. CONNECTION STATUS & QR CODE UI
  // ============================================================================
  function t(key) {
    const lang = state.lang === 'en' ? 'en' : 'vi';
    return (I18N[lang] && I18N[lang][key]) || I18N.vi[key] || key;
  }

  function translateStatusText(raw) {
    if (!raw) return raw;
    if (state.lang !== 'en') return raw;
    const exact = {
      'Đang mở...': I18N.en.status_opening,
      'Đang chờ kết nối': I18N.en.status_waiting,
      'Đang kết nối...': I18N.en.status_connecting,
      'Đã kết nối P2P': I18N.en.status_connected,
      'Đã kết nối E2EE Relay (4G)': I18N.en.status_connected_relay,
      'Mất kết nối': I18N.en.status_disconnected,
      'Mất kết nối Signaling': I18N.en.status_signaling_lost,
      'Đang tự động kết nối lại...': I18N.en.auto_reconnecting
    };
    if (exact[raw]) return exact[raw];
    if (raw.startsWith('Đang kết nối ')) return 'Connecting ' + raw.slice(13);
    if (raw.startsWith('Yêu cầu từ ')) return 'Request from ' + raw.slice(11);
    if (raw.startsWith('Đang kết nối Relay 4G')) return 'Connecting 4G Relay...';
    return raw;
  }

  function loadSavedLanguage() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_LANG);
      return saved === 'en' ? 'en' : 'vi';
    } catch {
      return 'vi';
    }
  }

  function applyLanguage(lang, { persist = true } = {}) {
    const nextLang = lang === 'en' ? 'en' : 'vi';
    state.lang = nextLang;
    document.documentElement.lang = nextLang;
    document.title = t('page_title');

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', t(key));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', t(key));
    });

    if (dom.btnLangVi) dom.btnLangVi.classList.toggle('is-active', nextLang === 'vi');
    if (dom.btnLangEn) dom.btnLangEn.classList.toggle('is-active', nextLang === 'en');

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY_LANG, nextLang);
      } catch {}
    }

    if (dom.statusText && dom.statusText.textContent) {
      const cur = dom.statusText.textContent.trim();
      const reverseVi = {
        [I18N.en.status_opening]: I18N.vi.status_opening,
        [I18N.en.status_waiting]: I18N.vi.status_waiting,
        [I18N.en.status_connecting]: I18N.vi.status_connecting,
        [I18N.en.status_connected]: I18N.vi.status_connected,
        [I18N.en.status_connected_relay]: I18N.vi.status_connected_relay,
        [I18N.en.status_disconnected]: I18N.vi.status_disconnected,
        [I18N.en.status_signaling_lost]: I18N.vi.status_signaling_lost
      };
      if (nextLang === 'en') {
        dom.statusText.textContent = translateStatusText(cur);
      } else if (reverseVi[cur]) {
        dom.statusText.textContent = reverseVi[cur];
      }
    }

    if (typeof updateDownloadAllButtonUI === 'function') updateDownloadAllButtonUI();
    if (typeof syncSaveDirModalUI === 'function') syncSaveDirModalUI();
  }

  function setConnectionStatus(status, customLabel = '') {
    const styles = {
      waiting: {
        pill: 'bg-zinc-900 text-zinc-300 border-zinc-800',
        dot: 'bg-amber-400 animate-pulse',
        text: customLabel || 'Đang chờ kết nối'
      },
      connecting: {
        pill: 'bg-zinc-900 text-zinc-200 border-zinc-700',
        dot: 'bg-white animate-ping',
        text: customLabel || 'Đang kết nối...'
      },
      connected: {
        pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
        dot: 'bg-emerald-400',
        text: customLabel || 'Đã kết nối P2P'
      },
      disconnected: {
        pill: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
        dot: 'bg-rose-400',
        text: customLabel || 'Mất kết nối'
      }
    };

    const current = styles[status] || styles.waiting;
    dom.statusPill.className = `inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 transition-all ${current.pill}`;
    dom.statusDot.className = `w-1.5 h-1.5 rounded-full shrink-0 ${current.dot}`;
    dom.statusText.textContent = translateStatusText(current.text);
  }

  function renderRoomIdAndQR(roomId) {
    dom.myRoomId.textContent = roomId;
    if (dom.hintRoomCode) dom.hintRoomCode.textContent = roomId;
    if (dom.qrModalRoomId) dom.qrModalRoomId.textContent = roomId;

    const shareUrl = buildShareableLink(roomId);
    dom.qrContainer.innerHTML = '';
    if (typeof window.QRCode === 'function') {
      state.qrCodeInstance = new window.QRCode(dom.qrContainer, {
        text: shareUrl,
        width: 140,
        height: 140,
        colorDark: '#09090b',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    }
  }

  function updateRadarStageVisibility(isConnected) {
    if (isConnected) {
      dom.radarEmptyState.classList.add('hidden');
      dom.activePeerBox.classList.remove('hidden');
      dom.activePeerBox.classList.add('flex');
    } else {
      dom.activePeerBox.classList.add('hidden');
      dom.activePeerBox.classList.remove('flex');
      dom.radarEmptyState.classList.remove('hidden');
    }
  }

  // ============================================================================
  // 8. PEERJS INITIALIZATION & SIGNALING
  // ============================================================================
  function initPeerSession(forceNewRoomId = false) {
    cleanupActiveConnection(false);
    if (state.peer) {
      try {
        state.peer.destroy();
      } catch {
        // Ignore
      }
      state.peer = null;
    }

    let savedId = null;
    try {
      savedId = sessionStorage.getItem(STORAGE_KEY_ROOM_TAB) || localStorage.getItem(STORAGE_KEY_ROOM);
    } catch {
      savedId = null;
    }

    if (forceNewRoomId || !savedId || savedId.length !== ROOM_ID_LENGTH) {
      savedId = generateRoomId();
      try {
        if (state.useSessionRoomFallback) {
          sessionStorage.setItem(STORAGE_KEY_ROOM_TAB, savedId);
        } else {
          localStorage.setItem(STORAGE_KEY_ROOM, savedId);
        }
      } catch {
        // Ignore
      }
    }

    state.myRoomId = savedId;
    renderRoomIdAndQR(state.myRoomId);
    renderRecentPeersUI();
    initRelayInbox();
    setConnectionStatus('connecting', 'Đang mở Radar...');

    const fullPeerId = toFullPeerId(state.myRoomId);
    const iceServers = buildIceServers();

    try {
      const peer = new window.Peer(fullPeerId, {
        debug: 1,
        config: {
          iceServers,
          iceCandidatePoolSize: 10
        }
      });

      state.peer = peer;

      peer.on('open', () => {
        if (!state.activeConn) {
          setConnectionStatus('waiting', 'Đang chờ kết nối');
        }
        if (state.pendingAutoJoinId) {
          const targetId = state.pendingAutoJoinId;
          state.pendingAutoJoinId = null;
          if (targetId && targetId !== state.myRoomId) {
            dom.remoteRoomInput.value = targetId;
            connectToRemotePeer(targetId);
          }
        }
      });

      peer.on('connection', (incomingConn) => {
        if (incomingConn && incomingConn.metadata && incomingConn.metadata.channel === 'rc-udp') {
          setupControlDataChannel(incomingConn);
          return;
        }
        if (incomingConn && incomingConn.metadata && incomingConn.metadata.channel === 'rc-vframe-udp') {
          setupVideoFrameDataChannel(incomingConn);
          return;
        }
        handleIncomingConnection(incomingConn);
      });

      peer.on('call', (incomingCall) => {
        handleIncomingScreenCall(incomingCall);
      });

      peer.on('disconnected', () => {
        if (!state.activeConn) {
          setConnectionStatus('disconnected', 'Mất kết nối Signaling');
        }
        setTimeout(() => {
          if (state.peer && !state.peer.destroyed && state.peer.disconnected) {
            try {
              state.peer.reconnect();
            } catch {
              // Ignore
            }
          }
        }, 2000);
      });

      peer.on('error', (err) => {
        handlePeerError(err);
      });
    } catch (err) {
      setConnectionStatus('disconnected', 'Lỗi WebRTC');
      showToast(`Không thể khởi tạo kết nối: ${err.message || err}`, 'error');
    }
  }

  function handlePeerError(err) {
    const errType = err && err.type ? err.type : '';
    if (errType === 'unavailable-id') {
      state.useSessionRoomFallback = true;
      try {
        sessionStorage.removeItem(STORAGE_KEY_ROOM_TAB);
      } catch {
        // Ignore
      }
      initPeerSession(true);
      return;
    }

    if (errType === 'peer-unavailable') {
      const targetId = state.remoteRoomId || state.lastConnectedPeerId;
      if (state.isInitiator && targetId && state.fallbackTriggeredForPeer !== targetId) {
        initiateCloudflareRelayFallback(targetId, {});
        return;
      }
      state.isConnecting = false;
      dom.btnConnectPeer.disabled = false;
      if (state.autoReconnectTimer || (!state.manualDisconnect && state.lastConnectedPeerId && isAutoReconnectEnabled())) {
        setConnectionStatus('connecting', `Đang chờ ${state.lastConnectedPeerId}...`);
      } else {
        setConnectionStatus('waiting', 'Đang chờ kết nối');
        showToast('Không tìm thấy thiết bị với Mã phòng này.', 'warning');
      }
      return;
    }

    if (errType === 'network' || errType === 'server-error' || errType === 'socket-error') {
      if (!state.activeConn) {
        setConnectionStatus('disconnected', 'Mất kết nối mạng');
      }
      return;
    }

    state.isConnecting = false;
    dom.btnConnectPeer.disabled = false;
    const rawMsg = (err && err.message) || errType || 'Lỗi không xác định';
    if (/negotiation/i.test(rawMsg)) {
      const targetId = state.remoteRoomId || state.lastConnectedPeerId;
      if (state.isInitiator && targetId && state.fallbackTriggeredForPeer !== targetId) {
        initiateCloudflareRelayFallback(targetId, {});
        return;
      }
      showToast('Mạng 4G/5G chặn kết nối trực tiếp, đang chuyển kênh dự phòng...', 'warning');
      return;
    }
    showToast(`Lỗi kết nối: ${rawMsg}`, 'error');
  }

  // ============================================================================
  // 8B. CLOUDFLARE EDGE E2EE RELAY FALLBACK (ECDH P-256 + AES-256-GCM over WSS)
  // ============================================================================
  class RelayConnectionAdapter {
    constructor(roomKey, myRoomId, remoteRoomId) {
      this.roomKey = roomKey;
      this.myRoomId = myRoomId;
      this.peer = toFullPeerId(remoteRoomId);
      this.open = false;
      this.isCloudflareRelay = true;
      this.isE2EE = false;

      this._handlers = { open: [], data: [], close: [], error: [] };
      this._opened = false;
      this._closed = false;
      this._keyPair = null;
      this._keyPairPromise = null;
      this._aesKey = null;
      this._aesResolve = null;
      this._aesReady = new Promise((resolve) => {
        this._aesResolve = resolve;
      });
      this._sendChain = Promise.resolve();
      this._recvChain = Promise.resolve();
      this._keepaliveTimer = null;

      const self = this;
      this.dataChannel = {
        get bufferedAmount() {
          return self._ws && self._ws.readyState === 1 ? self._ws.bufferedAmount : 0;
        },
        get readyState() {
          return self._ws && self._ws.readyState === 1 ? 'open' : 'closed';
        },
        addEventListener() {},
        removeEventListener() {}
      };

      const wsUrl = `${RELAY_BASE_WS}/ws/room?room=${encodeURIComponent(roomKey)}&peer=${encodeURIComponent(myRoomId)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      ws.onopen = () => {
        this._keepaliveTimer = setInterval(() => {
          if (this._ws && this._ws.readyState === 1) {
            try {
              this._ws.send('{"type":"ws-ping"}');
            } catch {}
          }
        }, 20000);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let ctrl;
          try {
            ctrl = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!ctrl || typeof ctrl !== 'object') return;
          if (ctrl.type === 'ws-pong') return;
          if (ctrl.type === 'relay-peer-ready') {
            this._startE2eeHandshake();
            return;
          }
          if (ctrl.type === 'e2ee-pubkey' && ctrl.jwk) {
            this._handleRemotePubKey(ctrl.jwk);
            return;
          }
          if (ctrl.type === 'e2ee-plain') {
            this.isE2EE = false;
            this._aesResolve(null);
            this._emitOpenOnce();
            return;
          }
          if (ctrl.type === 'relay-peer-left') {
            this._emitCloseOnce();
            return;
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const buf = event.data;
          this._recvChain = this._recvChain
            .then(() => this._decryptAndDispatch(buf))
            .catch(() => {});
        }
      };

      ws.onerror = () => {
        if (!this._closed) {
          this._emit('error', new Error('Không thể kết nối máy chủ Cloudflare E2EE Relay.'));
        }
      };

      ws.onclose = () => {
        this._emitCloseOnce();
      };
    }

    on(event, fn) {
      if (this._handlers[event]) {
        this._handlers[event].push(fn);
      }
    }

    _emit(event, arg) {
      const list = this._handlers[event] || [];
      list.forEach((fn) => {
        try {
          fn(arg);
        } catch {}
      });
    }

    _emitOpenOnce() {
      if (this._opened || this._closed) return;
      this._opened = true;
      this.open = true;
      this._emit('open');
    }

    _emitCloseOnce() {
      if (this._closed) return;
      this._closed = true;
      this.open = false;
      if (this._keepaliveTimer) {
        clearInterval(this._keepaliveTimer);
        this._keepaliveTimer = null;
      }
      this._emit('close');
    }

    _ensureKeyPair() {
      if (this._keyPairPromise) return this._keyPairPromise;
      if (!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.generateKey === 'function')) {
        this._keyPairPromise = Promise.resolve(null);
        return this._keyPairPromise;
      }
      this._keyPairPromise = window.crypto.subtle
        .generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
        .then((kp) => {
          this._keyPair = kp;
          return kp;
        })
        .catch(() => null);
      return this._keyPairPromise;
    }

    async _startE2eeHandshake() {
      const kp = await this._ensureKeyPair();
      if (!this._ws || this._ws.readyState !== 1) return;
      if (kp) {
        try {
          const jwk = await window.crypto.subtle.exportKey('jwk', kp.publicKey);
          this._ws.send(JSON.stringify({ type: 'e2ee-pubkey', jwk }));
          return;
        } catch {}
      }
      try {
        this._ws.send(JSON.stringify({ type: 'e2ee-plain' }));
      } catch {}
    }

    async _handleRemotePubKey(remoteJwk) {
      try {
        const kp = await this._ensureKeyPair();
        if (!kp) {
          this.isE2EE = false;
          this._aesResolve(null);
          this._emitOpenOnce();
          return;
        }
        const remotePub = await window.crypto.subtle.importKey(
          'jwk',
          remoteJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        const aesKey = await window.crypto.subtle.deriveKey(
          { name: 'ECDH', public: remotePub },
          kp.privateKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        this._aesKey = aesKey;
        this.isE2EE = true;
        this._aesResolve(aesKey);
        this._emitOpenOnce();
      } catch {
        this._emit('error', new Error('Lỗi thỏa thuận khóa mã hóa E2EE.'));
      }
    }

    send(packet) {
      if (!this._ws || this._ws.readyState !== 1) return;
      this._sendChain = this._sendChain
        .then(async () => {
          if (!this._ws || this._ws.readyState !== 1) return;
          let metaObj = packet;
          let binaryPayload = null;

          if (packet && (packet.type === 'file-chunk' || packet.type === 'rc-frame') && packet.data) {
            binaryPayload = packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data);
            metaObj =
              packet.type === 'file-chunk'
                ? { type: 'file-chunk', id: packet.id, index: packet.index }
                : { type: 'rc-frame', ts: packet.ts || 0 };
          }

          const metaBytes = utf8Encode(JSON.stringify(metaObj));
          const extraLen = binaryPayload ? binaryPayload.byteLength : 0;
          const plaintext = new Uint8Array(4 + metaBytes.byteLength + extraLen);
          new DataView(plaintext.buffer).setUint32(0, metaBytes.byteLength, false);
          plaintext.set(metaBytes, 4);
          if (binaryPayload) {
            plaintext.set(binaryPayload, 4 + metaBytes.byteLength);
          }

          const key = this._aesKey || (await this._aesReady);
          if (key && window.crypto && window.crypto.subtle) {
            const iv = new Uint8Array(12);
            window.crypto.getRandomValues(iv);
            const cipherBuf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
            const cipherBytes = new Uint8Array(cipherBuf);
            const wire = new Uint8Array(1 + 12 + cipherBytes.byteLength);
            wire[0] = 0xe2;
            wire.set(iv, 1);
            wire.set(cipherBytes, 13);
            if (this._ws && this._ws.readyState === 1) {
              this._ws.send(wire);
            }
          } else {
            const wire = new Uint8Array(1 + plaintext.byteLength);
            wire[0] = 0xe0;
            wire.set(plaintext, 1);
            if (this._ws && this._ws.readyState === 1) {
              this._ws.send(wire);
            }
          }
        })
        .catch(() => {});
    }

    async _decryptAndDispatch(arrayBuffer) {
      const bytes = new Uint8Array(arrayBuffer);
      if (bytes.byteLength < 5) return;

      let plainBytes;
      if (bytes[0] === 0xe2) {
        const key = this._aesKey || (await this._aesReady);
        if (!key || bytes.byteLength < 17) return;
        const iv = bytes.subarray(1, 13);
        const cipher = bytes.subarray(13);
        const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
        plainBytes = new Uint8Array(decrypted);
      } else if (bytes[0] === 0xe0) {
        plainBytes = bytes.subarray(1);
      } else {
        return;
      }

      if (plainBytes.byteLength < 4) return;
      const metaLen = new DataView(plainBytes.buffer, plainBytes.byteOffset, plainBytes.byteLength).getUint32(0, false);
      if (4 + metaLen > plainBytes.byteLength) return;

      const metaJson = utf8Decode(plainBytes.subarray(4, 4 + metaLen));
      const packet = JSON.parse(metaJson);
      if (packet && (packet.type === 'file-chunk' || packet.type === 'rc-frame')) {
        packet.data = plainBytes.slice(4 + metaLen).buffer;
      }
      this._emit('data', packet);
    }

    close() {
      const ws = this._ws;
      this._ws = null;
      this._emitCloseOnce();
      if (ws) {
        setTimeout(() => {
          try {
            ws.close(1000, 'closed');
          } catch {}
        }, 80);
      }
    }
  }

  function closeRelayInbox() {
    if (state.inboxReconnectTimer) {
      clearTimeout(state.inboxReconnectTimer);
      state.inboxReconnectTimer = null;
    }
    if (state.inboxPingTimer) {
      clearInterval(state.inboxPingTimer);
      state.inboxPingTimer = null;
    }
    if (state.inboxWs) {
      const ws = state.inboxWs;
      state.inboxWs = null;
      try {
        ws.onclose = null;
        ws.close(1000, 'reinit');
      } catch {}
    }
  }

  function initRelayInbox() {
    if (!state.myRoomId || typeof WebSocket === 'undefined') return;
    closeRelayInbox();

    const myId = state.myRoomId;
    const wsUrl = `${RELAY_BASE_WS}/ws/inbox?peer=${encodeURIComponent(myId)}`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    state.inboxWs = ws;

    ws.onopen = () => {
      state.inboxPingTimer = setInterval(() => {
        if (state.inboxWs === ws && ws.readyState === 1) {
          try {
            ws.send('{"type":"ws-ping"}');
          } catch {}
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'relay-invite' && msg.from && msg.room) {
        handleIncomingRelayInvite(sanitizeRoomId(msg.from), msg.room);
      }
    };

    ws.onclose = () => {
      if (state.inboxPingTimer) {
        clearInterval(state.inboxPingTimer);
        state.inboxPingTimer = null;
      }
      if (state.inboxWs === ws) {
        state.inboxWs = null;
        state.inboxReconnectTimer = setTimeout(() => {
          if (state.myRoomId === myId && !state.inboxWs) {
            initRelayInbox();
          }
        }, 4000);
      }
    };
  }

  function handleIncomingRelayInvite(fromRoomId, roomKey) {
    if (!fromRoomId || fromRoomId === state.myRoomId) return;
    if (state.activeConn && state.activeConn.open && state.isPeerAuthorized && state.remoteRoomId === fromRoomId) {
      return;
    }

    cleanupActiveConnection(false, false);
    state.isInitiator = false;
    state.isPeerAuthorized = false;
    state.manualDisconnect = false;
    state.isCellularOrRelay = true;
    setConnectionStatus('connecting', `Yêu cầu 4G/5G từ ${fromRoomId}...`);

    const adapter = new RelayConnectionAdapter(roomKey, state.myRoomId, fromRoomId);
    setupDataConnection(adapter, fromRoomId, { isRelay: true });
  }

  async function initiateCloudflareRelayFallback(targetRoomId, options = {}) {
    if (!targetRoomId || targetRoomId === state.myRoomId) return;
    if (state.activeConn && state.activeConn.isCloudflareRelay && state.remoteRoomId === targetRoomId) {
      return;
    }

    state.fallbackTriggeredForPeer = targetRoomId;
    cleanupActiveConnection(false, false);
    state.isConnecting = true;
    state.isInitiator = true;
    state.isPeerAuthorized = false;
    state.isCellularOrRelay = true;
    state.sessionNonce = generateRandomHex(12);
    dom.btnConnectPeer.disabled = true;

    setConnectionStatus('connecting', `Đang nối E2EE 4G/5G...`);
    showToast('Chuyển sang kênh Cloudflare E2EE xuyên 4G/5G...', 'info');

    const sortedPair = [state.myRoomId, targetRoomId].sort().join('_');
    const roomKey = `${sortedPair}_${generateRandomHex(4)}`;
    const adapter = new RelayConnectionAdapter(roomKey, state.myRoomId, targetRoomId);
    setupDataConnection(adapter, targetRoomId, { ...options, isRelay: true });

    const sendInvite = async () => {
      try {
        const res = await fetch(`${RELAY_BASE_HTTP}/api/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: targetRoomId, from: state.myRoomId, room: roomKey })
        });
        if (!res.ok) return 0;
        const json = await res.json();
        return Number(json && json.delivered) || 0;
      } catch {
        return 0;
      }
    };

    const delivered = await sendInvite();
    if (delivered === 0) {
      setTimeout(async () => {
        if (state.activeConn === adapter && !adapter.open) {
          const retryDelivered = await sendInvite();
          if (retryDelivered === 0 && state.activeConn === adapter && !adapter.open) {
            state.isConnecting = false;
            dom.btnConnectPeer.disabled = false;
            cleanupActiveConnection(false, false);
            setConnectionStatus('waiting', 'Đang chờ kết nối');
            showToast(`Không tìm thấy thiết bị ${targetRoomId} đang trực tuyến.`, 'warning');
          }
        }
      }, 1500);
    }
  }

  // ============================================================================
  // 9. P2P CONNECTION, CONSENT GATE & AUTO-RECONNECT LOOP
  // ============================================================================
  function cancelAutoReconnect() {
    if (state.autoReconnectTimer) {
      clearTimeout(state.autoReconnectTimer);
      state.autoReconnectTimer = null;
    }
    state.autoReconnectAttempt = 0;
    if (dom.autoReconnectBanner) {
      dom.autoReconnectBanner.classList.add('hidden');
    }
  }

  function scheduleAutoReconnect() {
    if (state.manualDisconnect || !state.lastConnectedPeerId || !isAutoReconnectEnabled()) {
      cancelAutoReconnect();
      return;
    }
    if (state.activeConn && state.activeConn.open) {
      cancelAutoReconnect();
      return;
    }

    if (state.autoReconnectTimer) {
      clearTimeout(state.autoReconnectTimer);
    }

    state.autoReconnectAttempt += 1;
    const targetId = state.lastConnectedPeerId;
    if (dom.autoReconnectBanner && dom.autoReconnectText) {
      dom.autoReconnectBanner.classList.remove('hidden');
      dom.autoReconnectText.textContent = `Đang tự động kết nối lại với ${targetId} (Lần ${state.autoReconnectAttempt})...`;
    }
    setConnectionStatus('connecting', `Đang nối lại với ${targetId}...`);

    state.autoReconnectTimer = setTimeout(() => {
      state.autoReconnectTimer = null;
      if (state.manualDisconnect || (state.activeConn && state.activeConn.open)) return;

      if (state.peer && !state.peer.destroyed && state.peer.disconnected) {
        try {
          state.peer.reconnect();
        } catch {
          // Ignore
        }
      }
      if (state.peer && !state.peer.destroyed && !state.peer.disconnected) {
        connectToRemotePeer(targetId, { isAutoReconnect: true });
      } else {
        initiateCloudflareRelayFallback(targetId, { isAutoReconnect: true });
      }
    }, AUTO_RECONNECT_INTERVAL_MS);
  }

  function connectToRemotePeer(rawRoomId, options = {}) {
    const targetRoomId = sanitizeRoomId(rawRoomId);
    if (!targetRoomId || targetRoomId.length < 4) {
      showToast('Vui lòng nhập Mã thiết bị hợp lệ (6 ký tự).', 'warning');
      return;
    }

    if (targetRoomId === state.myRoomId) {
      showToast('Đây là mã của chính thiết bị này.', 'warning');
      return;
    }

    if (!options.isAutoReconnect) {
      cancelAutoReconnect();
      state.manualDisconnect = false;
      state.lastConnectedPeerId = targetRoomId;
    }
    state.fallbackTriggeredForPeer = '';

    if (!state.peer || state.peer.destroyed || state.peer.disconnected) {
      initiateCloudflareRelayFallback(targetRoomId, options);
      return;
    }

    cleanupActiveConnection(false);
    state.isConnecting = true;
    state.isInitiator = true;
    state.isPeerAuthorized = false;
    state.sessionNonce = generateRandomHex(12);
    dom.btnConnectPeer.disabled = true;
    setConnectionStatus('connecting', `Đang ghép với ${targetRoomId}...`);

    const remoteFullPeerId = toFullPeerId(targetRoomId);
    const conn = state.peer.connect(remoteFullPeerId, {
      reliable: true,
      serialization: 'binary'
    });

    setupDataConnection(conn, targetRoomId, options);
  }

  function handleIncomingConnection(conn) {
    const remoteRoomId = extractRoomIdFromPeerId(conn.peer);
    if (state.activeConn && state.activeConn.open && state.activeConn !== conn) {
      if (state.isPeerAuthorized && state.remoteRoomId === remoteRoomId) {
        try {
          conn.close();
        } catch {}
        return;
      }
      cleanupActiveConnection(false);
    }
    state.isInitiator = false;
    state.isPeerAuthorized = false;
    state.manualDisconnect = false;
    setConnectionStatus('connecting', `Yêu cầu từ ${remoteRoomId}...`);
    setupDataConnection(conn, remoteRoomId, {});
  }

  function setupDataConnection(conn, remoteRoomId, options = {}) {
    state.activeConn = conn;
    state.remoteRoomId = remoteRoomId;
    state.isPeerAuthorized = false;
    const isRelay = Boolean(options.isRelay || conn.isCloudflareRelay);
    let iceDisconnectGraceTimer = null;

    const clearTimers = () => {
      clearTimeout(connectTimeout);
      if (webrtcFallbackTimer) clearTimeout(webrtcFallbackTimer);
      if (iceDisconnectGraceTimer) clearTimeout(iceDisconnectGraceTimer);
    };

    // Fast automatic fallback to Cloudflare E2EE Relay if direct WebRTC stalls on 4G/5G Symmetric NAT
    const webrtcFallbackTimer =
      !isRelay && state.isInitiator
        ? setTimeout(() => {
            if (state.activeConn === conn && !conn.open && state.fallbackTriggeredForPeer !== remoteRoomId) {
              clearTimers();
              initiateCloudflareRelayFallback(remoteRoomId, options);
            }
          }, WEBRTC_FALLBACK_TIMEOUT_MS)
        : null;

    const connectTimeout = setTimeout(() => {
      if (state.activeConn === conn && !conn.open) {
        clearTimers();
        state.isConnecting = false;
        dom.btnConnectPeer.disabled = false;
        try {
          conn.close();
        } catch {}

        if (!isRelay && state.isInitiator && state.fallbackTriggeredForPeer !== remoteRoomId) {
          initiateCloudflareRelayFallback(remoteRoomId, options);
          return;
        }

        if (!state.manualDisconnect && isAutoReconnectEnabled() && state.lastConnectedPeerId === remoteRoomId) {
          scheduleAutoReconnect();
        } else {
          setConnectionStatus('waiting', 'Đang chờ kết nối');
          showToast('Kết nối quá hạn. Hãy kiểm tra thiết bị kia còn mở web không!', 'warning');
        }
      }
    }, 18000);

    conn.on('open', () => {
      if (state.activeConn !== conn) return;
      clearTimers();
      state.isConnecting = false;
      dom.btnConnectPeer.disabled = false;

      if (conn.dataChannel) {
        try {
          const thresholds = getBackpressureThresholds();
          if (!isRelay) conn.dataChannel.binaryType = 'arraybuffer';
          conn.dataChannel.bufferedAmountLowThreshold = thresholds.low;
        } catch {}
      }

      if (state.isInitiator) {
        setConnectionStatus('connecting', `Đang chờ ${remoteRoomId} đồng ý...`);
        const reconnectToken = state.savedTrustTokens.get(remoteRoomId) || '';
        const pinHash = options.pinHash || '';
        try {
          conn.send({
            type: 'consent-request',
            profile: state.myProfile,
            roomId: state.myRoomId,
            nonce: state.sessionNonce,
            reconnectToken,
            pinHash
          });
        } catch {}
      } else {
        setConnectionStatus('connecting', `Đang xác thực ${remoteRoomId}...`);
      }
    });

    conn.on('data', (data) => {
      if (state.activeConn !== conn) return;
      handleIncomingData(data, conn);
    });

    conn.on('close', () => {
      clearTimers();
      if (state.activeConn !== conn) return;
      // If direct WebRTC closed before opening on initiator, seamlessly switch to E2EE Relay
      if (!isRelay && !state.isPeerAuthorized && state.isInitiator && state.fallbackTriggeredForPeer !== remoteRoomId && !state.manualDisconnect) {
        initiateCloudflareRelayFallback(remoteRoomId, options);
        return;
      }
      closeConsentModal();
      closePinChallengeModal();
      handleConnectionClosed('Thiết bị kia đã ngắt kết nối.');
    });

    conn.on('error', (err) => {
      clearTimers();
      if (state.activeConn !== conn) return;
      const errMsg = (err && err.message) || String(err || '');
      if (!isRelay && state.isInitiator && state.fallbackTriggeredForPeer !== remoteRoomId && !state.manualDisconnect) {
        initiateCloudflareRelayFallback(remoteRoomId, options);
        return;
      }
      if (!isRelay && !state.isInitiator && /negotiation/i.test(errMsg)) {
        // Receiver waits calmly for initiator's Cloudflare E2EE Relay invite
        setConnectionStatus('connecting', `Đang chờ ${remoteRoomId} nối qua 4G/5G...`);
        return;
      }
      showToast(`Lỗi đường truyền: ${/negotiation/i.test(errMsg) ? 'Không thể đục lỗ NAT 4G/5G' : errMsg}`, 'error');
    });

    if (!isRelay) {
      setTimeout(() => {
        if (state.activeConn !== conn) return;
        const pc = conn.peerConnection;
        if (!pc) return;
        pc.addEventListener('iceconnectionstatechange', () => {
          if (state.activeConn !== conn) return;
          const iceState = pc.iceConnectionState;

          if (iceState === 'connected' || iceState === 'completed') {
            if (iceDisconnectGraceTimer) {
              clearTimeout(iceDisconnectGraceTimer);
              iceDisconnectGraceTimer = null;
            }
            return;
          }

          if (iceState === 'disconnected') {
            // Transient 4G/5G handover: give ICE 7s grace period & trigger restartIce before dropping
            if (!iceDisconnectGraceTimer) {
              try {
                if (typeof pc.restartIce === 'function') pc.restartIce();
              } catch {}
              iceDisconnectGraceTimer = setTimeout(() => {
                iceDisconnectGraceTimer = null;
                if (state.activeConn === conn && pc.iceConnectionState === 'disconnected') {
                  handleConnectionClosed('Mất kết nối mạng 4G/5G.');
                }
              }, ICE_DISCONNECT_GRACE_MS);
            }
            return;
          }

          if (iceState === 'failed') {
            clearTimers();
            if (state.isInitiator && state.fallbackTriggeredForPeer !== remoteRoomId && !state.manualDisconnect) {
              initiateCloudflareRelayFallback(remoteRoomId, options);
            } else if (!state.isInitiator && !state.isPeerAuthorized) {
              setConnectionStatus('connecting', `Đang chuyển kênh 4G/5G...`);
            } else {
              handleConnectionClosed('Mất kết nối P2P (Chuyển mạng 4G hoặc thiết bị kia đã đóng tab).');
            }
            return;
          }

          if (iceState === 'closed') {
            clearTimers();
            handleConnectionClosed('Thiết bị kia đã ngắt kết nối.');
          }
        });
      }, 200);
    }
  }

  async function finalizeAuthorizedConnection(conn, remoteRoomId, remoteProfile, sasCode) {
    if (state.activeConn !== conn) return;

    state.isPeerAuthorized = true;
    state.manualDisconnect = false;
    state.lastConnectedPeerId = remoteRoomId;
    state.activeSasCode = sasCode || '------';
    cancelAutoReconnect();

    setConnectionStatus('connected', conn.isCloudflareRelay ? 'Đã kết nối E2EE' : 'Đã kết nối P2P');
    updateRadarStageVisibility(true);
    dom.connectedPeerLabel.textContent = remoteRoomId;
    dom.remoteRoomInput.value = remoteRoomId;
    if (dom.securitySasBadge) {
      const cipherLabel = conn.isCloudflareRelay ? 'AES-256-GCM' : 'DTLS';
      dom.securitySasBadge.innerHTML = `<span>🔒 ${cipherLabel} + SAS: <strong id="active-sas-code">${escapeHtml(state.activeSasCode)}</strong> • SHA-256 Verified</span>`;
      dom.activeSasCode = document.getElementById('active-sas-code');
    }
    updateRadarRingProgress(0);

    if (remoteProfile) {
      applyRemoteDeviceProfile(remoteProfile);
      saveRecentPeer(remoteRoomId, remoteProfile);
    } else {
      dom.connectedPeerName.textContent = `Peer ${remoteRoomId}`;
      saveRecentPeer(remoteRoomId, { nickname: `Peer ${remoteRoomId}`, os: '', browser: '', deviceType: 'desktop' });
    }

    inspectIceCandidateRoute(conn);
    startHeartbeat();
    showToast(`Đã kết nối an toàn với ${remoteRoomId} (SAS: ${state.activeSasCode})`, 'success');
  }

  function applyRemoteDeviceProfile(profile) {
    if (!profile) return;
    state.remoteProfile = profile;
    if (dom.connectedPeerName) {
      dom.connectedPeerName.textContent = `${profile.nickname || 'Thiết bị'} • ${profile.os || ''} ${profile.browser || ''}`.trim();
    }
    if (dom.peerDeviceIcon) {
      dom.peerDeviceIcon.innerHTML = getDeviceSvgIcon(profile.deviceType);
    }
  }

  async function inspectIceCandidateRoute(conn) {
    if (conn && conn.isCloudflareRelay) {
      state.isCellularOrRelay = true;
      dom.connectionRouteInfo.textContent = 'Cloudflare Edge E2EE (4G/5G) • AES-256-GCM • 64KB Chunking';
      return;
    }

    try {
      const pc = conn.peerConnection;
      if (!pc || typeof pc.getStats !== 'function') return;
      const stats = await pc.getStats();
      let activeCandidateType = '';
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          const localCandidate = stats.get(report.localCandidateId);
          if (localCandidate && localCandidate.candidateType) {
            activeCandidateType = localCandidate.candidateType;
          }
        }
      });

      state.isCellularOrRelay = activeCandidateType === 'relay' || detectCellularConnection();
      if (conn.dataChannel) {
        try {
          const thresholds = getBackpressureThresholds();
          conn.dataChannel.bufferedAmountLowThreshold = thresholds.low;
        } catch {
          // Ignore
        }
      }

      if (activeCandidateType === 'relay') {
        dom.connectionRouteInfo.textContent = 'TURN Relay (4G/5G NAT Traversal) • 64KB Chunking';
      } else if (activeCandidateType === 'srflx' || activeCandidateType === 'prflx') {
        dom.connectionRouteInfo.textContent = 'STUN Direct P2P (WAN) • 256KB High-Speed';
      } else if (activeCandidateType === 'host') {
        dom.connectionRouteInfo.textContent = 'LAN / Wi-Fi Direct P2P • 256KB Max Speed';
      }
    } catch {
      // Ignore
    }
  }

  // ============================================================================
  // 10. MANDATORY CONSENT MODAL & PIN CHALLENGE HANDLERS
  // ============================================================================
  function closeConsentModal() {
    if (state.consentCountdownTimer) {
      clearInterval(state.consentCountdownTimer);
      state.consentCountdownTimer = null;
    }
    state.pendingConsent = null;
    if (dom.consentPinInput) dom.consentPinInput.value = '';
    if (dom.consentModal) {
      dom.consentModal.classList.add('hidden');
      dom.consentModal.classList.remove('flex');
    }
  }

  function openConsentModal(pending) {
    closeConsentModal();
    state.pendingConsent = pending;

    const profile = pending.profile || {};
    dom.consentPeerName.textContent = `${profile.nickname || 'Thiết bị lạ'} (${profile.os || 'Unknown'} • ${profile.browser || 'Browser'})`;
    dom.consentPeerId.textContent = pending.remoteRoomId;
    dom.consentSasCode.textContent = pending.sasCode;
    dom.consentTrustCheckbox.checked = true;

    if (dom.consentRemoteControlBox) {
      if (IS_DESKTOP_APP) {
        dom.consentRemoteControlBox.classList.remove('hidden');
        if (dom.consentAllowRemoteCheckbox) dom.consentAllowRemoteCheckbox.checked = true;
        if (dom.consentAllowScreenCheckbox) dom.consentAllowScreenCheckbox.checked = true;
      } else {
        dom.consentRemoteControlBox.classList.add('hidden');
      }
    }

    const localPin = loadSecurityPin();
    if (localPin && !pending.pinPreVerified) {
      dom.consentPinWrapper.classList.remove('hidden');
    } else {
      dom.consentPinWrapper.classList.add('hidden');
    }

    let remaining = CONSENT_TIMEOUT_SEC;
    dom.consentCountdown.textContent = `${remaining}s`;

    dom.consentModal.classList.remove('hidden');
    dom.consentModal.classList.add('flex');

    state.consentCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (dom.consentCountdown) {
        dom.consentCountdown.textContent = `${Math.max(0, remaining)}s`;
      }
      if (remaining <= 0) {
        rejectPendingConsent('Quá thời gian 30s xác nhận đồng ý.');
      }
    }, 1000);
  }

  async function acceptPendingConsent() {
    const pending = state.pendingConsent;
    if (!pending) return;

    const localPin = loadSecurityPin();
    if (localPin && !pending.pinPreVerified) {
      const enteredPin = (dom.consentPinInput.value || '').trim();
      if (enteredPin !== localPin) {
        showToast('Mã PIN Bảo Mật không khớp!', 'error');
        return;
      }
    }

    const { conn, remoteRoomId, profile, sasCode } = pending;
    const trustChecked = Boolean(dom.consentTrustCheckbox && dom.consentTrustCheckbox.checked);
    const allowRemote = Boolean(IS_DESKTOP_APP && dom.consentAllowRemoteCheckbox && dom.consentAllowRemoteCheckbox.checked);
    const allowScreen = Boolean(IS_DESKTOP_APP && dom.consentAllowScreenCheckbox && dom.consentAllowScreenCheckbox.checked);
    let trustToken = '';
    if (trustChecked) {
      trustToken = generateRandomHex(16);
      state.trustedPeers.set(remoteRoomId, trustToken);
    }

    closeConsentModal();

    if (!conn || !conn.open) {
      showToast('Kết nối đã đóng trước khi kịp đồng ý.', 'warning');
      return;
    }

    state.remoteControlGrantedToPeer = allowRemote;
    state.screenShareGrantedToPeer = allowScreen || allowRemote;
    if (IS_DESKTOP_APP && window.swiftdropDesktop) {
      window.swiftdropDesktop.setRemoteControlAuth(allowRemote).catch(() => {});
    }

    try {
      conn.send({
        type: 'consent-response',
        approved: true,
        profile: state.myProfile,
        roomId: state.myRoomId,
        sasCode,
        trustToken,
        permissions: {
          remoteControl: allowRemote,
          screenShare: allowScreen || allowRemote
        }
      });
    } catch {
      // Ignore
    }

    await finalizeAuthorizedConnection(conn, remoteRoomId, profile, sasCode);
    syncRemoteControlUI();
    if (allowScreen) {
      startDesktopScreenShare();
    }
  }

  function rejectPendingConsent(reason = 'Thiết bị đầu kia đã từ chối kết nối.') {
    const pending = state.pendingConsent;
    closeConsentModal();
    state.manualDisconnect = true;
    cancelAutoReconnect();

    if (pending && pending.conn) {
      try {
        if (pending.conn.open) {
          pending.conn.send({
            type: 'consent-response',
            approved: false,
            reason
          });
        }
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          pending.conn.close();
        } catch {
          // Ignore
        }
      }, 250);
    }

    setConnectionStatus('waiting', 'Đang chờ kết nối');
    showToast('Đã từ chối yêu cầu kết nối.', 'info');
  }

  function closePinChallengeModal() {
    state.pendingPinChallenge = null;
    if (dom.pinChallengeInput) dom.pinChallengeInput.value = '';
    if (dom.pinChallengeModal) {
      dom.pinChallengeModal.classList.add('hidden');
      dom.pinChallengeModal.classList.remove('flex');
    }
  }

  function openPinChallengeModal(conn, remoteRoomId, nonce) {
    state.pendingPinChallenge = { conn, remoteRoomId, nonce };
    if (dom.pinChallengeInput) dom.pinChallengeInput.value = '';
    dom.pinChallengeModal.classList.remove('hidden');
    dom.pinChallengeModal.classList.add('flex');
    if (dom.pinChallengeInput) dom.pinChallengeInput.focus();
  }

  async function handleIncomingConsentRequest(packet, conn) {
    if (!conn || conn !== state.activeConn) return;
    const remoteRoomId = extractRoomIdFromPeerId(conn.peer);
    const nonce = (packet.nonce || '').toString();
    state.sessionNonce = nonce;

    const sasCode = await computeSasCode(state.myRoomId, remoteRoomId, nonce);
    const localPin = loadSecurityPin();
    const savedTrustedToken = state.trustedPeers.get(remoteRoomId);
    const isTrustedReconnect = Boolean(savedTrustedToken && packet.reconnectToken && packet.reconnectToken === savedTrustedToken);

    if (isTrustedReconnect) {
      if (IS_DESKTOP_APP) {
        state.remoteControlGrantedToPeer = true;
        state.screenShareGrantedToPeer = true;
        if (window.swiftdropDesktop) {
          window.swiftdropDesktop.setRemoteControlAuth(true).catch(() => {});
        }
      }
      try {
        conn.send({
          type: 'consent-response',
          approved: true,
          profile: state.myProfile,
          roomId: state.myRoomId,
          sasCode,
          trustToken: savedTrustedToken,
          permissions: IS_DESKTOP_APP
            ? { remoteControl: true, screenShare: true }
            : undefined
        });
      } catch {
        // Ignore
      }
      await finalizeAuthorizedConnection(conn, remoteRoomId, packet.profile, sasCode);
      syncRemoteControlUI();
      return;
    }

    let pinPreVerified = false;
    if (localPin) {
      const expectedPinHash = await sha256HexFromText(`${localPin}:${nonce}`);
      if (!packet.pinHash) {
        try {
          conn.send({ type: 'consent-pin-required', nonce, profile: state.myProfile });
        } catch {
          // Ignore
        }
        state.pendingConsent = {
          conn,
          remoteRoomId,
          profile: packet.profile,
          nonce,
          sasCode,
          pinPreVerified: false
        };
        return;
      }
      if (packet.pinHash !== expectedPinHash) {
        try {
          conn.send({
            type: 'consent-response',
            approved: false,
            reason: 'Mã PIN Bảo Mật không đúng.'
          });
        } catch {
          // Ignore
        }
        setTimeout(() => {
          try {
            conn.close();
          } catch {
            // Ignore
          }
        }, 250);
        showToast(`Đã chặn kết nối từ ${remoteRoomId} do sai mã PIN!`, 'warning');
        return;
      }
      pinPreVerified = true;
    }

    openConsentModal({
      conn,
      remoteRoomId,
      profile: packet.profile,
      nonce,
      sasCode,
      pinPreVerified
    });
    showToast(`Thiết bị ${remoteRoomId} đang xin phép kết nối...`, 'info');
  }

  async function handleIncomingPinSubmit(packet, conn) {
    if (!conn || conn !== state.activeConn) return;
    const remoteRoomId = extractRoomIdFromPeerId(conn.peer);
    const localPin = loadSecurityPin();
    const nonce = state.sessionNonce || (packet.nonce || '');
    const expectedPinHash = await sha256HexFromText(`${localPin}:${nonce}`);

    if (!localPin || packet.pinHash !== expectedPinHash) {
      try {
        conn.send({
          type: 'consent-response',
          approved: false,
          reason: 'Mã PIN Bảo Mật không đúng.'
        });
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          conn.close();
        } catch {
          // Ignore
        }
      }, 250);
      showToast(`Từ chối ${remoteRoomId} do nhập sai mã PIN.`, 'warning');
      return;
    }

    const sasCode = await computeSasCode(state.myRoomId, remoteRoomId, nonce);
    openConsentModal({
      conn,
      remoteRoomId,
      profile: packet.profile || (state.pendingConsent && state.pendingConsent.profile),
      nonce,
      sasCode,
      pinPreVerified: true
    });
  }

  async function handleIncomingConsentResponse(packet, conn) {
    if (!conn || conn !== state.activeConn) return;
    const remoteRoomId = extractRoomIdFromPeerId(conn.peer);

    if (packet.approved === true) {
      if (packet.trustToken) {
        state.savedTrustTokens.set(remoteRoomId, packet.trustToken);
      }
      const perms = packet.permissions || {};
      state.remoteControlAllowedByHost = Boolean(perms.remoteControl);
      state.screenShareAllowedByHost = Boolean(perms.screenShare || perms.remoteControl);
      if (IS_DESKTOP_APP) {
        state.remoteControlGrantedToPeer = true;
        state.screenShareGrantedToPeer = true;
        if (window.swiftdropDesktop) {
          window.swiftdropDesktop.setRemoteControlAuth(true).catch(() => {});
        }
        try {
          conn.send({
            type: 'rc-permissions',
            remoteControl: true,
            screenShare: true
          });
        } catch {}
      }
      const sasCode = await computeSasCode(state.myRoomId, remoteRoomId, state.sessionNonce);
      await finalizeAuthorizedConnection(conn, remoteRoomId, packet.profile, sasCode);
      syncRemoteControlUI();
      if (state.remoteControlAllowedByHost && !conn.isCloudflareRelay) {
        openLowLatencyControlChannel(remoteRoomId);
      }
    } else {
      state.manualDisconnect = true;
      cancelAutoReconnect();
      closePinChallengeModal();
      const reason = packet.reason || 'Thiết bị đầu kia đã từ chối kết nối.';
      cleanupActiveConnection(false);
      setConnectionStatus('waiting', 'Đang chờ kết nối');
      showToast(reason, 'warning');
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = setInterval(() => {
      if (state.activeConn && state.activeConn.open) {
        try {
          state.activeConn.send({ type: 'ping', ts: Date.now() });
        } catch {
          // Ignore
        }
      }
    }, 5000);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function cleanupActiveConnection(notifyPeer = true, isManual = false) {
    stopHeartbeat();
    closeConsentModal();
    closePinChallengeModal();
    closeRemoteControlModal();
    stopDesktopScreenShare();
    stopRemoteScreenPlayback();
    closeControlDataChannel();

    state.isPeerAuthorized = false;
    state.remoteControlGrantedToPeer = false;
    state.screenShareGrantedToPeer = false;
    state.remoteControlAllowedByHost = false;
    state.screenShareAllowedByHost = false;
    if (IS_DESKTOP_APP && window.swiftdropDesktop) {
      window.swiftdropDesktop.setRemoteControlAuth(false).catch(() => {});
    }
    syncRemoteControlUI();

    if (state.activeConn) {
      const conn = state.activeConn;
      state.activeConn = null;
      if (notifyPeer && conn.open) {
        try {
          conn.send({ type: 'peer-closing', manual: isManual });
        } catch {
          // Ignore
        }
      }
      try {
        conn.close();
      } catch {
        // Ignore
      }
    }
    state.remoteProfile = null;
    updateRadarStageVisibility(false);
    updateRadarRingProgress(0);
  }

  function handleConnectionClosed(reasonMessage, wasManualFromPeer = false) {
    const hadActive = Boolean(state.activeConn || state.isConnecting);
    if (!hadActive) return;

    const wasAuthorized = state.isPeerAuthorized;
    cleanupActiveConnection(false, false);
    state.isConnecting = false;
    dom.btnConnectPeer.disabled = false;

    if (wasManualFromPeer) {
      state.manualDisconnect = true;
      cancelAutoReconnect();
    }

    state.transferRecords.forEach((record) => {
      if (record.status === 'transferring' || record.status === 'queued') {
        record.status = 'error';
        updateTransferItemUI(record.id, {
          statusText: 'Gián đoạn do mất kết nối',
          isError: true
        });
      }
    });
    state.sendQueue = [];
    state.isSending = false;
    state.incomingTransfers.clear();

    if (!state.manualDisconnect && wasAuthorized && state.isInitiator && state.lastConnectedPeerId && isAutoReconnectEnabled()) {
      showToast('Mất kết nối tạm thời — đang tự động nối lại...', 'warning');
      scheduleAutoReconnect();
      return;
    }

    setConnectionStatus('disconnected', 'Mất kết nối');
    if (reasonMessage) {
      showToast(reasonMessage, 'warning');
    }

    setTimeout(() => {
      if (!state.activeConn && !state.autoReconnectTimer && state.peer && !state.peer.disconnected) {
        setConnectionStatus('waiting', 'Đang chờ kết nối');
      }
    }, 3000);
  }

  // ============================================================================
  // 11. FILE CHUNKING (64KB), BACKPRESSURE & SHA-256 SENDER ENGINE
  // ============================================================================
  function enqueueFilesForSending(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    if (!state.activeConn || !state.activeConn.open) {
      showToast('Hãy ghép nối với thiết bị kia trước khi gửi file!', 'warning');
      return;
    }

    if (!state.isPeerAuthorized) {
      showToast('Đang chờ thiết bị kia đồng ý kết nối!', 'warning');
      return;
    }

    dom.transfersDrawer.classList.remove('hidden');

    files.forEach((file) => {
      const transferId = `tf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const activeChunkSize = getActiveChunkSize();
      const totalChunks = Math.ceil(file.size / activeChunkSize) || 1;
      const safeName = sanitizeFileName(file.name);

      createTransferItemUI({
        id: transferId,
        name: safeName,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        direction: 'send',
        status: 'queued'
      });

      state.sendQueue.push({
        id: transferId,
        file,
        safeName,
        chunkSize: activeChunkSize,
        totalChunks
      });
    });

    processSendQueue();
  }

  async function processSendQueue() {
    if (state.isSending) return;
    state.isSending = true;

    while (state.sendQueue.length > 0) {
      if (!state.activeConn || !state.activeConn.open || !state.isPeerAuthorized) {
        break;
      }
      const task = state.sendQueue.shift();
      state.currentOutgoingId = task.id;
      try {
        await sendSingleFileChunked(task);
      } catch (err) {
        updateTransferItemUI(task.id, {
          statusText: `Lỗi: ${err.message || err}`,
          isError: true
        });
      }
      state.currentOutgoingId = null;
    }

    state.isSending = false;
    setTimeout(() => updateRadarRingProgress(0), 1200);
  }

  function waitForBufferDrain(dataChannel) {
    const { max, low } = getBackpressureThresholds();
    return new Promise((resolve, reject) => {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        reject(new Error('DataChannel đã đóng'));
        return;
      }
      if (dataChannel.bufferedAmount <= max) {
        resolve();
        return;
      }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        dataChannel.removeEventListener('bufferedamountlow', onLow);
      };

      const onLow = () => {
        if (dataChannel.bufferedAmount <= max) {
          cleanup();
          resolve();
        }
      };

      dataChannel.addEventListener('bufferedamountlow', onLow);

      const pollTimer = setInterval(() => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
          cleanup();
          reject(new Error('DataChannel bị ngắt'));
          return;
        }
        if (dataChannel.bufferedAmount <= low) {
          cleanup();
          resolve();
        }
      }, 15);
    });
  }

  async function sendSingleFileChunked(task) {
    const { id, file, safeName } = task;
    const chunkSize = task.chunkSize || getActiveChunkSize();
    const totalChunks = Math.ceil(file.size / chunkSize) || 1;
    const conn = state.activeConn;
    if (!conn || !conn.open || !state.isPeerAuthorized) {
      throw new Error('Không có kết nối P2P đã xác thực');
    }

    const record = state.transferRecords.get(id);
    if (record) record.status = 'transferring';

    updateTransferItemUI(id, {
      statusText: 'Đang tính mã kiểm tra SHA-256...'
    });
    const fileSha256 = await computeBlobSha256(file);

    if (!state.activeConn || !state.activeConn.open || !state.isPeerAuthorized) {
      throw new Error('Mất kết nối trước khi bắt đầu gửi');
    }

    conn.send({
      type: 'file-meta',
      id,
      name: safeName,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize,
      sha256: fileSha256
    });

    const startTime = performance.now();
    let lastUiUpdateTime = startTime;
    let offset = 0;
    let chunkIndex = 0;

    let senderPreviewUrl = null;
    if (file.type && file.type.startsWith('image/')) {
      senderPreviewUrl = URL.createObjectURL(file);
    }

    while (offset < file.size) {
      if (!state.activeConn || !state.activeConn.open || !state.isPeerAuthorized) {
        throw new Error('Mất kết nối khi đang truyền');
      }

      const { max } = getBackpressureThresholds();
      if (conn.dataChannel && conn.dataChannel.bufferedAmount > max) {
        await waitForBufferDrain(conn.dataChannel);
      }

      const slice = file.slice(offset, offset + chunkSize);
      const arrayBuffer = await slice.arrayBuffer();

      conn.send({
        type: 'file-chunk',
        id,
        index: chunkIndex,
        data: arrayBuffer
      });

      offset += arrayBuffer.byteLength;
      chunkIndex++;

      const now = performance.now();
      if (now - lastUiUpdateTime >= 75 || offset >= file.size) {
        const elapsedSeconds = Math.max((now - startTime) / 1000, 0.001);
        const speedBps = offset / elapsedSeconds;
        const speedFormatted = formatSpeed(speedBps);
        const percent = file.size > 0 ? Math.min(100, Math.round((offset / file.size) * 100)) : 100;

        updateRadarRingProgress(percent, `${percent}% • ${speedFormatted}`);
        updateTransferItemUI(id, {
          transferredBytes: offset,
          totalBytes: file.size,
          percent,
          speedText: speedFormatted,
          statusText: `Đang gửi mảnh ${chunkIndex}/${totalChunks}`
        });
        lastUiUpdateTime = now;
      }
    }

    conn.send({
      type: 'file-complete',
      id,
      name: safeName,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      sha256: fileSha256
    });

    const totalElapsed = Math.max((performance.now() - startTime) / 1000, 0.001);
    const avgSpeed = formatSpeed(file.size / totalElapsed);

    if (record) record.status = 'completed';
    updateRadarRingProgress(100, '100%');
    updateTransferItemUI(id, {
      transferredBytes: file.size,
      totalBytes: file.size,
      percent: 100,
      speedText: avgSpeed,
      statusText: 'Đã gửi hoàn tất • ✓ SHA-256',
      isCompleted: true,
      blobUrl: senderPreviewUrl,
      isImage: Boolean(senderPreviewUrl)
    });
  }

  // ============================================================================
  // 12. RECEIVER ENGINE: CONSENT-GATED CHUNK REASSEMBLY & SHA-256 VERIFY
  // ============================================================================
  function handleIncomingData(packet, conn) {
    if (!packet || typeof packet !== 'object') return;

    // Pre-consent control messages allowed before authorization
    switch (packet.type) {
      case 'consent-request':
        handleIncomingConsentRequest(packet, conn);
        return;

      case 'consent-pin-required':
        if (conn === state.activeConn) {
          openPinChallengeModal(conn, extractRoomIdFromPeerId(conn.peer), packet.nonce || state.sessionNonce);
        }
        return;

      case 'consent-pin-submit':
        handleIncomingPinSubmit(packet, conn);
        return;

      case 'consent-response':
        handleIncomingConsentResponse(packet, conn);
        return;

      case 'ping':
        if (conn && conn.open) {
          try {
            conn.send({ type: 'pong', ts: packet.ts });
          } catch {
            // Ignore
          }
        }
        return;

      case 'pong':
        return;

      case 'peer-closing':
        handleConnectionClosed(
          packet.manual ? 'Thiết bị kia đã chủ động ngắt kết nối.' : 'Thiết bị kia đã ngắt kết nối.',
          Boolean(packet.manual)
        );
        return;

      default:
        break;
    }

    // CRITICAL SECURITY GATE: Reject all file/text payloads until remote consent is approved!
    if (!state.isPeerAuthorized) {
      return;
    }

    switch (packet.type) {
      case 'peer-hello':
        applyRemoteDeviceProfile(packet.profile);
        break;

      case 'text-message':
        handleIncomingTextMessage(packet);
        break;

      case 'file-meta':
        handleIncomingFileMeta(packet);
        break;

      case 'file-chunk':
        handleIncomingFileChunk(packet);
        break;

      case 'file-complete':
        handleIncomingFileComplete(packet);
        break;

      case 'rc-input':
        handleIncomingRemoteControlInput(packet.cmd);
        break;

      case 'rc-permissions':
        state.remoteControlAllowedByHost = Boolean(packet.remoteControl);
        state.screenShareAllowedByHost = Boolean(packet.screenShare || packet.remoteControl);
        syncRemoteControlUI();
        if (state.remoteControlAllowedByHost && state.activeConn && !state.activeConn.isCloudflareRelay) {
          openLowLatencyControlChannel(state.remoteRoomId);
        }
        break;

      case 'rc-revoked':
        state.remoteControlAllowedByHost = false;
        state.screenShareAllowedByHost = false;
        closeRemoteControlModal();
        stopRemoteScreenPlayback();
        syncRemoteControlUI();
        showToast('Máy tính đã thu hồi quyền điều khiển từ xa.', 'warning');
        break;

      case 'rc-screen-request':
        if (state.isPeerAuthorized && (state.remoteControlGrantedToPeer || state.screenShareGrantedToPeer || IS_DESKTOP_APP)) {
          if (packet.quality) {
            state.rcScreenQuality = packet.quality;
          }
          startDesktopScreenShare(state.rcScreenQuality, { unattended: true });
        }
        break;

      case 'rc-request-gpu-60hz':
        if (state.isPeerAuthorized && (state.remoteControlGrantedToPeer || state.screenShareGrantedToPeer || IS_DESKTOP_APP)) {
          if (packet.quality) {
            state.rcScreenQuality = packet.quality;
          }
          const hasUserGesture = Boolean(navigator.userActivation && navigator.userActivation.isActive);
          if (hasUserGesture) {
            startDesktopScreenShare(state.rcScreenQuality, { unattended: false });
          } else {
            // Keep DXGI stream uninterrupted; present 1-click banner on PC for WGC getDisplayMedia() user-gesture compliance
            if (dom.hostGpuRequestBanner) {
              dom.hostGpuRequestBanner.classList.remove('hidden');
            }
            try {
              window.focus();
            } catch {}
            showToast('Điện thoại yêu cầu bật 60Hz GPU H.264 — bấm "⚡ Bật ngay" trên màn hình!', 'info');
            if (state.activeConn && state.activeConn.open) {
              try {
                state.activeConn.send({ type: 'rc-gpu-request-pending' });
              } catch {}
            }
          }
        }
        break;

      case 'rc-gpu-request-pending':
        showToast('Đã hiện nút "⚡ Bật ngay" trên PC — chạm trực tiếp vào nút đó trên màn hình này (hoặc bấm trên PC) để kích hoạt GPU H.264!', 'info');
        break;

      case 'rc-screen-quality':
        if (state.isPeerAuthorized && packet.quality) {
          state.rcScreenQuality = packet.quality;
          applyScreenQualityLive(packet.quality);
        }
        break;

      case 'rc-screen-stop':
        stopDesktopScreenShare();
        stopRemoteScreenPlayback();
        break;

      case 'rc-frame':
        handleIncomingRemoteFrame(packet);
        break;

      default:
        break;
    }
  }

  // ============================================================================
  // 12B. REMOTE PC CONTROL, LOW-LATENCY UDP CHANNEL & LIVE SCREEN SHARING
  // ============================================================================
  function syncRemoteControlUI() {
    if (dom.hostRemoteBanner) {
      if (IS_DESKTOP_APP && state.isPeerAuthorized && state.remoteControlGrantedToPeer) {
        dom.hostRemoteBanner.classList.remove('hidden');
      } else {
        dom.hostRemoteBanner.classList.add('hidden');
      }
    }
    if (dom.hostGpuRequestBanner && (!IS_DESKTOP_APP || !state.isPeerAuthorized)) {
      dom.hostGpuRequestBanner.classList.add('hidden');
    }

    if (dom.btnToggleScreenShare) {
      if (IS_DESKTOP_APP && state.isPeerAuthorized) {
        dom.btnToggleScreenShare.classList.remove('hidden');
        dom.btnToggleScreenShare.classList.add('flex');
      } else {
        dom.btnToggleScreenShare.classList.add('hidden');
        dom.btnToggleScreenShare.classList.remove('flex');
      }
    }

    if (dom.btnOpenRemoteControl) {
      if (state.isPeerAuthorized && (state.remoteControlAllowedByHost || state.screenShareAllowedByHost)) {
        dom.btnOpenRemoteControl.classList.remove('hidden');
        dom.btnOpenRemoteControl.classList.add('flex');
      } else {
        dom.btnOpenRemoteControl.classList.add('hidden');
        dom.btnOpenRemoteControl.classList.remove('flex');
      }
    }

    if (dom.rcChannelBadge) {
      if (state.controlConn && state.controlConn.open) {
        dom.rcChannelBadge.textContent = 'UDP Ultra-Low Latency';
      } else if (state.activeConn && state.activeConn.isCloudflareRelay) {
        dom.rcChannelBadge.textContent = 'E2EE 4G/5G Relay';
      } else {
        dom.rcChannelBadge.textContent = 'WebRTC Direct';
      }
    }
  }

  function closeVideoFrameDataChannel() {
    state.rcUdpAssembler = null;
    if (state.rcUdpAssemblers) state.rcUdpAssemblers.clear();
    if (state.videoFrameConn) {
      const c = state.videoFrameConn;
      state.videoFrameConn = null;
      try {
        c.close();
      } catch {}
    }
  }

  function closeControlDataChannel() {
    closeVideoFrameDataChannel();
    if (state.controlConn) {
      const c = state.controlConn;
      state.controlConn = null;
      try {
        c.close();
      } catch {}
    }
  }

  const VFRAME_SLICE_HEADER = 12; // [u32 frameId][u16 chunkIdx][u16 totalChunks][u32 tsLow32]
  const VFRAME_SLICE_PAYLOAD = 14000; // <= 14.5KB per SCTP message for 100% Chrome/Edge/iOS Safari compatibility

  function handleIncomingUdpVideoSlice(rawData) {
    if (!state.isPeerAuthorized || !rawData) return;
    let bytes;
    if (rawData instanceof ArrayBuffer) {
      bytes = new Uint8Array(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      bytes = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else {
      return;
    }
    if (bytes.byteLength <= VFRAME_SLICE_HEADER) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, VFRAME_SLICE_HEADER);
    const frameId = view.getUint32(0, true);
    const chunkIdx = view.getUint16(4, true);
    const totalChunks = view.getUint16(6, true);
    const tsLow = view.getUint32(8, true);

    if (totalChunks === 0 || totalChunks > 128 || chunkIdx >= totalChunks) return;

    // Single-slice fast path
    if (totalChunks === 1) {
      const payload = bytes.subarray(VFRAME_SLICE_HEADER);
      handleIncomingRemoteFrame({ type: 'rc-frame', ts: tsLow, data: payload, transport: 'RAW' });
      return;
    }

    const pool = state.rcUdpAssemblers || (state.rcUdpAssemblers = new Map());
    // Prune expired incomplete frames older than 3 frames behind
    for (const key of pool.keys()) {
      if (key <= frameId - 4 || pool.size > 6) {
        pool.delete(key);
      }
    }

    let asm = pool.get(frameId);
    if (!asm) {
      asm = {
        frameId,
        totalChunks,
        received: 0,
        chunks: new Array(totalChunks),
        totalBytes: 0,
        ts: tsLow
      };
      pool.set(frameId, asm);
    }

    if (!asm.chunks[chunkIdx]) {
      const sliceCopy = bytes.slice(VFRAME_SLICE_HEADER);
      asm.chunks[chunkIdx] = sliceCopy;
      asm.received += 1;
      asm.totalBytes += sliceCopy.byteLength;
    }

    if (asm.received === asm.totalChunks) {
      pool.delete(frameId);
      const full = new Uint8Array(asm.totalBytes);
      let off = 0;
      for (let i = 0; i < asm.totalChunks; i += 1) {
        const part = asm.chunks[i];
        if (!part) return;
        full.set(part, off);
        off += part.byteLength;
      }
      handleIncomingRemoteFrame({ type: 'rc-frame', ts: asm.ts, data: full, transport: 'RAW' });
    }
  }

  function setupVideoFrameDataChannel(vConn) {
    const remoteId = extractRoomIdFromPeerId(vConn.peer);
    if (!state.isPeerAuthorized || remoteId !== state.remoteRoomId) {
      try {
        vConn.close();
      } catch {}
      return;
    }

    closeVideoFrameDataChannel();
    state.videoFrameConn = vConn;

    vConn.on('data', (rawData) => {
      if (!state.isPeerAuthorized || state.videoFrameConn !== vConn) return;
      handleIncomingUdpVideoSlice(rawData);
    });

    vConn.on('close', () => {
      if (state.videoFrameConn === vConn) {
        state.videoFrameConn = null;
        state.rcUdpAssembler = null;
        if (state.rcUdpAssemblers) state.rcUdpAssemblers.clear();
      }
    });
  }

  function openLowLatencyVideoFrameChannel(remoteRoomId) {
    if (!state.peer || state.peer.destroyed || state.peer.disconnected) return;
    if (state.videoFrameConn && state.videoFrameConn.open) return;
    try {
      // reliable:true + strict sender backpressure gate prevents mid-frame slice loss on Wi-Fi / iOS Safari while keeping latest-frame drop latency!
      const vConn = state.peer.connect(toFullPeerId(remoteRoomId), {
        reliable: true,
        serialization: 'raw',
        metadata: { channel: 'rc-vframe-udp' }
      });
      setupVideoFrameDataChannel(vConn);
    } catch {
      // Fallback transparently to state.activeConn
    }
  }

  function sendUdpVideoFrameSlices(jpegBytes) {
    const vConn = state.videoFrameConn;
    if (!vConn || !vConn.open) return false;
    const dc = vConn.dataChannel;
    if (dc && dc.bufferedAmount > 384 * 1024) return true; // Backpressure guard: skip frame cleanly if socket busy (zero queue buildup)

    const totalLen = jpegBytes.byteLength;
    const totalChunks = Math.ceil(totalLen / VFRAME_SLICE_PAYLOAD);
    if (totalChunks <= 0 || totalChunks > 128) return false;

    state.rcUdpFrameSeq = (state.rcUdpFrameSeq + 1) >>> 0;
    const frameId = state.rcUdpFrameSeq || 1;
    const tsLow = Date.now() >>> 0;

    try {
      for (let i = 0; i < totalChunks; i += 1) {
        const start = i * VFRAME_SLICE_PAYLOAD;
        const end = Math.min(totalLen, start + VFRAME_SLICE_PAYLOAD);
        const sliceLen = end - start;
        const pkt = new Uint8Array(VFRAME_SLICE_HEADER + sliceLen);
        const view = new DataView(pkt.buffer);
        view.setUint32(0, frameId, true);
        view.setUint16(4, i, true);
        view.setUint16(6, totalChunks, true);
        view.setUint32(8, tsLow, true);
        pkt.set(jpegBytes.subarray(start, end), VFRAME_SLICE_HEADER);
        vConn.send(pkt.buffer);
      }
      return true;
    } catch {
      return false;
    }
  }

  function setupControlDataChannel(ctrlConn) {
    const remoteId = extractRoomIdFromPeerId(ctrlConn.peer);
    if (!state.isPeerAuthorized || remoteId !== state.remoteRoomId) {
      try {
        ctrlConn.close();
      } catch {}
      return;
    }

    closeControlDataChannel();
    state.controlConn = ctrlConn;

    ctrlConn.on('open', () => {
      syncRemoteControlUI();
    });

    ctrlConn.on('data', (packet) => {
      if (!state.isPeerAuthorized || state.controlConn !== ctrlConn) return;
      if (packet && packet.type === 'rc-input') {
        handleIncomingRemoteControlInput(packet.cmd);
      }
    });

    ctrlConn.on('close', () => {
      if (state.controlConn === ctrlConn) {
        state.controlConn = null;
        syncRemoteControlUI();
      }
    });
  }

  function openLowLatencyControlChannel(remoteRoomId) {
    if (!state.peer || state.peer.destroyed || state.peer.disconnected) return;
    openLowLatencyVideoFrameChannel(remoteRoomId);
    if (state.controlConn && state.controlConn.open) return;
    try {
      const ctrlConn = state.peer.connect(toFullPeerId(remoteRoomId), {
        reliable: false,
        serialization: 'json',
        metadata: { channel: 'rc-udp' }
      });
      setupControlDataChannel(ctrlConn);
    } catch {
      // Fallback transparently to state.activeConn
    }
  }

  function handleIncomingRemoteControlInput(cmd) {
    if (!IS_DESKTOP_APP || !window.swiftdropDesktop) return;
    if (!state.isPeerAuthorized || (!state.remoteControlGrantedToPeer && !state.screenShareGrantedToPeer)) return;
    if (!cmd || typeof cmd !== 'object') return;
    window.swiftdropDesktop.sendInput(cmd);
  }

  const SCREEN_QUALITY_PRESETS = {
    hd60: {
      label: '900p 60Hz',
      width: 1600,
      maxWidth: 1600,
      height: 900,
      maxHeight: 900,
      fps: 60,
      maxFps: 60,
      jpegQuality: 52,
      relayJpegQuality: 44,
      maxBitrate: 8_500_000,
      contentHint: 'motion',
      degradation: 'maintain-framerate'
    },
    turbo: {
      label: '720p 60Hz',
      width: 1280,
      maxWidth: 1280,
      height: 720,
      maxHeight: 720,
      fps: 60,
      maxFps: 60,
      jpegQuality: 48,
      relayJpegQuality: 40,
      maxBitrate: 5_000_000,
      contentHint: 'motion',
      degradation: 'maintain-framerate'
    },
    fhd60: {
      label: '1080p 60Hz',
      width: 1920,
      maxWidth: 1920,
      height: 1080,
      maxHeight: 1080,
      fps: 60,
      maxFps: 60,
      jpegQuality: 58,
      relayJpegQuality: 48,
      maxBitrate: 12_000_000,
      contentHint: 'motion',
      degradation: 'maintain-framerate'
    },
    ultra: {
      label: '2K 60Hz',
      width: 2560,
      maxWidth: 3840,
      height: 1440,
      maxHeight: 2160,
      fps: 60,
      maxFps: 60,
      jpegQuality: 62,
      relayJpegQuality: 52,
      maxBitrate: 16_000_000,
      contentHint: 'motion',
      degradation: 'maintain-framerate'
    }
  };

  function getQualityPreset(key) {
    return SCREEN_QUALITY_PRESETS[key] || SCREEN_QUALITY_PRESETS.hd60;
  }

  async function resolveDesktopSessionToken() {
    if (INITIAL_DESKTOP_TOKEN) return INITIAL_DESKTOP_TOKEN;
    if (window.swiftdropDesktop && typeof window.swiftdropDesktop.getSessionToken === 'function') {
      try {
        INITIAL_DESKTOP_TOKEN = (await window.swiftdropDesktop.getSessionToken()) || '';
      } catch {}
    }
    return INITIAL_DESKTOP_TOKEN;
  }

  // Tier 3 Engine: Zero-Popup Fast-UDP Raw-Binary Frame Streamer (25-45Hz UDP, adaptive quality on Relay)
  async function startDirectFrameDataChannelShare(preset) {
    const token = await resolveDesktopSessionToken();
    if (!token) {
      throw new Error('Không có token luồng màn hình Desktop');
    }

    if (state.remoteRoomId) {
      openLowLatencyVideoFrameChannel(state.remoteRoomId);
    }

    const abortCtrl = new AbortController();
    let active = true;
    const isRelay = Boolean(state.isCellularOrRelay || (state.activeConn && state.activeConn.isCloudflareRelay));
    let currentPreset = preset;

    const stopController = () => {
      if (!active) return;
      active = false;
      try {
        abortCtrl.abort();
      } catch {}
      if (window.swiftdropDesktop && typeof window.swiftdropDesktop.stopScreenStream === 'function') {
        window.swiftdropDesktop.stopScreenStream().catch(() => {});
      }
    };

    const controller = {
      stop: stopController,
      setConfig: (nextPreset) => {
        currentPreset = nextPreset;
        const targetQ = isRelay ? (nextPreset.relayJpegQuality || 46) : (nextPreset.jpegQuality || 54);
        if (window.swiftdropDesktop && typeof window.swiftdropDesktop.setScreenConfig === 'function') {
          window.swiftdropDesktop
            .setScreenConfig({
              width: nextPreset.width,
              height: nextPreset.height,
              fps: nextPreset.fps,
              quality: targetQ
            })
            .catch(() => {});
        }
      }
    };
    state.localScreenController = controller;

    const initQ = isRelay ? (preset.relayJpegQuality || 46) : (preset.jpegQuality || 54);
    const streamUrl = `/api/screen-raw?w=${encodeURIComponent(preset.width)}&h=${encodeURIComponent(preset.height)}&fps=${encodeURIComponent(preset.fps)}&q=${encodeURIComponent(initQ)}&token=${encodeURIComponent(token)}`;

    (async () => {
      try {
        const res = await fetch(streamUrl, { cache: 'no-store', signal: abortCtrl.signal });
        if (!res.ok || !res.body) {
          stopController();
          return;
        }
        const reader = res.body.getReader();
        // Reusable growing buffer (avoids O(N^2) allocation per chunk)
        let buf = new Uint8Array(512 * 1024);
        let bufLen = 0;

        while (active && state.localScreenController === controller) {
          const { done, value } = await reader.read();
          if (done || !active || state.localScreenController !== controller) break;
          if (!value || value.byteLength === 0) continue;

          if (bufLen + value.byteLength > buf.byteLength) {
            const nextCap = Math.max(buf.byteLength * 2, bufLen + value.byteLength);
            const nextBuf = new Uint8Array(nextCap);
            nextBuf.set(buf.subarray(0, bufLen), 0);
            buf = nextBuf;
          }
          buf.set(value, bufLen);
          bufLen += value.byteLength;

          // Keep ONLY newest complete JPEG frame to guarantee zero queue buildup
          let latestStart = -1;
          let latestLen = 0;
          let offset = 0;
          const view = new DataView(buf.buffer, buf.byteOffset, bufLen);
          while (bufLen - offset >= 4) {
            const frameLen = view.getUint32(offset, true);
            if (frameLen <= 0 || frameLen > 12 * 1024 * 1024) {
              offset = bufLen;
              break;
            }
            if (bufLen - offset < 4 + frameLen) break;
            latestStart = offset + 4;
            latestLen = frameLen;
            offset += 4 + frameLen;
          }

          let latestJpeg = null;
          if (latestStart >= 0 && latestLen > 0) {
            latestJpeg = buf.slice(latestStart, latestStart + latestLen);
          }

          if (offset > 0) {
            const rem = bufLen - offset;
            if (rem > 0) {
              buf.copyWithin(0, offset, bufLen);
            }
            bufLen = rem;
          }

          if (latestJpeg && state.activeConn && state.activeConn.open && state.isPeerAuthorized && !state.isSending) {
            // Fast path: Unordered raw-binary UDP DataChannel (zero Head-of-Line blocking, zero BinaryPack)
            if (state.videoFrameConn && state.videoFrameConn.open && sendUdpVideoFrameSlices(latestJpeg)) {
              continue;
            }
            // Fallback path: Reliable DataChannel / Cloudflare Relay
            const dc = state.activeConn.dataChannel;
            const maxPending = state.isCellularOrRelay || detectCellularConnection() ? 192 * 1024 : 512 * 1024;
            if (!dc || dc.bufferedAmount <= maxPending) {
              try {
                state.activeConn.send({
                  type: 'rc-frame',
                  ts: Date.now(),
                  data: latestJpeg.buffer
                });
              } catch {}
            }
          }
        }
      } catch {
        // Reader aborted cleanly
      } finally {
        stopController();
      }
    })();

    return controller;
  }

  function updateRemoteHardwareCursor(nx, ny, visible) {
    if (!dom.rcHardwareCursor || !dom.rcStageViewport) return;
    if (!visible || !state.rcVideoActive) {
      dom.rcHardwareCursor.classList.add('hidden');
      return;
    }
    const useCanvas = state.rcCanvasActive && dom.rcScreenCanvas;
    const mediaEl = useCanvas ? dom.rcScreenCanvas : dom.rcScreenVideo;
    if (!mediaEl) return;
    const rect = mediaEl.getBoundingClientRect();
    const stageRect = dom.rcStageViewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const vw = (useCanvas ? mediaEl.width : mediaEl.videoWidth) || rect.width;
    const vh = (useCanvas ? mediaEl.height : mediaEl.videoHeight) || rect.height;
    const videoRatio = vw / vh;
    const boxRatio = rect.width / rect.height;
    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRatio > boxRatio) {
      renderH = rect.width / videoRatio;
      offsetY = (rect.height - renderH) / 2;
    } else {
      renderW = rect.height * videoRatio;
      offsetX = (rect.width - renderW) / 2;
    }

    const vx = rect.left + offsetX + Math.max(0, Math.min(1, nx)) * renderW - stageRect.left;
    const vy = rect.top + offsetY + Math.max(0, Math.min(1, ny)) * renderH - stageRect.top;
    dom.rcHardwareCursor.classList.remove('hidden');
    dom.rcHardwareCursor.style.transform = `translate3d(${vx.toFixed(1)}px, ${vy.toFixed(1)}px, 0)`;
  }

  function startCanvasStatsMonitor(conn) {
    stopRemoteVideoStatsMonitor();
    state.rcCanvasFrameCount = 0;
    state.rcCanvasBytesSum = 0;
    state.rcStatsTimer = setInterval(async () => {
      if (!state.rcCanvasActive) {
        stopRemoteVideoStatsMonitor();
        return;
      }
      const fps = state.rcCanvasFrameCount;
      const bytesSum = state.rcCanvasBytesSum;
      state.rcCanvasFrameCount = 0;
      state.rcCanvasBytesSum = 0;
      const avgKb = fps > 0 ? Math.max(1, Math.round(bytesSum / fps / 1024)) : Math.max(1, Math.round((state.rcLastFrameBytes || 0) / 1024));
      const w = dom.rcScreenCanvas ? dom.rcScreenCanvas.width : 0;
      const h = dom.rcScreenCanvas ? dom.rcScreenCanvas.height : 0;
      let rttMs = 0;
      try {
        const pc =
          (state.videoFrameConn && state.videoFrameConn.peerConnection) ||
          (conn && conn.peerConnection);
        if (pc && typeof pc.getStats === 'function') {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected)) {
              if (typeof report.currentRoundTripTime === 'number' && report.currentRoundTripTime > 0) {
                rttMs = Math.round(report.currentRoundTripTime * 1000);
              }
            }
          });
        }
      } catch {}

      const rawF = state.rcLastFrameFlags || 0;
      const isDxgi = (rawF & 0x80) !== 0;
      const f = rawF & 0x7f;
      const modeTag = isDxgi
        ? f === 2
          ? 'DXGI-HD'
          : f === 4
            ? 'DXGI-60'
            : 'DXGI'
        : f === 1
          ? 'DELTA'
          : f === 2
            ? 'REST-HD'
            : f === 4
              ? 'MOTION'
              : 'GDI';
      const hzLabel = `${fps}Hz`;

      if (dom.rcVideoResBadge) {
        const parts = [];
        if (w > 0 && h > 0) parts.push(`${w}×${h}`);
        parts.push(hzLabel);
        if (rttMs > 0) parts.push(`${rttMs}ms`);
        parts.push(modeTag);
        if (avgKb > 0) parts.push(`${avgKb}KB`);
        dom.rcVideoResBadge.textContent = parts.join(' • ');
      }
    }, 1000);
  }

  function handleIncomingRemoteFrame(packet) {
    if (!packet || !packet.data || !dom.rcScreenCanvas) return;

    const bytes = packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data);
    if (bytes.byteLength < 32) return;

    if (packet.transport) {
      state.rcCanvasLastTransport = packet.transport;
    } else if (!state.rcCanvasLastTransport) {
      state.rcCanvasLastTransport = state.isCellularOrRelay ? 'Relay' : 'Direct';
    }

    let frameItem;
    const n = bytes.byteLength;
    // Detect v14 Pure JPEG + 8-byte 'SD' Trailer: [flags][cursorVis][u16 cx][u16 cy]['S','D']
    const hasTrailerSD =
      n > 40 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[n - 2] === 0x53 &&
      bytes[n - 1] === 0x44;

    // Detect legacy v13 SD02 Header (22 bytes)
    const isSD02 =
      !hasTrailerSD &&
      n > 26 &&
      bytes[0] === 0x53 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x30 &&
      bytes[3] === 0x32;

    if (hasTrailerSD) {
      const tdv = new DataView(bytes.buffer, bytes.byteOffset + n - 8, 8);
      const flags = tdv.getUint8(0);
      const cursorVis = tdv.getUint8(1);
      const cursorXNorm = tdv.getUint16(2, true);
      const cursorYNorm = tdv.getUint16(4, true);
      const jpegBytes = bytes.subarray(0, n - 8);

      state.rcLastFrameBytes = jpegBytes.byteLength;
      state.rcLastFrameFlags = flags;
      state.rcCanvasBytesSum += jpegBytes.byteLength;

      if (!state.rcUserTouching && state.rcCanvasActive) {
        updateRemoteHardwareCursor(cursorXNorm / 65535, cursorYNorm / 65535, cursorVis === 1);
      }

      frameItem = { fullW: 0, fullH: 0, rectX: 0, rectY: 0, rectW: 0, rectH: 0, flags, jpegBytes };
    } else if (isSD02) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 22);
      const fullW = dv.getUint16(4, true);
      const fullH = dv.getUint16(6, true);
      const rectX = dv.getUint16(8, true);
      const rectY = dv.getUint16(10, true);
      const rectW = dv.getUint16(12, true);
      const rectH = dv.getUint16(14, true);
      const flags = dv.getUint8(16);
      const cursorVis = dv.getUint8(17);
      const cursorXNorm = dv.getUint16(18, true);
      const cursorYNorm = dv.getUint16(20, true);
      const jpegBytes = bytes.subarray(22);

      state.rcLastFrameBytes = jpegBytes.byteLength;
      state.rcLastFrameFlags = flags;
      state.rcCanvasBytesSum += jpegBytes.byteLength;

      if (!state.rcUserTouching && state.rcCanvasActive) {
        updateRemoteHardwareCursor(cursorXNorm / 65535, cursorYNorm / 65535, cursorVis === 1);
      }

      frameItem = { fullW, fullH, rectX, rectY, rectW, rectH, flags, jpegBytes };
    } else {
      state.rcLastFrameBytes = n;
      state.rcLastFrameFlags = 0;
      state.rcCanvasBytesSum += n;
      frameItem = { fullW: 0, fullH: 0, rectX: 0, rectY: 0, rectW: 0, rectH: 0, flags: 0, jpegBytes: bytes };
    }

    const wasCanvasActive = state.rcCanvasActive;
    state.rcCanvasActive = true;

    const isFull = !isSD02 || (frameItem.rectW === frameItem.fullW && frameItem.rectH === frameItem.fullH);
    if (isFull) {
      // Self-healing single-slot latest-frame replacement for zero queue buildup & instant response
      state.rcCanvasFrameQueue = [frameItem];
    } else {
      if (state.rcCanvasFrameQueue.length >= 6) {
        state.rcCanvasFrameQueue.shift();
      }
      state.rcCanvasFrameQueue.push(frameItem);
    }

    if (!wasCanvasActive) {
      updateRemoteVideoUIState(true, 'canvas');
      startCanvasStatsMonitor(state.activeConn);
      showToast('Đã kết nối luồng Raw Full-Frame — vuốt trực tiếp để di chuột!', 'success');
    }

    if (state.rcCanvasDecoding) return;

    const pumpCanvasDecoder = async () => {
      state.rcCanvasDecoding = true;
      try {
        while (state.rcCanvasFrameQueue.length > 0 && state.rcCanvasActive) {
          const item = state.rcCanvasFrameQueue.shift();
          const blob = new Blob([item.jpegBytes], { type: 'image/jpeg' });
          const bmp = await createImageBitmap(blob);
          try {
            const canvas = dom.rcScreenCanvas;
            if (canvas && state.rcCanvasActive) {
              const targetW = item.fullW > 0 ? item.fullW : bmp.width;
              const targetH = item.fullH > 0 ? item.fullH : bmp.height;
              if (canvas.width !== targetW || canvas.height !== targetH) {
                canvas.width = targetW;
                canvas.height = targetH;
              }
              const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
              if (ctx) {
                if (item.fullW > 0 && item.rectW > 0 && item.rectH > 0) {
                  ctx.drawImage(bmp, item.rectX, item.rectY, item.rectW, item.rectH);
                } else {
                  ctx.drawImage(bmp, 0, 0);
                }
                state.rcCanvasFrameCount += 1;
              }
            }
          } finally {
            bmp.close();
          }
        }
      } catch {
        // Ignore malformed transient frame
      } finally {
        state.rcCanvasDecoding = false;
        if (state.rcCanvasFrameQueue.length > 0 && state.rcCanvasActive) {
          pumpCanvasDecoder();
        }
      }
    };

    pumpCanvasDecoder();
  }

  function tuneIncomingVideoReceiver(call) {
    if (!call || !call.peerConnection) return;
    const applyZeroBuffer = () => {
      try {
        const receivers = call.peerConnection.getReceivers ? call.peerConnection.getReceivers() : [];
        for (const r of receivers) {
          if (r.track && r.track.kind === 'video') {
            if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
            if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
          }
        }
      } catch {
        // Ignore if browser doesn't expose receiver delay hints
      }
    };
    applyZeroBuffer();
    if (typeof call.peerConnection.addEventListener === 'function') {
      call.peerConnection.addEventListener('track', applyZeroBuffer);
    }
    setTimeout(applyZeroBuffer, 350);
    setTimeout(applyZeroBuffer, 1200);
  }

  function stopRemoteVideoStatsMonitor() {
    if (state.rcStatsTimer) {
      clearInterval(state.rcStatsTimer);
      state.rcStatsTimer = null;
    }
  }

  function startRemoteVideoStatsMonitor(call) {
    stopRemoteVideoStatsMonitor();
    if (!call || !call.peerConnection || typeof call.peerConnection.getStats !== 'function') return;

    state.rcStatsTimer = setInterval(async () => {
      if (!state.activeMediaCall || state.activeMediaCall !== call || !call.peerConnection) {
        stopRemoteVideoStatsMonitor();
        return;
      }
      try {
        const stats = await call.peerConnection.getStats();
        let fps = 0;
        let width = dom.rcScreenVideo ? dom.rcScreenVideo.videoWidth : 0;
        let height = dom.rcScreenVideo ? dom.rcScreenVideo.videoHeight : 0;
        let rttMs = 0;
        let codecId = '';
        let codecName = '';
        const codecsMap = new Map();

        stats.forEach((report) => {
          if (report.type === 'codec' && report.mimeType) {
            codecsMap.set(report.id, report.mimeType);
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.framesPerSecond === 'number') fps = Math.round(report.framesPerSecond);
            if (typeof report.frameWidth === 'number' && report.frameWidth > 0) width = report.frameWidth;
            if (typeof report.frameHeight === 'number' && report.frameHeight > 0) height = report.frameHeight;
            if (report.codecId) codecId = report.codecId;
          }
          if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected)) {
            if (typeof report.currentRoundTripTime === 'number' && report.currentRoundTripTime > 0) {
              rttMs = Math.round(report.currentRoundTripTime * 1000);
            }
          }
        });

        if (codecId && codecsMap.has(codecId)) {
          const mime = String(codecsMap.get(codecId));
          codecName = mime.replace(/^video\//i, '').toUpperCase();
        }

        if (dom.rcVideoResBadge) {
          const parts = [];
          if (width > 0 && height > 0) parts.push(`${width}×${height}`);
          if (fps > 0) parts.push(`${fps}Hz`);
          if (rttMs > 0) parts.push(`${rttMs}ms`);
          if (codecName) parts.push(`GPU ${codecName}`);
          dom.rcVideoResBadge.textContent = parts.length > 0 ? parts.join(' • ') : 'LIVE 60Hz';
        }
      } catch {
        // Ignore transient stats error
      }
    }, 1000);
  }

  function sendRemoteControlCmd(cmd) {
    if (!state.isPeerAuthorized || (!state.remoteControlAllowedByHost && !state.screenShareAllowedByHost && !state.rcVideoActive)) return;
    if (!cmd || typeof cmd !== 'object') return;
    const payload = { type: 'rc-input', cmd };
    // Mouse moves & live absolute finger tracking use unordered UDP channel for near-instant feel; clicks/keys/drag-edges use reliable activeConn
    const isVolatileMove =
      cmd.action === 'mouse_move' ||
      cmd.action === 'mouse_scroll' ||
      (cmd.action === 'mouse_abs' && !cmd.click && !cmd.down && !cmd.up);
    if (isVolatileMove && state.controlConn && state.controlConn.open) {
      try {
        state.controlConn.send(payload);
        return;
      } catch {}
    }
    if (state.activeConn && state.activeConn.open) {
      try {
        state.activeConn.send(payload);
      } catch {}
    }
  }

  function revokeRemoteControl(fromKillSwitch = false) {
    state.remoteControlGrantedToPeer = false;
    state.screenShareGrantedToPeer = false;
    if (IS_DESKTOP_APP && window.swiftdropDesktop) {
      window.swiftdropDesktop.setRemoteControlAuth(false).catch(() => {});
    }
    stopDesktopScreenShare();
    closeControlDataChannel();
    if (state.activeConn && state.activeConn.open) {
      try {
        state.activeConn.send({ type: 'rc-revoked' });
      } catch {}
    }
    syncRemoteControlUI();
    showToast(
      fromKillSwitch ? 'Đã kích hoạt phím tắt khẩn cấp (Ctrl+Alt+Esc): Ngắt điều khiển PC!' : 'Đã thu hồi quyền điều khiển máy tính.',
      'warning'
    );
  }

  async function tuneVideoSenderQuality(call, preset) {
    if (!call || !call.peerConnection || typeof call.peerConnection.getSenders !== 'function') return;
    try {
      const senders = call.peerConnection.getSenders();
      for (const sender of senders) {
        if (!sender.track || sender.track.kind !== 'video') continue;
        if ('contentHint' in sender.track) {
          sender.track.contentHint = preset.contentHint;
        }
        const params = sender.getParameters ? sender.getParameters() : null;
        if (!params) continue;
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const trackSettings = sender.track.getSettings ? sender.track.getSettings() : {};
        const srcW = Number(trackSettings.width) || 0;
        // Force SIMD downscale before encoding whenever Windows capture returns native 2560px > preset target!
        const downscale = srcW > preset.width + 64 ? Number((srcW / preset.width).toFixed(2)) : 1;
        params.encodings[0].maxBitrate = preset.maxBitrate;
        params.encodings[0].maxFramerate = preset.maxFps;
        params.encodings[0].scaleResolutionDownBy = Math.max(1, downscale);
        params.degradationPreference = preset.degradation;
        await sender.setParameters(params);
      }
    } catch {
      // Some WebRTC engines restrict individual fields; ignore gracefully
    }
  }

  async function captureDesktopStream(preset) {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: preset.fps, min: 30, max: preset.maxFps },
        width: { ideal: preset.width, max: preset.maxWidth },
        height: { ideal: preset.height, max: preset.maxHeight },
        cursor: 'always'
      },
      audio: false
    });
  }

  async function applyScreenQualityLive(qualityKey) {
    const preset = getQualityPreset(qualityKey);
    if (state.localScreenController) {
      state.localScreenController.setConfig(preset);
      return;
    }
    if (!state.localScreenStream) return;
    if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.setScreenConfig === 'function') {
      window.swiftdropDesktop
        .setScreenConfig({
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          quality: preset.jpegQuality || 76
        })
        .catch(() => {});
    }
    const videoTrack = state.localScreenStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        if ('contentHint' in videoTrack) {
          videoTrack.contentHint = preset.contentHint;
        }
        await videoTrack.applyConstraints({
          width: { ideal: preset.width, max: preset.maxWidth },
          height: { ideal: preset.height, max: preset.maxHeight },
          frameRate: { ideal: preset.fps, max: preset.maxFps }
        });
      } catch {
        // Ignore if display source locks constraints
      }
    }
    if (state.activeMediaCall) {
      await tuneVideoSenderQuality(state.activeMediaCall, preset);
    }
  }

  function preferHardwareH264Codec(peerConnection) {
    if (!peerConnection || typeof peerConnection.getTransceivers !== 'function') return;
    if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;
      // Tier 1: Hardware-accelerated H.264 (NVENC / QuickSync / AMF); Tier 2: VP8 / VP9 / AV1 auto-fallback
      const h264 = [];
      const others = [];
      for (const codec of caps.codecs) {
        const mime = (codec.mimeType || '').toLowerCase();
        if (mime === 'video/h264') {
          h264.push(codec);
        } else {
          others.push(codec);
        }
      }
      if (h264.length === 0) return;
      const ordered = [...h264, ...others];
      for (const transceiver of peerConnection.getTransceivers()) {
        if (transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind === 'video') {
          if (typeof transceiver.setCodecPreferences === 'function') {
            transceiver.setCodecPreferences(ordered);
          }
        }
      }
    } catch {
      // Browser/device uses default codec negotiation (auto Tier 2 VP8/OpenH264)
    }
  }

  async function startTier3FastUdpShare(preset, toastText) {
    const token = await resolveDesktopSessionToken();
    if (!token) return false;
    await startDirectFrameDataChannelShare(preset);
    state.screenShareGrantedToPeer = true;
    state.remoteControlGrantedToPeer = true;
    if (IS_DESKTOP_APP && window.swiftdropDesktop) {
      window.swiftdropDesktop.setRemoteControlAuth(true).catch(() => {});
    }
    syncRemoteControlUI();
    if (dom.btnScreenShareLabel) {
      const canUpgradeGpu =
        state.peer &&
        !state.peer.destroyed &&
        !state.peer.disconnected &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function';
      dom.btnScreenShareLabel.textContent = canUpgradeGpu ? '⚡ Lên 60Hz GPU' : 'Dừng chia sẻ màn hình';
    }
    if (state.activeConn && state.activeConn.open) {
      try {
        state.activeConn.send({
          type: 'rc-permissions',
          remoteControl: true,
          screenShare: true
        });
      } catch {}
    }
    showToast(toastText || `Đang phát màn hình (${preset.label})!`, 'success');
    return true;
  }

  async function startDesktopScreenShare(qualityKey = state.rcScreenQuality, { unattended = false } = {}) {
    if (!state.isPeerAuthorized || !state.remoteRoomId) {
      showToast('Hãy kết nối với thiết bị nhận trước khi chia sẻ màn hình.', 'warning');
      return;
    }

    const preset = getQualityPreset(qualityKey);
    stopDesktopScreenShare();

    // Always allow WebRTC 60Hz GPU H.264 whenever PeerJS signaling is alive (even if data channel fell back to Relay!)
    const canUseWebRtcGpuVideo =
      !unattended &&
      state.peer &&
      !state.peer.destroyed &&
      !state.peer.disconnected &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === 'function';

    try {
      // Tier 1 & Tier 2 (Primary — 60Hz <15ms): WebRTC WGC + GPU H.264 (NVENC/QuickSync/AMF) with automatic VP8/OpenH264 CPU fallback
      if (canUseWebRtcGpuVideo) {
        try {
          const stream = await captureDesktopStream(preset);
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack) {
            if ('contentHint' in videoTrack) {
              videoTrack.contentHint = preset.contentHint;
            }
            videoTrack.addEventListener('ended', () => {
              stopDesktopScreenShare();
            });
          }

          state.localScreenStream = stream;
          state.screenShareGrantedToPeer = true;
          state.remoteControlGrantedToPeer = true;
          if (dom.hostGpuRequestBanner) {
            dom.hostGpuRequestBanner.classList.add('hidden');
          }
          if (IS_DESKTOP_APP && window.swiftdropDesktop) {
            window.swiftdropDesktop.setRemoteControlAuth(true).catch(() => {});
          }
          syncRemoteControlUI();
          const call = state.peer.call(toFullPeerId(state.remoteRoomId), stream);
          state.activeMediaCall = call;

          preferHardwareH264Codec(call.peerConnection);
          setTimeout(() => {
            preferHardwareH264Codec(call.peerConnection);
            tuneVideoSenderQuality(call, preset);
          }, 180);
          setTimeout(() => tuneVideoSenderQuality(call, preset), 1000);

          call.on('close', () => {
            if (state.activeMediaCall === call) {
              stopDesktopScreenShare();
            }
          });

          if (dom.btnScreenShareLabel) {
            dom.btnScreenShareLabel.textContent = 'Dừng chia sẻ màn hình';
          }
          if (state.activeConn && state.activeConn.open) {
            try {
              state.activeConn.send({
                type: 'rc-permissions',
                remoteControl: true,
                screenShare: true
              });
            } catch {}
          }
          showToast(`Đang phát màn hình 60Hz GPU H.264 (${preset.label})!`, 'success');
          return;
        } catch (gpuErr) {
          // If on SwiftDrop Desktop and user/GPU capture fails, seamlessly fall back to Tier 3 Fast-UDP
          if (IS_DESKTOP_APP && state.activeConn && state.activeConn.open) {
            const started = await startTier3FastUdpShare(
              preset,
              `Đã chuyển tự động sang luồng Fast-UDP (${preset.label})!`
            );
            if (started) return;
          }
          throw gpuErr;
        }
      }

      // Tier 3 (Unattended / 4G Relay / Universal Fallback): Fast-UDP Raw-Binary Frame Streamer (25-45Hz)
      if (IS_DESKTOP_APP && state.activeConn && state.activeConn.open) {
        const msg = unattended
          ? `Đang phát tự động Fast-UDP (${preset.label}). Bấm "Chia sẻ màn hình" trên PC để lên 60Hz GPU H.264!`
          : `Đang phát màn hình Fast-UDP (${preset.label})!`;
        const started = await startTier3FastUdpShare(preset, msg);
        if (started) return;
      }

      showToast('Chia sẻ màn hình cần kết nối WebRTC trực tiếp hoặc SyloBeam Desktop.', 'warning');
    } catch (err) {
      showToast(`Không thể chia sẻ màn hình: ${(err && err.message) || 'Đã hủy'}`, 'warning');
    }
  }

  function stopDesktopScreenShare() {
    if (dom.hostGpuRequestBanner) {
      dom.hostGpuRequestBanner.classList.add('hidden');
    }
    if (state.localScreenController) {
      const ctrl = state.localScreenController;
      state.localScreenController = null;
      try {
        ctrl.stop();
      } catch {}
    }
    if (state.activeMediaCall) {
      const c = state.activeMediaCall;
      state.activeMediaCall = null;
      try {
        c.close();
      } catch {}
    }
    if (state.localScreenStream) {
      if (typeof state.localScreenStream._stopNativeBridge === 'function') {
        try {
          state.localScreenStream._stopNativeBridge();
        } catch {}
      }
      state.localScreenStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      state.localScreenStream = null;
    }
    if (dom.btnScreenShareLabel) {
      dom.btnScreenShareLabel.textContent = 'Chia sẻ màn hình';
    }
  }

  function updateRemoteVideoUIState(isActive, mode = 'video') {
    state.rcVideoActive = Boolean(isActive);
    state.rcRemoteMode = mode;
    const useCanvas = isActive && mode === 'canvas';
    const useVideo = isActive && mode !== 'canvas';
    if (dom.rcScreenCanvas) {
      dom.rcScreenCanvas.classList.toggle('hidden', !useCanvas);
    }
    if (dom.rcScreenVideo) {
      dom.rcScreenVideo.classList.toggle('hidden', !useVideo);
    }
    if (dom.rcScreenPlaceholder) {
      dom.rcScreenPlaceholder.classList.toggle('hidden', isActive);
    }
    if (dom.rcBtnRequestScreen) {
      dom.rcBtnRequestScreen.classList.toggle('hidden', isActive);
    }
    if (dom.rcLiveScreenHud) {
      dom.rcLiveScreenHud.classList.toggle('hidden', !isActive);
    }
    if (dom.rcBtnGpuBoost) {
      dom.rcBtnGpuBoost.classList.toggle('hidden', !useCanvas);
      dom.rcBtnGpuBoost.classList.toggle('inline-flex', useCanvas);
    }
    if (dom.rcHardwareCursor && !isActive) {
      dom.rcHardwareCursor.classList.add('hidden');
    }
    if (dom.rcStageViewport) {
      if (isActive) {
        dom.rcStageViewport.classList.remove('bg-zinc-900/90');
        dom.rcStageViewport.classList.add('bg-black');
      } else {
        dom.rcStageViewport.classList.add('bg-zinc-900/90');
        dom.rcStageViewport.classList.remove('bg-black');
      }
    }
    syncRcControlPillsUI();
  }

  function focusDesktopImeTrap() {
    if (!isDesktopPcController() || !dom.rcDesktopImeTrap) return;
    if (!dom.remoteControlModal || dom.remoteControlModal.classList.contains('hidden')) return;
    try {
      dom.rcDesktopImeTrap.focus({ preventScroll: true });
    } catch {
      try {
        dom.rcDesktopImeTrap.focus();
      } catch {}
    }
  }

  function isPcRemoteModalActive() {
    if (!isDesktopPcController()) return false;
    if (!dom.remoteControlModal || dom.remoteControlModal.classList.contains('hidden')) return false;
    const blockers = [
      dom.consentModal,
      dom.pinChallengeModal,
      dom.settingsModal,
      dom.textModal,
      dom.receivedTextModal,
      dom.qrModal
    ];
    for (let i = 0; i < blockers.length; i += 1) {
      if (blockers[i] && !blockers[i].classList.contains('hidden')) return false;
    }
    return true;
  }

  function syncRcControlPillsUI() {
    const pcMode = isDesktopPcController();
    if (pcMode) {
      state.rcTouchMode = 'direct';
      state.rcSwipeDragMode = false;
      state.rcDragActive = false;
    }
    if (dom.rcTouchModeBtn) {
      if (pcMode) {
        dom.rcTouchModeBtn.classList.add('hidden');
      } else {
        dom.rcTouchModeBtn.classList.remove('hidden');
        const isDirect = state.rcTouchMode === 'direct';
        dom.rcTouchModeBtn.textContent = isDirect ? 'Cảm ứng' : 'Trackpad';
        dom.rcTouchModeBtn.className = isDirect
          ? 'min-button px-2.5 py-1 rounded-full text-[11px] font-medium text-emerald-300 border-emerald-500/35 whitespace-nowrap'
          : 'min-button px-2.5 py-1 rounded-full text-[11px] font-medium text-zinc-200 whitespace-nowrap';
      }
    }
    if (dom.rcQualityBtn) {
      dom.rcQualityBtn.textContent = getQualityPreset(state.rcScreenQuality).label;
    }
    if (dom.rcSwipeActionBtn) {
      if (state.rcSwipeDragMode) {
        dom.rcSwipeActionBtn.textContent = 'Vuốt: Kéo thả';
        dom.rcSwipeActionBtn.className = 'min-button py-2 rounded-xl text-[11px] font-semibold text-amber-300 border-amber-500/40 truncate px-1.5';
      } else {
        dom.rcSwipeActionBtn.textContent = 'Vuốt: Di chuột';
        dom.rcSwipeActionBtn.className = 'min-button py-2 rounded-xl text-[11px] font-medium text-emerald-300 border-emerald-500/35 truncate px-1.5';
      }
    }
    if (dom.rcFsSwipeBtn) {
      if (pcMode) {
        dom.rcFsSwipeBtn.classList.add('hidden');
      } else {
        dom.rcFsSwipeBtn.classList.remove('hidden');
        dom.rcFsSwipeBtn.textContent = state.rcSwipeDragMode ? 'Kéo thả' : 'Di chuột';
        dom.rcFsSwipeBtn.className = state.rcSwipeDragMode
          ? 'px-3 py-2 rounded-full bg-amber-500/25 border border-amber-400/50 text-[11px] font-semibold text-amber-200 backdrop-blur-md shadow-xl active:scale-95 transition'
          : 'px-3 py-2 rounded-full bg-black/75 border border-zinc-700/80 text-[11px] font-medium text-emerald-300 backdrop-blur-md shadow-xl active:scale-95 transition';
      }
    }
    if (dom.rcToggleControlsBtn) {
      if (pcMode) {
        dom.rcToggleControlsBtn.classList.add('hidden');
        dom.rcToggleControlsBtn.classList.remove('sm:inline-flex');
      } else {
        dom.rcToggleControlsBtn.classList.remove('hidden');
        dom.rcToggleControlsBtn.classList.add('sm:inline-flex');
        dom.rcToggleControlsBtn.textContent = state.rcControlsCollapsed ? 'Hiện phím' : 'Ẩn phím';
      }
    }
    if (dom.rcControlsDock) {
      const hideDock = pcMode || state.rcControlsCollapsed || state.rcFullscreen;
      dom.rcControlsDock.classList.toggle('hidden', hideDock);
      dom.rcControlsDock.classList.toggle('flex', !hideDock);
    }
    if (dom.rcTouchOverlay) {
      dom.rcTouchOverlay.classList.toggle('rc-pc-mode', pcMode);
    }
    if (dom.rcHint1 && dom.rcHint2) {
      const k1 = pcMode ? 'rc_pc_hint_1' : 'rc_hint_1';
      const k2 = pcMode ? 'rc_pc_hint_2' : 'rc_hint_2';
      dom.rcHint1.setAttribute('data-i18n', k1);
      dom.rcHint2.setAttribute('data-i18n', k2);
      dom.rcHint1.textContent = t(k1);
      dom.rcHint2.textContent = t(k2);
    }
  }

  function applyRemoteZoomTransform() {
    const z = state.rcZoom;
    if (dom.rcStageViewport) {
      const rect = dom.rcStageViewport.getBoundingClientRect();
      const maxTx = Math.max(0, ((z.scale - 1) * rect.width) / 2);
      const maxTy = Math.max(0, ((z.scale - 1) * rect.height) / 2);
      z.tx = Math.max(-maxTx, Math.min(maxTx, z.tx));
      z.ty = Math.max(-maxTy, Math.min(maxTy, z.ty));
    }
    if (z.scale <= 1.02) {
      z.scale = 1;
      z.tx = 0;
      z.ty = 0;
    }
    if (dom.rcVideoTransformLayer) {
      dom.rcVideoTransformLayer.style.transform = `translate3d(${z.tx.toFixed(1)}px, ${z.ty.toFixed(1)}px, 0) scale(${z.scale.toFixed(3)})`;
    }
    if (dom.rcZoomResetBtn) {
      if (z.scale > 1.04) {
        dom.rcZoomResetBtn.textContent = `${z.scale.toFixed(1)}× ↺`;
        dom.rcZoomResetBtn.classList.remove('hidden');
      } else {
        dom.rcZoomResetBtn.classList.add('hidden');
      }
    }
  }

  function resetRemoteZoom() {
    state.rcZoom = { scale: 1, tx: 0, ty: 0 };
    applyRemoteZoomTransform();
  }

  function setRemoteFullscreen(enabled) {
    state.rcFullscreen = Boolean(enabled);
    if (dom.rcTopHeader) {
      dom.rcTopHeader.classList.toggle('hidden', state.rcFullscreen);
    }
    if (dom.rcControlsDock) {
      const hideDock = isDesktopPcController() || state.rcFullscreen || state.rcControlsCollapsed;
      dom.rcControlsDock.classList.toggle('hidden', hideDock);
      dom.rcControlsDock.classList.toggle('flex', !hideDock);
    }
    if (dom.rcFsExitDock) {
      dom.rcFsExitDock.classList.toggle('hidden', !state.rcFullscreen);
    }
    if (dom.rcWorkspaceWrap) {
      if (state.rcFullscreen) {
        dom.rcWorkspaceWrap.classList.remove('p-2.5', 'gap-2');
        dom.rcWorkspaceWrap.classList.add('p-0', 'gap-0');
      } else {
        dom.rcWorkspaceWrap.classList.add('p-2.5', 'gap-2');
        dom.rcWorkspaceWrap.classList.remove('p-0', 'gap-0');
      }
    }
    if (dom.rcStageViewport) {
      if (state.rcFullscreen) {
        dom.rcStageViewport.classList.remove('rounded-2xl', 'border', 'border-zinc-800');
      } else {
        dom.rcStageViewport.classList.add('rounded-2xl', 'border', 'border-zinc-800');
      }
    }
    // Attempt native browser Fullscreen API where supported (Android/Desktop); CSS edge-to-edge covers iOS Safari seamlessly
    try {
      if (state.rcFullscreen) {
        const el = dom.remoteControlModal;
        if (el && !document.fullscreenElement) {
          if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        }
      } else if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      }
    } catch {
      // Ignore iOS Safari Fullscreen API restriction
    }
    applyRemoteZoomTransform();
    syncRcControlPillsUI();
    focusDesktopImeTrap();
  }

  function stopRemoteScreenPlayback() {
    stopRemoteVideoStatsMonitor();
    resetRemoteZoom();
    state.rcCanvasActive = false;
    state.rcCanvasPendingFrame = null;
    state.rcCanvasFrameQueue.length = 0;
    state.rcCanvasFrameCount = 0;
    state.rcCanvasBytesSum = 0;
    state.rcLastFrameBytes = 0;
    state.rcLastFrameFlags = 0;
    if (dom.rcHardwareCursor) {
      dom.rcHardwareCursor.classList.add('hidden');
    }
    if (state.activeMediaCall) {
      const c = state.activeMediaCall;
      state.activeMediaCall = null;
      try {
        c.close();
      } catch {}
    }
    if (dom.rcScreenVideo) {
      dom.rcScreenVideo.srcObject = null;
    }
    if (dom.rcVideoResBadge) {
      dom.rcVideoResBadge.textContent = 'LIVE 60Hz';
    }
    updateRemoteVideoUIState(false, 'video');
  }

  function handleIncomingScreenCall(incomingCall) {
    const callerRoomId = extractRoomIdFromPeerId(incomingCall.peer);
    if (!state.isPeerAuthorized || callerRoomId !== state.remoteRoomId) {
      try {
        incomingCall.close();
      } catch {}
      return;
    }

    stopRemoteScreenPlayback();
    state.activeMediaCall = incomingCall;
    incomingCall.answer();
    tuneIncomingVideoReceiver(incomingCall);

    incomingCall.on('stream', (remoteStream) => {
      state.rcCanvasActive = false;
      if (dom.rcScreenVideo) {
        dom.rcScreenVideo.srcObject = remoteStream;
        dom.rcScreenVideo.play().catch(() => {});
      }
      tuneIncomingVideoReceiver(incomingCall);
      startRemoteVideoStatsMonitor(incomingCall);
      updateRemoteVideoUIState(true, 'video');
      showToast('Màn hình PC trực tiếp 60Hz — vuốt trực tiếp để di chuột theo tay!', 'success');
    });

    incomingCall.on('close', () => {
      if (state.activeMediaCall === incomingCall) {
        stopRemoteScreenPlayback();
      }
    });
  }

  function openRemoteControlModal() {
    if (!state.isPeerAuthorized || (!state.remoteControlAllowedByHost && !state.screenShareAllowedByHost)) {
      showToast('Thiết bị kia chưa cấp quyền điều khiển máy tính.', 'warning');
      return;
    }
    if ((state.remoteControlAllowedByHost || state.screenShareAllowedByHost) && state.activeConn && !state.activeConn.isCloudflareRelay) {
      openLowLatencyControlChannel(state.remoteRoomId);
    }
    if (dom.rcPeerTitle) {
      const name = (state.remoteProfile && state.remoteProfile.nickname) || state.remoteRoomId;
      dom.rcPeerTitle.textContent = `Điều khiển ${name}`;
    }
    syncRemoteControlUI();
    if (state.rcCanvasActive) {
      updateRemoteVideoUIState(true, 'canvas');
    } else if (dom.rcScreenVideo && dom.rcScreenVideo.srcObject) {
      updateRemoteVideoUIState(true, 'video');
    } else {
      updateRemoteVideoUIState(false, 'video');
    }
    dom.remoteControlModal.classList.remove('hidden');
    dom.remoteControlModal.classList.add('flex');
    if (isDesktopPcController()) {
      state.rcTouchMode = 'direct';
      state.rcSwipeDragMode = false;
      syncRcControlPillsUI();
      if (dom.rcDesktopImeTrap) dom.rcDesktopImeTrap.value = '';
      focusDesktopImeTrap();
      requestAnimationFrame(focusDesktopImeTrap);
    }
    if (typeof scheduleEarthFrame === 'function') scheduleEarthFrame();
  }

  function closeRemoteControlModal() {
    if (state.rcFullscreen) {
      setRemoteFullscreen(false);
    }
    resetRemoteZoom();
    if (state.rcDragActive) {
      state.rcDragActive = false;
      sendRemoteControlCmd({ action: 'mouse_up', button: 'left' });
      if (dom.rcBtnDragToggle) dom.rcBtnDragToggle.textContent = 'Giữ kéo: TẮT';
    }
    if (dom.rcDesktopImeTrap) {
      try {
        dom.rcDesktopImeTrap.value = '';
        dom.rcDesktopImeTrap.blur();
      } catch {}
    }
    if (dom.remoteControlModal) {
      dom.remoteControlModal.classList.add('hidden');
      dom.remoteControlModal.classList.remove('flex');
    }
    if (typeof scheduleEarthFrame === 'function') scheduleEarthFrame();
  }

  function getNormalizedVideoCoords(clientX, clientY) {
    const useCanvas = state.rcCanvasActive && dom.rcScreenCanvas;
    const mediaEl = useCanvas ? dom.rcScreenCanvas : dom.rcScreenVideo;
    const viewport = dom.rcStageViewport;
    if (!mediaEl || !viewport) return null;
    const rect = mediaEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const vw = (useCanvas ? mediaEl.width : mediaEl.videoWidth) || rect.width;
    const vh = (useCanvas ? mediaEl.height : mediaEl.videoHeight) || rect.height;
    const videoRatio = vw / vh;
    const boxRatio = rect.width / rect.height;
    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRatio > boxRatio) {
      renderH = rect.width / videoRatio;
      offsetY = (rect.height - renderH) / 2;
    } else {
      renderW = rect.height * videoRatio;
      offsetX = (rect.width - renderW) / 2;
    }

    const nx = Math.max(0, Math.min(1, (clientX - rect.left - offsetX) / renderW));
    const ny = Math.max(0, Math.min(1, (clientY - rect.top - offsetY) / renderH));
    return { nx, ny };
  }

  function showTouchDot(clientX, clientY, isDragging = false) {
    if (!dom.rcStageViewport) return;
    const rect = dom.rcStageViewport.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    if (dom.rcHardwareCursor && state.rcVideoActive) {
      dom.rcHardwareCursor.classList.remove('hidden');
      dom.rcHardwareCursor.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0)`;
    }
    if (!dom.rcTouchDot) return;
    dom.rcTouchDot.style.left = `${lx}px`;
    dom.rcTouchDot.style.top = `${ly}px`;
    dom.rcTouchDot.classList.remove('hidden');
    if (isDragging) {
      dom.rcTouchDot.style.transform = 'scale(1.25)';
      dom.rcTouchDot.style.borderColor = '#fbbf24';
    } else {
      dom.rcTouchDot.style.transform = 'scale(1)';
      dom.rcTouchDot.style.borderColor = '#34d399';
    }
  }

  function hideTouchDot() {
    if (dom.rcTouchDot) {
      dom.rcTouchDot.classList.add('hidden');
    }
  }

  function bindRemoteControlListeners() {
    if (dom.btnRevokeRemoteControl) {
      dom.btnRevokeRemoteControl.addEventListener('click', () => revokeRemoteControl(false));
    }
    if (dom.btnAcceptGpu60hz) {
      dom.btnAcceptGpu60hz.addEventListener('click', () => {
        if (dom.hostGpuRequestBanner) {
          dom.hostGpuRequestBanner.classList.add('hidden');
        }
        startDesktopScreenShare(state.rcScreenQuality, { unattended: false });
      });
    }
    if (dom.btnDismissGpu60hz) {
      dom.btnDismissGpu60hz.addEventListener('click', () => {
        if (dom.hostGpuRequestBanner) {
          dom.hostGpuRequestBanner.classList.add('hidden');
        }
      });
    }

    if (dom.btnToggleScreenShare) {
      dom.btnToggleScreenShare.addEventListener('click', () => {
        const isTier3Only = Boolean(state.localScreenController && !state.localScreenStream);
        const canUpgradeGpu =
          state.peer &&
          !state.peer.destroyed &&
          !state.peer.disconnected &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getDisplayMedia === 'function';

        if (isTier3Only && canUpgradeGpu) {
          // 1-click upgrade from Tier 3 Fast-UDP (15-20Hz) -> Tier 1 GPU H.264 (60Hz)
          startDesktopScreenShare(state.rcScreenQuality, { unattended: false });
          return;
        }

        if (state.localScreenStream || state.localScreenController) {
          stopDesktopScreenShare();
          if (state.activeConn && state.activeConn.open) {
            try {
              state.activeConn.send({ type: 'rc-screen-stop' });
            } catch {}
          }
          showToast('Đã dừng chia sẻ màn hình.', 'info');
        } else {
          startDesktopScreenShare(state.rcScreenQuality, { unattended: false });
        }
      });
    }

    if (dom.btnOpenRemoteControl) {
      dom.btnOpenRemoteControl.addEventListener('click', openRemoteControlModal);
    }
    if (dom.btnCloseRemoteControl) {
      dom.btnCloseRemoteControl.addEventListener('click', closeRemoteControlModal);
    }

    // Touch Mode Toggle (Direct Touchscreen vs Relative Trackpad)
    if (dom.rcTouchModeBtn) {
      dom.rcTouchModeBtn.addEventListener('click', () => {
        state.rcTouchMode = state.rcTouchMode === 'direct' ? 'trackpad' : 'direct';
        syncRcControlPillsUI();
        showToast(
          state.rcTouchMode === 'direct'
            ? 'Chế độ Cảm ứng trực tiếp: Chạm & kéo ngay trên màn hình PC'
            : 'Chế độ Trackpad: Rê chuột tương đối chính xác từng pixel',
          'info'
        );
      });
    }

    // Quality Cycle Pill (900p 60Hz -> 720p 60Hz -> 1080p 60Hz -> 2K Nét)
    if (dom.rcQualityBtn) {
      const order = ['hd60', 'turbo', 'fhd60', 'ultra'];
      dom.rcQualityBtn.addEventListener('click', () => {
        const idx = order.indexOf(state.rcScreenQuality);
        const next = order[(idx + 1) % order.length];
        state.rcScreenQuality = next;
        syncRcControlPillsUI();
        const preset = getQualityPreset(next);
        if (state.activeConn && state.activeConn.open) {
          try {
            state.activeConn.send({ type: 'rc-screen-quality', quality: next });
          } catch {}
        }
        showToast(`Chất lượng màn hình: ${preset.label}`, 'info');
        focusDesktopImeTrap();
      });
    }

    // Fullscreen Touch Mode & Bottom-Corner Exit
    if (dom.rcFullscreenBtn) {
      dom.rcFullscreenBtn.addEventListener('click', () => {
        setRemoteFullscreen(true);
      });
    }
    if (dom.rcBtnExitFullscreen) {
      dom.rcBtnExitFullscreen.addEventListener('click', () => {
        setRemoteFullscreen(false);
      });
    }
    if (dom.rcZoomResetBtn) {
      dom.rcZoomResetBtn.addEventListener('click', () => {
        resetRemoteZoom();
      });
    }
    if (dom.rcFsSwipeBtn) {
      dom.rcFsSwipeBtn.addEventListener('click', () => {
        state.rcSwipeDragMode = !state.rcSwipeDragMode;
        syncRcControlPillsUI();
      });
    }
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && state.rcFullscreen) {
        // Keep CSS fullscreen active until user taps bottom-corner Exit button, or sync if exited via Esc on desktop
        if (!isMobileDevice()) {
          setRemoteFullscreen(false);
        }
      }
    });

    // Collapse/Expand Bottom Keyboard & Controls Dock (Great for Landscape Fullscreen)
    if (dom.rcToggleControlsBtn) {
      dom.rcToggleControlsBtn.addEventListener('click', () => {
        state.rcControlsCollapsed = !state.rcControlsCollapsed;
        syncRcControlPillsUI();
      });
    }

    // Live Video Resolution Telemetry Badge
    if (dom.rcScreenVideo) {
      const updateResBadge = () => {
        if (!dom.rcVideoResBadge || !dom.rcScreenVideo) return;
        const w = dom.rcScreenVideo.videoWidth;
        const h = dom.rcScreenVideo.videoHeight;
        if (w > 0 && h > 0) {
          dom.rcVideoResBadge.textContent = `${w}×${h}`;
        }
      };
      dom.rcScreenVideo.addEventListener('loadedmetadata', updateResBadge);
      dom.rcScreenVideo.addEventListener('resize', updateResBadge);
    }

    if (dom.rcBtnRequestScreen) {
      dom.rcBtnRequestScreen.addEventListener('click', () => {
        if (state.activeConn && state.activeConn.open) {
          state.activeConn.send({ type: 'rc-screen-request', quality: state.rcScreenQuality });
          showToast(`Đang yêu cầu phát màn hình PC (${getQualityPreset(state.rcScreenQuality).label})...`, 'info');
        }
        focusDesktopImeTrap();
      });
    }
    if (dom.rcBtnGpuBoost) {
      dom.rcBtnGpuBoost.addEventListener('click', () => {
        if (state.activeConn && state.activeConn.open) {
          state.activeConn.send({ type: 'rc-request-gpu-60hz', quality: state.rcScreenQuality });
          showToast('Đã gửi yêu cầu kích hoạt GPU 60Hz H.264 lên màn hình PC...', 'info');
        }
        focusDesktopImeTrap();
      });
    }
    if (dom.rcBtnStopScreen) {
      dom.rcBtnStopScreen.addEventListener('click', () => {
        stopRemoteScreenPlayback();
        if (state.activeConn && state.activeConn.open) {
          try {
            state.activeConn.send({ type: 'rc-screen-stop' });
          } catch {}
        }
        focusDesktopImeTrap();
      });
    }

    // Explicit Mouse Buttons
    if (dom.rcBtnLeftClick) {
      dom.rcBtnLeftClick.addEventListener('click', () => sendRemoteControlCmd({ action: 'mouse_click', button: 'left', count: 1 }));
    }
    if (dom.rcBtnRightClick) {
      dom.rcBtnRightClick.addEventListener('click', () => sendRemoteControlCmd({ action: 'mouse_click', button: 'right', count: 1 }));
    }
    if (dom.rcBtnDragToggle) {
      dom.rcBtnDragToggle.addEventListener('click', () => {
        state.rcDragActive = !state.rcDragActive;
        sendRemoteControlCmd({ action: state.rcDragActive ? 'mouse_down' : 'mouse_up', button: 'left' });
        dom.rcBtnDragToggle.textContent = state.rcDragActive ? 'Giữ kéo: BẬT' : 'Giữ kéo: TẮT';
      });
    }
    if (dom.rcSwipeActionBtn) {
      dom.rcSwipeActionBtn.addEventListener('click', () => {
        state.rcSwipeDragMode = !state.rcSwipeDragMode;
        syncRcControlPillsUI();
        showToast(
          state.rcSwipeDragMode
            ? 'Vuốt kéo trực tiếp: Chạm & vuốt sẽ giữ chuột trái kéo theo ngón tay (như màn hình cảm ứng)'
            : 'Vuốt di chuột: Vuốt ngón tay để con trỏ chuột chạy bám theo tay, chạm để bấm',
          'info'
        );
      });
    }

    // Unicode Text & Hotkeys & Media Actions
    if (dom.rcTextForm) {
      dom.rcTextForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = dom.rcTextInput.value || '';
        if (!text) return;
        sendRemoteControlCmd({ action: 'key_text', text });
        dom.rcTextInput.value = '';
      });
    }

    document.querySelectorAll('[data-rc-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sendRemoteControlCmd({ action: 'key_press', key: btn.getAttribute('data-rc-key') });
      });
    });

    document.querySelectorAll('[data-rc-combo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const keys = (btn.getAttribute('data-rc-combo') || '').split(',').map((k) => k.trim()).filter(Boolean);
        if (keys.length > 0) {
          sendRemoteControlCmd({ action: 'key_combo', keys });
        }
      });
    });

    document.querySelectorAll('[data-rc-sys]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sendRemoteControlCmd({ action: 'system_action', command: btn.getAttribute('data-rc-sys') });
      });
    });

    // UNIFIED DIRECT TOUCHSCREEN + RELATIVE TRACKPAD 60-120HZ GESTURE ENGINE
    if (dom.rcTouchOverlay) {
      const surface = dom.rcTouchOverlay;
      let pendingDx = 0;
      let pendingDy = 0;
      let pendingAbs = null;
      let pendingScrollY = 0;
      let pendingScrollX = 0;
      let rafScheduled = false;

      const isDirectScreenMode = () => state.rcVideoActive && state.rcTouchMode === 'direct';

      const flushFrame = () => {
        rafScheduled = false;
        if (pendingAbs) {
          sendRemoteControlCmd({ action: 'mouse_abs', nx: pendingAbs.nx, ny: pendingAbs.ny });
          pendingAbs = null;
        }
        if (pendingDx !== 0 || pendingDy !== 0) {
          sendRemoteControlCmd({ action: 'mouse_move', dx: Math.round(pendingDx), dy: Math.round(pendingDy) });
          pendingDx = 0;
          pendingDy = 0;
        }
        if (pendingScrollY !== 0 || pendingScrollX !== 0) {
          sendRemoteControlCmd({ action: 'mouse_scroll', dy: Math.round(pendingScrollY), dx: Math.round(pendingScrollX) });
          pendingScrollY = 0;
          pendingScrollX = 0;
        }
      };

      const queueFlush = () => {
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushFrame);
        }
      };

      let lastTouchX = 0;
      let lastTouchY = 0;
      let startTouchX = 0;
      let startTouchY = 0;
      let touchStartTime = 0;
      let touchMovedDist = 0;
      let maxTouchCount = 0;
      let lastTapTime = 0;
      let longPressTimer = null;
      let touchDragDownActive = false;

      // 2-Finger Pinch-to-Zoom & Pan State
      let pinchStartDist = 0;
      let pinchStartScale = 1;
      let pinchStartTx = 0;
      let pinchStartTy = 0;
      let pinchStartMidX = 0;
      let pinchStartMidY = 0;
      let isPinchZooming = false;

      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      };

      surface.addEventListener('touchstart', (e) => {
        e.preventDefault();
        state.rcUserTouching = true;
        maxTouchCount = Math.max(maxTouchCount, e.touches.length);

        if (e.touches.length === 1) {
          const t = e.touches[0];
          lastTouchX = t.clientX;
          lastTouchY = t.clientY;
          startTouchX = t.clientX;
          startTouchY = t.clientY;
          touchStartTime = performance.now();
          touchMovedDist = 0;
          touchDragDownActive = false;
          isPinchZooming = false;
          clearLongPress();

          if (isDirectScreenMode()) {
            const coords = getNormalizedVideoCoords(t.clientX, t.clientY);
            if (coords) {
              if (state.rcSwipeDragMode && !state.rcDragActive) {
                // Direct Touchscreen Drag Mode: press & drag smoothly immediately as finger glides
                touchDragDownActive = true;
                sendRemoteControlCmd({ action: 'mouse_abs', nx: coords.nx, ny: coords.ny, down: true, button: 'left' });
                showTouchDot(t.clientX, t.clientY, true);
              } else {
                // Cursor-Follow Finger Mode: move PC cursor immediately under finger & glide as you swipe!
                sendRemoteControlCmd({ action: 'mouse_abs', nx: coords.nx, ny: coords.ny });
                showTouchDot(t.clientX, t.clientY, state.rcDragActive);

                // Long-press (~260ms) still activates drag automatically if user holds finger still
                if (!state.rcDragActive) {
                  longPressTimer = setTimeout(() => {
                    if (touchMovedDist < 14) {
                      touchDragDownActive = true;
                      const cur = getNormalizedVideoCoords(lastTouchX, lastTouchY) || coords;
                      sendRemoteControlCmd({ action: 'mouse_abs', nx: cur.nx, ny: cur.ny, down: true, button: 'left' });
                      showTouchDot(lastTouchX, lastTouchY, true);
                    }
                  }, 260);
                }
              }
            }
          }
        } else if (e.touches.length >= 2) {
          clearLongPress();
          if (touchDragDownActive) {
            touchDragDownActive = false;
            sendRemoteControlCmd({ action: 'mouse_up', button: 'left' });
          }
          hideTouchDot();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const midX = (t0.clientX + t1.clientX) / 2;
          const midY = (t0.clientY + t1.clientY) / 2;
          lastTouchX = midX;
          lastTouchY = midY;
          pinchStartDist = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
          pinchStartScale = state.rcZoom.scale;
          pinchStartTx = state.rcZoom.tx;
          pinchStartTy = state.rcZoom.ty;
          pinchStartMidX = midX;
          pinchStartMidY = midY;
          isPinchZooming = state.rcZoom.scale > 1.03;
        }
      }, { passive: false });

      surface.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          if (isPinchZooming) return; // Ignore stray single finger lift after pinch until full release
          const t = e.touches[0];
          const rawDx = t.clientX - lastTouchX;
          const rawDy = t.clientY - lastTouchY;
          lastTouchX = t.clientX;
          lastTouchY = t.clientY;
          touchMovedDist += Math.hypot(rawDx, rawDy);

          if (touchMovedDist > 14) {
            clearLongPress();
          }

          if (isDirectScreenMode()) {
            const coords = getNormalizedVideoCoords(t.clientX, t.clientY);
            if (coords) {
              // Continuous 60-120Hz cursor tracking directly under finger as user swipes!
              pendingAbs = coords;
              showTouchDot(t.clientX, t.clientY, touchDragDownActive || state.rcDragActive);
              queueFlush();
            }
          } else {
            pendingDx += rawDx * 1.75;
            pendingDy += rawDy * 1.75;
            queueFlush();
          }
        } else if (e.touches.length === 2) {
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const midX = (t0.clientX + t1.clientX) / 2;
          const midY = (t0.clientY + t1.clientY) / 2;
          const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const distDelta = Math.abs(curDist - pinchStartDist);

          // 2-Finger Pinch-to-Zoom & Pan when video is active (spread/pinch > 12px or already zoomed in)
          if (state.rcVideoActive && (isPinchZooming || distDelta > 12)) {
            isPinchZooming = true;
            const ratio = curDist / Math.max(1, pinchStartDist);
            const nextScale = Math.max(1.0, Math.min(4.0, pinchStartScale * ratio));
            state.rcZoom.scale = nextScale;
            state.rcZoom.tx = pinchStartTx + (midX - pinchStartMidX);
            state.rcZoom.ty = pinchStartTy + (midY - pinchStartMidY);
            applyRemoteZoomTransform();
            touchMovedDist += distDelta + Math.hypot(midX - lastTouchX, midY - lastTouchY);
            lastTouchX = midX;
            lastTouchY = midY;
            return;
          }

          // Parallel 2-finger swipe at 1.0x zoom = smooth PC wheel scroll
          const deltaX = (midX - lastTouchX) * 3.0;
          const deltaY = (midY - lastTouchY) * 3.8;
          lastTouchX = midX;
          lastTouchY = midY;
          touchMovedDist += Math.hypot(deltaX, deltaY);
          pendingScrollX += deltaX;
          pendingScrollY += deltaY;
          queueFlush();
        }
      }, { passive: false });

      surface.addEventListener('touchend', (e) => {
        e.preventDefault();
        clearLongPress();
        if (e.touches.length === 0) {
          state.rcUserTouching = false;
          hideTouchDot();
          if (isPinchZooming) {
            isPinchZooming = false;
            maxTouchCount = 0;
            return;
          }
          if (touchDragDownActive) {
            touchDragDownActive = false;
            const endCoords = getNormalizedVideoCoords(lastTouchX, lastTouchY);
            if (endCoords) {
              sendRemoteControlCmd({ action: 'mouse_abs', nx: endCoords.nx, ny: endCoords.ny, up: true, button: 'left' });
            } else {
              sendRemoteControlCmd({ action: 'mouse_up', button: 'left' });
            }
            maxTouchCount = 0;
            return;
          }

          const elapsed = performance.now() - touchStartTime;
          if (elapsed < 280 && touchMovedDist < 16) {
            if (maxTouchCount >= 2) {
              if (isDirectScreenMode()) {
                const c = getNormalizedVideoCoords(startTouchX, startTouchY);
                if (c) {
                  sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, click: true, button: 'right', count: 1 });
                }
              } else {
                sendRemoteControlCmd({ action: 'mouse_click', button: 'right', count: 1 });
              }
            } else {
              const now = performance.now();
              const isDouble = now - lastTapTime < 310;
              lastTapTime = isDouble ? 0 : now;
              const count = isDouble ? 2 : 1;

              if (isDirectScreenMode()) {
                const c = getNormalizedVideoCoords(lastTouchX, lastTouchY);
                if (c) {
                  sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, click: true, button: 'left', count });
                }
              } else {
                sendRemoteControlCmd({ action: 'mouse_click', button: 'left', count });
              }
            }
          }
          maxTouchCount = 0;
        }
      }, { passive: false });

      surface.addEventListener('touchcancel', () => {
        state.rcUserTouching = false;
        clearLongPress();
        hideTouchDot();
        isPinchZooming = false;
        if (touchDragDownActive) {
          touchDragDownActive = false;
          sendRemoteControlCmd({ action: 'mouse_up', button: 'left' });
        }
        maxTouchCount = 0;
      });

      // Desktop Mouse Support (Native PC-to-PC hover/drag/3-button click/wheel + Mobile fallback)
      let mouseDown = false;
      let activeMouseButton = 'left';
      let lastMouseX = 0;
      let lastMouseY = 0;
      let mouseMoved = 0;
      let hasHoverPos = false;
      let lastHoverX = 0;
      let lastHoverY = 0;
      let lastHoverNx = -1;
      let lastHoverNy = -1;

      const getMouseBtnName = (btn) => {
        if (btn === 2) return 'right';
        if (btn === 1) return 'middle';
        return 'left';
      };

      surface.addEventListener('mousedown', (e) => {
        const pcMode = isDesktopPcController();
        if (pcMode && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        if (pcMode) {
          e.preventDefault();
          focusDesktopImeTrap();
        }
        mouseDown = true;
        activeMouseButton = pcMode ? getMouseBtnName(e.button) : (e.button === 2 ? 'right' : 'left');
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        lastHoverX = e.clientX;
        lastHoverY = e.clientY;
        hasHoverPos = true;
        mouseMoved = 0;
        if (pcMode) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c) {
            sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, down: true, button: activeMouseButton });
          } else {
            sendRemoteControlCmd({ action: 'mouse_down', button: activeMouseButton });
          }
          return;
        }
        if (isDirectScreenMode()) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c) {
            sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, down: true, button: activeMouseButton });
            showTouchDot(e.clientX, e.clientY, true);
          }
        }
      });

      // PC-to-PC native cursor tracking on hover without holding any mouse button
      surface.addEventListener('mousemove', (e) => {
        if (!isDesktopPcController() || mouseDown || !isPcRemoteModalActive()) return;
        const dx = hasHoverPos ? e.clientX - lastHoverX : 0;
        const dy = hasHoverPos ? e.clientY - lastHoverY : 0;
        lastHoverX = e.clientX;
        lastHoverY = e.clientY;
        hasHoverPos = true;
        if (state.rcVideoActive) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c && (Math.abs(c.nx - lastHoverNx) > 0.0004 || Math.abs(c.ny - lastHoverNy) > 0.0004)) {
            lastHoverNx = c.nx;
            lastHoverNy = c.ny;
            pendingAbs = c;
            queueFlush();
          }
        } else if (dx !== 0 || dy !== 0) {
          pendingDx += dx * 1.4;
          pendingDy += dy * 1.4;
          queueFlush();
        }
      });

      surface.addEventListener('mouseleave', () => {
        hasHoverPos = false;
      });

      window.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const pcMode = isDesktopPcController();
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        lastHoverX = e.clientX;
        lastHoverY = e.clientY;
        mouseMoved += Math.hypot(dx, dy);
        if (pcMode) {
          if (state.rcVideoActive) {
            const c = getNormalizedVideoCoords(e.clientX, e.clientY);
            if (c) {
              pendingAbs = c;
              queueFlush();
            }
          } else {
            pendingDx += dx * 1.4;
            pendingDy += dy * 1.4;
            queueFlush();
          }
          return;
        }
        if (isDirectScreenMode()) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c) {
            pendingAbs = c;
            showTouchDot(e.clientX, e.clientY, true);
            queueFlush();
          }
        } else {
          pendingDx += dx * 1.4;
          pendingDy += dy * 1.4;
          queueFlush();
        }
      });

      window.addEventListener('mouseup', (e) => {
        if (!mouseDown) return;
        const pcMode = isDesktopPcController();
        const btn = pcMode ? activeMouseButton : (e.button === 2 ? 'right' : 'left');
        mouseDown = false;
        activeMouseButton = 'left';
        hideTouchDot();
        if (pcMode) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c) {
            sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, up: true, button: btn });
          } else {
            sendRemoteControlCmd({ action: 'mouse_up', button: btn });
          }
          return;
        }
        if (isDirectScreenMode()) {
          const c = getNormalizedVideoCoords(e.clientX, e.clientY);
          if (c) {
            sendRemoteControlCmd({ action: 'mouse_abs', nx: c.nx, ny: c.ny, up: true, button: btn });
          } else {
            sendRemoteControlCmd({ action: 'mouse_up', button: btn });
          }
        } else if (mouseMoved < 8) {
          sendRemoteControlCmd({ action: 'mouse_click', button: btn, count: 1 });
        }
      });

      window.addEventListener('blur', () => {
        if (!mouseDown) return;
        const btn = activeMouseButton || 'left';
        mouseDown = false;
        activeMouseButton = 'left';
        hasHoverPos = false;
        hideTouchDot();
        sendRemoteControlCmd({ action: 'mouse_up', button: btn });
      });

      surface.addEventListener('wheel', (e) => {
        e.preventDefault();
        pendingScrollY += -e.deltaY * 1.2;
        if (e.deltaX) {
          pendingScrollX += e.deltaX * 1.2;
        }
        queueFlush();
      }, { passive: false });

      surface.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    bindPcNativeKeyboardController();
  }

  function mapBrowserKeyToRcKey(e) {
    const k = e.key || '';
    const kl = k.toLowerCase();
    if (kl === 'enter') return 'enter';
    if (kl === 'backspace') return 'backspace';
    if (kl === 'tab') return 'tab';
    if (kl === 'escape' || kl === 'esc') return 'escape';
    if (kl === ' ' || kl === 'spacebar') return 'space';
    if (kl === 'arrowup') return 'up';
    if (kl === 'arrowdown') return 'down';
    if (kl === 'arrowleft') return 'left';
    if (kl === 'arrowright') return 'right';
    if (kl === 'delete' || kl === 'del') return 'delete';
    if (kl === 'insert') return 'insert';
    if (kl === 'home') return 'home';
    if (kl === 'end') return 'end';
    if (kl === 'pageup') return 'pageup';
    if (kl === 'pagedown') return 'pagedown';
    if (kl === 'capslock') return 'capslock';
    if (kl === 'printscreen') return 'printscreen';
    if (/^f([1-9]|1[0-2])$/.test(kl)) return kl;
    if (k.length === 1 && !/[\u0080-\uFFFF]/.test(k)) {
      return k.toLowerCase();
    }
    const code = e.code || '';
    if (/^Key([A-Z])$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit([0-9])$/.test(code)) return code.slice(5);
    return '';
  }

  function bindPcNativeKeyboardController() {
    const trap = dom.rcDesktopImeTrap;
    let imeComposing = false;

    const SPECIAL_KEYS = new Set([
      'enter', 'tab', 'escape', 'backspace', 'delete', 'insert',
      'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
      'capslock', 'printscreen',
      'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'
    ]);

    if (trap) {
      trap.addEventListener('compositionstart', () => {
        if (!isPcRemoteModalActive()) return;
        imeComposing = true;
      });

      trap.addEventListener('compositionend', (e) => {
        imeComposing = false;
        if (!isPcRemoteModalActive()) {
          trap.value = '';
          return;
        }
        const committed = typeof e.data === 'string' ? e.data : '';
        if (committed) {
          sendRemoteControlCmd({ action: 'key_text', text: committed });
        }
        trap.value = '';
      });

      trap.addEventListener('input', (e) => {
        if (!isPcRemoteModalActive()) {
          trap.value = '';
          return;
        }
        const it = e.inputType || '';
        if (imeComposing || e.isComposing || it === 'insertCompositionText' || it === 'insertFromComposition') {
          return;
        }
        if (it.startsWith('delete')) {
          return;
        }
        let text = typeof e.data === 'string' ? e.data : '';
        if (!text && it === 'insertFromPaste') {
          text = trap.value || '';
        }
        if (text) {
          sendRemoteControlCmd({ action: 'key_text', text });
        }
        if (trap.value.length > 80) {
          trap.value = trap.value.slice(-16);
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      if (!isPcRemoteModalActive()) return;
      const target = e.target;
      if (target && target !== trap && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      // Let OS / macOS / Telex IME handle composing strokes via trap compositionend
      if (e.isComposing || imeComposing || e.key === 'Process' || e.key === 'Dead' || e.keyCode === 229) {
        focusDesktopImeTrap();
        return;
      }

      const keyName = e.key || '';
      if (keyName === 'Control' || keyName === 'Shift' || keyName === 'Alt' || keyName === 'Meta' || keyName === 'AltGraph') {
        return;
      }

      // Yield Ctrl+Alt+Escape if this window is also Desktop Host emergency hotkey
      if (IS_DESKTOP_APP && e.ctrlKey && e.altKey && keyName === 'Escape') {
        return;
      }

      const mapped = mapBrowserKeyToRcKey(e);

      // 1. Modifier combinations (Ctrl / Alt / Win+Meta)
      if (e.ctrlKey || e.altKey || e.metaKey) {
        if (!mapped) return;
        e.preventDefault();
        e.stopPropagation();
        const mods = [];
        if (e.ctrlKey) mods.push('ctrl');
        if (e.altKey) mods.push('alt');
        if (e.shiftKey) mods.push('shift');
        if (e.metaKey) mods.push('win');
        sendRemoteControlCmd({ action: 'key_combo', keys: mods.concat([mapped]) });
        return;
      }

      // 2. Shift + special navigation/function key (Shift+Arrows, Shift+Tab, Shift+Home, Shift+F10...)
      if (e.shiftKey && mapped && (SPECIAL_KEYS.has(mapped) || mapped === 'space')) {
        e.preventDefault();
        sendRemoteControlCmd({ action: 'key_combo', keys: ['shift', mapped] });
        if (trap && mapped === 'space') trap.value = '';
        return;
      }

      // 3. Spacebar outside IME composition (supports Play/Pause + text spacing)
      if (mapped === 'space' && !e.shiftKey) {
        e.preventDefault();
        sendRemoteControlCmd({ action: 'key_press', key: 'space' });
        if (trap) trap.value = '';
        return;
      }

      // 4. Special / Navigation / Function keys (Enter, Tab, Escape, Arrows, F1-F12...)
      if (mapped && SPECIAL_KEYS.has(mapped)) {
        if (mapped === 'escape' && document.fullscreenElement) {
          // Let browser handle fullscreen exit cleanly via fullscreenchange
          return;
        }
        // Keep Backspace flowing into trap naturally so Windows Unikey/EVKey can delete locally while forwarding VK_BACK
        if (mapped !== 'backspace') {
          e.preventDefault();
        }
        sendRemoteControlCmd({ action: 'key_press', key: mapped });
        if (trap && mapped === 'enter') trap.value = '';
        return;
      }

      // 5. All printable keys (English, numbers, symbols, Unikey VK_PACKET) go cleanly through focused trap input/composition
      if (trap && document.activeElement !== trap) {
        focusDesktopImeTrap();
      }
    }, true);
  }

  function handleIncomingTextMessage(packet) {
    const text = (packet.text || '').toString().slice(0, 64 * 1024);
    if (!text) return;
    dom.receivedTextContent.textContent = text;
    dom.receivedTextModal.classList.remove('hidden');
    dom.receivedTextModal.classList.add('flex');
    showToast('Nhận được tin nhắn / đường link mới!', 'success');
  }

  function handleIncomingFileMeta(meta) {
    if (!meta || typeof meta.id !== 'string') return;
    const size = Number(meta.size) || 0;
    if (size < 0 || size > 10 * 1024 * 1024 * 1024) return;

    const id = meta.id.slice(0, 64);
    const safeName = sanitizeFileName(meta.name);
    const mime = typeof meta.mime === 'string' ? meta.mime.slice(0, 128) : 'application/octet-stream';
    const totalChunks = Math.max(1, Number(meta.totalChunks) || 1);
    const expectedSha256 = typeof meta.sha256 === 'string' ? meta.sha256.trim().toLowerCase() : '';
    const now = performance.now();

    dom.transfersDrawer.classList.remove('hidden');

    state.incomingTransfers.set(id, {
      id,
      name: safeName,
      size,
      mime,
      totalChunks,
      expectedSha256,
      chunks: [],
      receivedBytes: 0,
      receivedChunks: 0,
      startTime: now,
      lastUiUpdateTime: now
    });

    createTransferItemUI({
      id,
      name: safeName,
      size,
      mime,
      direction: 'receive',
      status: 'transferring'
    });
  }

  function handleIncomingFileChunk(packet) {
    if (!packet || typeof packet.id !== 'string') return;
    const incoming = state.incomingTransfers.get(packet.id);
    if (!incoming) return;

    let chunkBuffer = packet.data;
    if (packet.data instanceof Uint8Array) {
      chunkBuffer = packet.data.buffer.slice(packet.data.byteOffset, packet.data.byteOffset + packet.data.byteLength);
    }

    const byteLength = chunkBuffer ? chunkBuffer.byteLength || chunkBuffer.size || 0 : 0;
    if (byteLength <= 0 && incoming.size > 0) return;

    incoming.chunks.push(chunkBuffer);
    incoming.receivedBytes += byteLength;
    incoming.receivedChunks += 1;

    const now = performance.now();
    if (now - incoming.lastUiUpdateTime >= 75 || incoming.receivedBytes >= incoming.size) {
      const elapsedSeconds = Math.max((now - incoming.startTime) / 1000, 0.001);
      const speedBps = incoming.receivedBytes / elapsedSeconds;
      const speedFormatted = formatSpeed(speedBps);
      const percent =
        incoming.size > 0
          ? Math.min(100, Math.round((incoming.receivedBytes / incoming.size) * 100))
          : 100;

      updateRadarRingProgress(percent, `${percent}% • ${speedFormatted}`);
      updateTransferItemUI(incoming.id, {
        transferredBytes: incoming.receivedBytes,
        totalBytes: incoming.size,
        percent,
        speedText: speedFormatted,
        statusText: `Đang nhận mảnh ${incoming.receivedChunks}/${incoming.totalChunks}`
      });
      incoming.lastUiUpdateTime = now;
    }
  }

  async function handleIncomingFileComplete(packet) {
    if (!packet || typeof packet.id !== 'string') return;
    const incoming = state.incomingTransfers.get(packet.id);
    if (!incoming) return;

    const blob = new Blob(incoming.chunks, { type: incoming.mime });
    const expectedSha256 =
      (typeof packet.sha256 === 'string' && packet.sha256.trim().toLowerCase()) || incoming.expectedSha256;

    // Free raw chunk array early after creating Blob
    incoming.chunks = [];
    state.incomingTransfers.delete(packet.id);

    updateTransferItemUI(incoming.id, {
      statusText: 'Đang kiểm tra toàn vẹn SHA-256...'
    });

    const actualSha256 = await computeBlobSha256(blob);
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      const record = state.transferRecords.get(incoming.id);
      if (record) record.status = 'error';
      updateRadarRingProgress(0);
      updateTransferItemUI(incoming.id, {
        transferredBytes: incoming.receivedBytes,
        totalBytes: incoming.size,
        percent: 100,
        statusText: 'Cảnh báo: SHA-256 không khớp (Dữ liệu bị lỗi)!',
        isError: true
      });
      showToast(`File ${incoming.name} không khớp mã kiểm tra SHA-256!`, 'error');
      return;
    }

    const blobUrl = URL.createObjectURL(blob);
    const isImage = incoming.mime.startsWith('image/');
    const totalElapsed = Math.max((performance.now() - incoming.startTime) / 1000, 0.001);
    const avgSpeed = formatSpeed(incoming.size / totalElapsed);

    const record = state.transferRecords.get(incoming.id);
    if (record) {
      record.status = 'completed';
      record.blob = blob;
      record.blobUrl = blobUrl;
      record.fileName = incoming.name;
      record.mime = incoming.mime;
      record.isImage = isImage;
      record.savedPath = '';
      record.downloaded = false;
    }

    updateRadarRingProgress(100, '100%');
    setTimeout(() => updateRadarRingProgress(0), 1200);

    updateTransferItemUI(incoming.id, {
      transferredBytes: incoming.size,
      totalBytes: incoming.size,
      percent: 100,
      speedText: avgSpeed,
      statusText: expectedSha256 ? 'Đã nhận hoàn tất • ✓ SHA-256 hợp lệ' : 'Đã nhận hoàn tất',
      isCompleted: true,
      blobUrl,
      fileName: incoming.name,
      isImage
    });

    updateDownloadAllButtonUI();

    if (dom.toggleAutoDownload && dom.toggleAutoDownload.checked) {
      enqueueAutoDownload(incoming.id);
    } else {
      showToast(`Đã nhận xong: ${incoming.name} (✓ SHA-256)`, 'success');
    }
  }

  // ============================================================================
  // 12C. RELIABLE MULTI-FILE DOWNLOAD, NATIVE ELECTRON SAVE & PURE-JS ZIP ENGINE
  // ============================================================================
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function computeCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function buildStoreZipBlob(records) {
    const localParts = [];
    const centralParts = [];
    const usedNames = new Map();
    let offset = 0;

    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

    for (const rec of records) {
      if (!rec || !rec.blob) continue;
      let rawName = sanitizeFileName(rec.fileName || rec.name || 'file');
      const count = usedNames.get(rawName.toLowerCase()) || 0;
      usedNames.set(rawName.toLowerCase(), count + 1);
      if (count > 0) {
        const dotIdx = rawName.lastIndexOf('.');
        rawName = dotIdx > 0
          ? `${rawName.slice(0, dotIdx)} (${count})${rawName.slice(dotIdx)}`
          : `${rawName} (${count})`;
      }

      const nameBytes = utf8Encode(rawName);
      const dataBytes = new Uint8Array(await rec.blob.arrayBuffer());
      const crc = computeCrc32(dataBytes);
      const size = dataBytes.byteLength;

      // Local File Header (30 bytes + name)
      const localHeader = new ArrayBuffer(30 + nameBytes.byteLength);
      const lv = new DataView(localHeader);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true); // STORE (no compression)
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.byteLength, true);
      lv.setUint16(28, 0, true);
      new Uint8Array(localHeader, 30).set(nameBytes);

      localParts.push(localHeader, dataBytes);

      // Central Directory Header (46 bytes + name)
      const centralHeader = new ArrayBuffer(46 + nameBytes.byteLength);
      const cv = new DataView(centralHeader);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.byteLength, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      new Uint8Array(centralHeader, 46).set(nameBytes);

      centralParts.push(centralHeader);
      offset += 30 + nameBytes.byteLength + size;
    }

    const centralSize = centralParts.reduce((sum, buf) => sum + buf.byteLength, 0);
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centralParts.length, true);
    ev.setUint16(10, centralParts.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  function isTouchMobileOrTablet() {
    const dt = state.myProfile && state.myProfile.deviceType;
    if (dt === 'mobile' || dt === 'tablet') return true;
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android|Mobile|Tablet/i.test(ua)) return true;
    // iPadOS 13+ Safari desktop mode reports Macintosh with multi-touch (>1 points)
    if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
    return false;
  }

  function isDesktopPcController() {
    return !isTouchMobileOrTablet();
  }

  function isMobileDevice() {
    return isTouchMobileOrTablet();
  }

  function triggerBlobAnchorDownload(blob, fileName) {
    const safeName = sanitizeFileName(fileName);
    // Use a fresh ephemeral blob URL so Safari/Chrome always treat it as a clean download trigger
    const tempUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = tempUrl;
    a.download = safeName;
    a.rel = 'noopener';
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        a.remove();
      } catch {}
      setTimeout(() => {
        try {
          URL.revokeObjectURL(tempUrl);
        } catch {}
      }, 15000);
    }, 2500);
  }

  async function saveSingleRecord(record, { isAuto = false, triggerBtn = null } = {}) {
    if (!record || !record.blob) {
      showToast('Không tìm thấy dữ liệu file để tải về.', 'warning');
      return false;
    }

    const fileName = sanitizeFileName(record.fileName || record.name);

    // 1. SwiftDrop Desktop: Write straight to configured save folder silently & instantaneously
    if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.saveFile === 'function') {
      if (triggerBtn) {
        triggerBtn.disabled = true;
        triggerBtn.textContent = 'Đang lưu...';
      }
      try {
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        const res = await window.swiftdropDesktop.saveFile(fileName, bytes);
        if (res && res.ok) {
          record.downloaded = true;
          record.savedPath = res.savedPath || '';
          const folderLabel = getPathFolderName(record.savedPath, state.desktopSaveDir) || 'Downloads';
          if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '✓ Mở file';
          }
          if (!isAuto) {
            showToast(`Đã lưu vào ${folderLabel}: ${res.fileName || fileName}`, 'success');
          }
          return true;
        }
      } catch {
        // Fall through to anchor download
      } finally {
        if (triggerBtn) triggerBtn.disabled = false;
      }
    }

    // 2. Web Browser Custom Directory (File System Access API when configured by user)
    if (!IS_DESKTOP_APP && state.webSaveDirHandle) {
      try {
        const savedOk = await writeBlobToWebDirHandle(state.webSaveDirHandle, fileName, record.blob);
        if (savedOk) {
          record.downloaded = true;
          if (triggerBtn) {
            triggerBtn.textContent = '✓ Đã lưu';
          }
          if (!isAuto) {
            showToast(`Đã lưu vào thư mục "${state.webSaveDirHandle.name}": ${fileName}`, 'success');
          }
          return true;
        }
      } catch {
        // Fallback to standard browser download
      }
    }

    // 3. Web / Mobile Browser download
    if (triggerBtn) {
      triggerBtn.textContent = 'Đang tải...';
    }
    triggerBlobAnchorDownload(record.blob, fileName);
    record.downloaded = true;

    if (triggerBtn) {
      setTimeout(() => {
        triggerBtn.textContent = '✓ Tải lại';
      }, 600);
    }

    if (!isAuto) {
      showToast(`Đang tải xuống: ${fileName}`, 'success');
    }
    return true;
  }

  async function shareRecordOnMobile(record) {
    if (!record || !record.blob) return false;
    const fileName = sanitizeFileName(record.fileName || record.name);
    try {
      const fileObj = new File([record.blob], fileName, { type: record.mime || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [fileObj] })) {
        await navigator.share({ files: [fileObj], title: fileName });
        record.downloaded = true;
        return true;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return true;
    }
    return false;
  }

  function getCompletedReceivedRecords() {
    const list = [];
    state.transferRecords.forEach((rec) => {
      if (rec && rec.direction === 'receive' && rec.status === 'completed' && rec.blob) {
        list.push(rec);
      }
    });
    return list;
  }

  function updateDownloadAllButtonUI() {
    const received = getCompletedReceivedRecords();
    if (dom.btnOpenDownloads) {
      if (IS_DESKTOP_APP && received.length > 0) {
        dom.btnOpenDownloads.classList.remove('hidden');
      } else {
        dom.btnOpenDownloads.classList.add('hidden');
      }
    }
    if (!dom.btnDownloadAll) return;
    if (received.length >= 2) {
      dom.btnDownloadAll.classList.remove('hidden');
      const allImages = received.every((r) => r.isImage);
      if (IS_DESKTOP_APP) {
        dom.btnDownloadAll.textContent = state.lang === 'en' ? `Save all (${received.length})` : `Lưu tất cả (${received.length})`;
      } else if (isMobileDevice() && allImages && typeof navigator.canShare === 'function') {
        dom.btnDownloadAll.textContent = state.lang === 'en' ? `Save ${received.length} photos` : `Lưu ${received.length} ảnh`;
      } else {
        dom.btnDownloadAll.textContent = state.lang === 'en' ? `Download all (${received.length} • ZIP)` : `Tải tất cả (${received.length} • ZIP)`;
      }
    } else if (received.length === 1 && isMobileDevice()) {
      dom.btnDownloadAll.classList.remove('hidden');
      dom.btnDownloadAll.textContent = state.lang === 'en'
        ? (received[0].isImage ? 'Save photo' : 'Download file')
        : (received[0].isImage ? 'Lưu ảnh' : 'Tải file');
    } else {
      dom.btnDownloadAll.classList.add('hidden');
    }
  }

  function enqueueAutoDownload(recordId) {
    state.downloadQueue.push(recordId);
    state.autoDownloadBatchCount += 1;
    if (state.autoDownloadBatchTimer) {
      clearTimeout(state.autoDownloadBatchTimer);
    }
    state.autoDownloadBatchTimer = setTimeout(() => {
      state.autoDownloadBatchCount = 0;
    }, 4500);

    processAutoDownloadQueue();
  }

  async function processAutoDownloadQueue() {
    if (state.isProcessingDownloads) return;
    state.isProcessingDownloads = true;

    try {
      let processedCount = 0;
      const mobile = isMobileDevice();

      while (state.downloadQueue.length > 0) {
        const recId = state.downloadQueue.shift();
        const record = state.transferRecords.get(recId);
        if (!record || !record.blob) continue;

        // On Electron Desktop: save EVERY file silently to Downloads at full speed (0ms delay)
        if (IS_DESKTOP_APP) {
          await saveSingleRecord(record, { isAuto: true });
          processedCount += 1;
          const btn = record.element && record.element.querySelector('.js-btn-download');
          if (btn) btn.textContent = '✓ Mở file';
          continue;
        }

        // On iOS/Android mobile browsers: browsers block multiple automatic programmatic downloads without user tap.
        // Trigger first file only if it's a single file; for batches, guide user to the 1-tap "Lưu tất cả" button!
        if (mobile) {
          if (processedCount === 0 && state.downloadQueue.length === 0 && state.autoDownloadBatchCount <= 1) {
            await saveSingleRecord(record, { isAuto: true });
            processedCount += 1;
          } else {
            // Keep blob ready in Transfers Drawer for 1-tap batch save (Photos Share Sheet or ZIP)
            processedCount += 1;
          }
          continue;
        }

        // On Desktop Browsers (Chrome/Edge/Safari/Firefox): space automatic downloads by 550ms to prevent throttling
        await saveSingleRecord(record, { isAuto: true });
        processedCount += 1;
        if (state.downloadQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 550));
        }
      }

      if (IS_DESKTOP_APP && processedCount > 0) {
        showToast(
          processedCount > 1
            ? `Đã tự động lưu toàn bộ ${processedCount} file vào thư mục Downloads!`
            : 'Đã tự động lưu file vào thư mục Downloads!',
          'success'
        );
      } else if (mobile && state.autoDownloadBatchCount > 1) {
        showToast(`Đã nhận ${getCompletedReceivedRecords().length} file — bấm "Lưu tất cả" để tải toàn bộ 1 lần!`, 'success');
      } else if (processedCount > 0) {
        showToast(
          processedCount > 1
            ? `Đã gửi lệnh tải xuống ${processedCount} file (nếu trình duyệt chặn, bấm "Tải tất cả • ZIP").`
            : 'Đã nhận và tự động tải xuống hoàn tất (✓ SHA-256)!',
          'success'
        );
      }
    } finally {
      state.isProcessingDownloads = false;
      updateDownloadAllButtonUI();
    }
  }

  async function downloadAllCompletedFiles() {
    const received = getCompletedReceivedRecords();
    if (received.length === 0) {
      showToast('Chưa có file nhận nào hoàn tất để tải.', 'warning');
      return;
    }

    if (dom.btnDownloadAll) {
      dom.btnDownloadAll.disabled = true;
      dom.btnDownloadAll.textContent = 'Đang xử lý...';
    }

    try {
      // 1. SwiftDrop Desktop (Electron): Save any unsaved files natively to Downloads & open folder
      if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.saveFile === 'function') {
        let savedCount = 0;
        let lastPath = '';
        for (const rec of received) {
          if (!rec.savedPath) {
            const ok = await saveSingleRecord(rec, { isAuto: true });
            if (ok) savedCount += 1;
          } else {
            savedCount += 1;
          }
          if (rec.savedPath) lastPath = rec.savedPath;
        }
        const folderLabel = getPathFolderName(lastPath, state.desktopSaveDir) || 'Downloads';
        showToast(`Đã lưu toàn bộ ${savedCount} file vào ${folderLabel}!`, 'success');
        if (window.swiftdropDesktop.openDownloadsFolder) {
          window.swiftdropDesktop.openDownloadsFolder(lastPath).catch(() => {});
        }
        return;
      }

      // 2. Single file -> direct save or mobile share
      if (received.length === 1) {
        const only = received[0];
        if (isMobileDevice() && only.isImage) {
          const shared = await shareRecordOnMobile(only);
          if (shared) return;
        }
        await saveSingleRecord(only, { isAuto: false });
        return;
      }

      // 3. Mobile Batch Share Sheet (Saves multiple photos straight into iPhone Camera Roll in 1 tap!)
      if (isMobileDevice() && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
        try {
          const files = received.map(
            (r) => new File([r.blob], sanitizeFileName(r.fileName || r.name), { type: r.mime || 'application/octet-stream' })
          );
          if (navigator.canShare({ files })) {
            await navigator.share({
              files,
              title: `SyloBeam (${files.length} file)`
            });
            received.forEach((r) => {
              r.downloaded = true;
            });
            showToast(`Đã mở menu lưu ${files.length} file!`, 'success');
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') {
            return;
          }
          // Fall through to 1-file ZIP download if share failed or exceeded OS file limit
        }
      }

      // 4. Universal 1-Click ZIP Package (100% immune to Chrome/Safari multi-download blocking!)
      showToast(`Đang đóng gói ${received.length} file thành 1 file ZIP...`, 'info');
      const zipBlob = await buildStoreZipBlob(received);
      const stamp = new Date().toISOString().slice(0, 10);
      const zipName = `SyloBeam_${received.length}_files_${stamp}.zip`;
      triggerBlobAnchorDownload(zipBlob, zipName);
      received.forEach((r) => {
        r.downloaded = true;
      });
      showToast(`Đang tải xuống ${zipName} (${formatBytes(zipBlob.size)})!`, 'success');
    } catch (err) {
      showToast(`Không thể đóng gói tải tất cả: ${(err && err.message) || err}`, 'error');
    } finally {
      if (dom.btnDownloadAll) {
        dom.btnDownloadAll.disabled = false;
      }
      updateDownloadAllButtonUI();
    }
  }

  // ============================================================================
  // 13. MINIMALIST TRANSFER SHEET UI RENDERING
  // ============================================================================
  function createTransferItemUI({ id, name, size, mime, direction, status }) {
    dom.transfersEmptyState.classList.add('hidden');

    const isSend = direction === 'send';
    const badgeLabel = isSend ? '↑ GỬI' : '↓ NHẬN';

    const itemEl = document.createElement('div');
    itemEl.id = `transfer-item-${id}`;
    itemEl.className =
      'p-3 rounded-xl bg-zinc-950/90 border border-zinc-800/90 space-y-2 transition-all';

    itemEl.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-zinc-900 text-zinc-300 border border-zinc-800 shrink-0">
            ${badgeLabel}
          </span>
          <div class="min-w-0">
            <h4 class="text-xs font-medium text-white truncate" title="${escapeHtml(name)}">
              ${escapeHtml(name)}
            </h4>
            <div class="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono">
              <span class="js-transfer-bytes">0 B / ${formatBytes(size)}</span>
              <span>•</span>
              <span class="js-transfer-speed text-zinc-300">0.00 MB/s</span>
            </div>
          </div>
        </div>
        <span class="js-transfer-percent font-mono text-xs font-semibold text-white shrink-0">0%</span>
      </div>

      <div class="w-full h-1 bg-zinc-900 rounded-full overflow-hidden">
        <div class="js-transfer-bar h-full bg-white rounded-full transition-all duration-100" style="width: 0%"></div>
      </div>

      <div class="flex items-center justify-between gap-2">
        <span class="js-transfer-status text-[11px] text-zinc-400">Đang chuẩn bị...</span>
        <div class="js-transfer-actions flex items-center gap-1.5"></div>
      </div>

      <div class="js-image-preview-wrap hidden pt-1"></div>
    `;

    dom.transfersList.prepend(itemEl);

    state.transferRecords.set(id, {
      id,
      name,
      size,
      mime,
      direction,
      status,
      element: itemEl
    });

    updateTransferCountBadge();
  }

  function updateTransferItemUI(
    id,
    {
      transferredBytes,
      totalBytes,
      percent,
      speedText,
      statusText,
      isCompleted = false,
      isError = false,
      blobUrl = null,
      fileName = null,
      isImage = false
    }
  ) {
    const record = state.transferRecords.get(id);
    if (!record || !record.element) return;

    const el = record.element;
    const bytesEl = el.querySelector('.js-transfer-bytes');
    const speedEl = el.querySelector('.js-transfer-speed');
    const percentEl = el.querySelector('.js-transfer-percent');
    const barEl = el.querySelector('.js-transfer-bar');
    const statusEl = el.querySelector('.js-transfer-status');
    const actionsEl = el.querySelector('.js-transfer-actions');
    const previewWrap = el.querySelector('.js-image-preview-wrap');

    if (typeof transferredBytes === 'number' && typeof totalBytes === 'number' && bytesEl) {
      bytesEl.textContent = `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}`;
    }
    if (speedText && speedEl) {
      speedEl.textContent = speedText;
    }
    if (typeof percent === 'number') {
      if (percentEl) percentEl.textContent = `${percent}%`;
      if (barEl) barEl.style.width = `${percent}%`;
    }
    if (statusText && statusEl) {
      statusEl.textContent = statusText;
    }

    if (isError) {
      if (barEl) barEl.className = 'js-transfer-bar h-full bg-rose-500 rounded-full';
      if (statusEl) statusEl.className = 'js-transfer-status text-[11px] text-rose-400';
    }

    if (isCompleted) {
      if (barEl) barEl.className = 'js-transfer-bar h-full bg-emerald-400 rounded-full';
      if (statusEl) statusEl.className = 'js-transfer-status text-[11px] text-emerald-400 font-medium';

      if (actionsEl) {
        actionsEl.innerHTML = '';

        if (isImage && blobUrl) {
          const previewBtn = document.createElement('button');
          previewBtn.type = 'button';
          previewBtn.className =
            'px-2.5 py-1 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] font-medium border border-zinc-800 transition';
          previewBtn.textContent = 'Xem ảnh';
          previewBtn.addEventListener('click', () => {
            openImagePreviewModal(blobUrl, fileName || record.name);
          });
          actionsEl.appendChild(previewBtn);

          if (previewWrap) {
            previewWrap.classList.remove('hidden');
            previewWrap.innerHTML = `
              <img src="${blobUrl}" alt="${escapeHtml(fileName || record.name)}" class="max-h-28 rounded-lg border border-zinc-800 object-cover cursor-pointer hover:opacity-90 transition" />
            `;
            const thumbImg = previewWrap.querySelector('img');
            if (thumbImg) {
              thumbImg.addEventListener('click', () =>
                openImagePreviewModal(blobUrl, fileName || record.name)
              );
            }
          }
        }

        if (blobUrl && record.direction === 'receive') {
          // On Mobile (iPhone/Android), offer 1-tap Share/Save to Photos button for images
          if (isMobileDevice() && isImage && typeof navigator.canShare === 'function') {
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className =
              'px-2.5 py-1 rounded-full bg-zinc-900 hover:bg-zinc-800 text-emerald-300 text-[11px] font-medium border border-emerald-500/35 transition';
            shareBtn.textContent = 'Lưu ảnh';
            shareBtn.addEventListener('click', async () => {
              const ok = await shareRecordOnMobile(record);
              if (!ok) {
                await saveSingleRecord(record, { isAuto: false, triggerBtn: shareBtn });
              }
            });
            actionsEl.appendChild(shareBtn);
          }

          const downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className =
            'js-btn-download px-3 py-1 rounded-full bg-white hover:bg-zinc-200 text-zinc-950 text-[11px] font-semibold transition active:scale-95';
          downloadBtn.textContent = record.savedPath ? '✓ Mở file' : 'Tải về';
          downloadBtn.addEventListener('click', async () => {
            if (IS_DESKTOP_APP && record.savedPath && window.swiftdropDesktop && window.swiftdropDesktop.openDownloadsFolder) {
              window.swiftdropDesktop.openDownloadsFolder(record.savedPath).catch(() => {});
              showToast(`Đã mở thư mục chứa: ${record.fileName || record.name}`, 'info');
              return;
            }
            await saveSingleRecord(record, { isAuto: false, triggerBtn: downloadBtn });
          });
          actionsEl.appendChild(downloadBtn);
        }
      }
    }
  }

  function updateTransferCountBadge() {
    dom.transferCountBadge.textContent = String(state.transferRecords.size);
    if (state.transferRecords.size === 0) {
      dom.transfersEmptyState.classList.remove('hidden');
    } else {
      dom.transfersEmptyState.classList.add('hidden');
    }
  }

  function openImagePreviewModal(imgUrl, title) {
    dom.previewModalImg.src = imgUrl;
    dom.previewModalTitle.textContent = title || 'Xem trước hình ảnh';
    dom.imagePreviewModal.classList.remove('hidden');
    dom.imagePreviewModal.classList.add('flex');
  }

  function closeImagePreviewModal() {
    dom.imagePreviewModal.classList.add('hidden');
    dom.imagePreviewModal.classList.remove('flex');
    dom.previewModalImg.src = '';
  }

  // ============================================================================
  // 14. MODALS, THEME ENGINE, SAVE PATH & REAL-TIME EARTH
  // ============================================================================
  function getPathFolderName(filePath, dirFallback = '') {
    const raw = String(filePath || '');
    if (raw) {
      const idx = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
      if (idx > 0) {
        const parent = raw.slice(0, idx);
        const pIdx = Math.max(parent.lastIndexOf('\\'), parent.lastIndexOf('/'));
        return pIdx >= 0 ? parent.slice(pIdx + 1) : parent;
      }
    }
    const dir = String(dirFallback || '').replace(/[\\/]+$/, '');
    if (!dir) return '';
    const dIdx = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
    return dIdx >= 0 ? dir.slice(dIdx + 1) : dir;
  }

  function loadSavedTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_THEME);
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function applyTheme(mode, { persist = true, redrawEarth = true } = {}) {
    const theme = mode === 'light' ? 'light' : 'dark';
    state.theme = theme;
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.classList.toggle('dark', theme === 'dark');

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'light' ? '#edf1f7' : '#08090b');
    }

    if (dom.iconThemeSun && dom.iconThemeMoon) {
      dom.iconThemeSun.classList.toggle('hidden', theme !== 'light');
      dom.iconThemeMoon.classList.toggle('hidden', theme === 'light');
    }
    if (dom.btnThemeDark) dom.btnThemeDark.classList.toggle('is-active', theme === 'dark');
    if (dom.btnThemeLight) dom.btnThemeLight.classList.toggle('is-active', theme === 'light');

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY_THEME, theme);
      } catch {}
    }
    if (redrawEarth) {
      renderRealtimeEarth();
    }
  }

  // IndexedDB persistence for Web File System Access API DirectoryHandle
  const FS_HANDLE_DB = 'swiftdrop_fs_handles_v1';
  const FS_HANDLE_STORE = 'handles';
  function openFsHandleDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(FS_HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(FS_HANDLE_STORE)) {
          req.result.createObjectStore(FS_HANDLE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveWebSaveDirHandle(handle) {
    try {
      const db = await openFsHandleDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FS_HANDLE_STORE, 'readwrite');
        const store = tx.objectStore(FS_HANDLE_STORE);
        if (handle) store.put(handle, 'saveDir');
        else store.delete('saveDir');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function loadWebSaveDirHandle() {
    if (IS_DESKTOP_APP || typeof window.showDirectoryPicker !== 'function') return;
    try {
      const db = await openFsHandleDb();
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(FS_HANDLE_STORE, 'readonly');
        const req = tx.objectStore(FS_HANDLE_STORE).get('saveDir');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (handle && handle.kind === 'directory') {
        state.webSaveDirHandle = handle;
      }
    } catch {}
  }

  async function writeBlobToWebDirHandle(dirHandle, fileName, blob) {
    if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') return false;
    let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') return false;

    const dotIdx = fileName.lastIndexOf('.');
    const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
    const ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';
    let candidate = fileName;
    for (let i = 1; i < 200; i += 1) {
      try {
        await dirHandle.getFileHandle(candidate, { create: false });
        candidate = `${base} (${i})${ext}`;
      } catch {
        break;
      }
    }
    const fh = await dirHandle.getFileHandle(candidate, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  async function syncSaveDirModalUI() {
    if (!dom.saveDirInput) return;
    if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.getDownloadDir === 'function') {
      dom.saveDirInput.readOnly = false;
      try {
        const info = await window.swiftdropDesktop.getDownloadDir();
        if (info && info.downloadsDir) {
          state.desktopSaveDir = info.downloadsDir;
          state.desktopDefaultSaveDir = info.defaultDir || info.downloadsDir;
          dom.saveDirInput.value = info.downloadsDir;
        }
      } catch {}
      if (dom.saveDirHint) {
        dom.saveDirHint.textContent = t('save_dir_hint_pc');
      }
      return;
    }

    dom.saveDirInput.readOnly = true;
    const canPickWebDir = typeof window.showDirectoryPicker === 'function';
    if (dom.btnChooseSaveDir) {
      dom.btnChooseSaveDir.disabled = !canPickWebDir;
      dom.btnChooseSaveDir.classList.toggle('opacity-40', !canPickWebDir);
    }
    if (state.webSaveDirHandle) {
      dom.saveDirInput.value = `${t('save_dir_selected_prefix')} ${state.webSaveDirHandle.name}`;
      if (dom.saveDirHint) {
        dom.saveDirHint.textContent = t('save_dir_hint_web_chosen');
      }
    } else {
      dom.saveDirInput.value = '';
      dom.saveDirInput.placeholder = t('settings_savedir_placeholder');
      if (dom.saveDirHint) {
        dom.saveDirHint.textContent = canPickWebDir
          ? t('save_dir_hint_web_pick')
          : t('save_dir_hint_web_auto');
      }
    }
  }

  // Photorealistic WebGL 3D Real-Time Earth (NASA Blue Marble + Elevated Satellite Cloud Sphere + Bump Relief)
  const earthEngine = {
    mode: 'none', // 'webgl' | '2d'
    gl: null,
    program: null,
    uniforms: null,
    rafId: 0,
    lastFrameMs: 0,
    startMs: performance.now(),
    parallaxX: 0,
    parallaxY: 0,
    targetParallaxX: 0,
    targetParallaxY: 0,
    prefersReducedMotion: false,
    texLoaded: { earth: false, clouds: false, bump: false, night: false },
    texFadeStartMs: 0
  };

  function getSolarEphemeris() {
    const now = new Date();
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 0));
    const dayOfYear = (now - startOfYear) / 86400000;
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const deg2rad = Math.PI / 180;
    const sunLon = (12 - utcHours) * 15 * deg2rad;
    const sunDecl = -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (dayOfYear + 10)) * deg2rad;
    const lonOffset = -(now.getTimezoneOffset() / 60) * 15 * deg2rad;
    const cosD = Math.cos(sunDecl);
    const sunGeo = [cosD * Math.sin(sunLon), Math.sin(sunDecl), cosD * Math.cos(sunLon)];
    return { lonOffset, sunGeo, sunLon, sunDecl };
  }

  function initWebGLEarth3D(canvas) {
    let gl = null;
    try {
      const opts = {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power'
      };
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch {
      gl = null;
    }
    if (!gl) return false;

    const vsSrc = [
      'attribute vec2 aPos;',
      'void main() {',
      '  gl_Position = vec4(aPos, 0.0, 1.0);',
      '}'
    ].join('\n');

    const fsSrc = [
      'precision highp float;',
      'uniform vec2 uResolution;',
      'uniform float uTime;',
      'uniform float uLonOffset;',
      'uniform vec3 uSunGeo;',
      'uniform vec3 uSunWorld;',
      'uniform vec2 uParallax;',
      'uniform float uLightMode;',
      'uniform float uTexReady;',
      'uniform sampler2D uEarthTex;',
      'uniform sampler2D uCloudTex;',
      'uniform sampler2D uBumpTex;',
      'uniform sampler2D uNightTex;',
      '',
      'vec3 rotTilt(vec3 v, float ct, float st) {',
      '  return vec3(v.x, v.y * ct - v.z * st, v.y * st + v.z * ct);',
      '}',
      '',
      'vec3 rotSpin(vec3 v, float ca, float sa) {',
      '  return vec3(v.x * ca + v.z * sa, v.y, -v.x * sa + v.z * ca);',
      '}',
      '',
      'vec2 dirToUV(vec3 d) {',
      '  float lat = asin(clamp(d.y, -1.0, 1.0));',
      '  float lon = atan(d.x, d.z);',
      '  return vec2(fract(lon / 6.2831853 + 0.5), clamp(0.5 - lat / 3.14159265, 0.002, 0.998));',
      '}',
      '',
      'float sampleCloud(vec2 uv) {',
      '  float c = texture2D(uCloudTex, uv).r;',
      '  return smoothstep(0.06, 0.86, c);',
      '}',
      '',
      'void main() {',
      '  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;',
      '  vec3 ro = vec3(uParallax.x * 0.20, 0.36 + uParallax.y * 0.12, 4.30);',
      '  vec3 rd = normalize(vec3(p.x - uParallax.x * 0.07, p.y - uParallax.y * 0.04, -2.0));',
      '  vec3 C = vec3(0.0, -2.18, 0.0);',
      '  float R = 2.98;',
      '  float RCloud = R * 1.0075;',
      '',
      '  vec3 oc = ro - C;',
      '  float b = dot(oc, rd);',
      '  float ocSq = dot(oc, oc);',
      '  float h = b * b - (ocSq - R * R);',
      '  float hCloud = b * b - (ocSq - RCloud * RCloud);',
      '  float topFade = 1.0 - smoothstep(0.35, 0.498, p.y);',
      '',
      '  float tilt = 0.418879;',
      '  float ct = cos(tilt);',
      '  float st = sin(tilt);',
      '  float spinAng = uLonOffset - uTime * 0.022;',
      '  float sa = sin(spinAng);',
      '  float ca = cos(spinAng);',
      '  float cloudSpin = spinAng - uTime * 0.011;',
      '  float csa = sin(cloudSpin);',
      '  float cca = cos(cloudSpin);',
      '',
      '  vec3 outCol = vec3(0.0);',
      '  float outAlpha = 0.0;',
      '',
      '  if (h >= 0.0) {',
      '    float t = -b - sqrt(h);',
      '    vec3 hitPos = ro + t * rd;',
      '    vec3 n = normalize(hitPos - C);',
      '    vec3 nGeo = normalize(rotSpin(rotTilt(n, ct, st), ca, sa));',
      '    vec2 uv = dirToUV(nGeo);',
      '',
      '    vec3 albedo = texture2D(uEarthTex, uv).rgb;',
      '    float topoC = texture2D(uBumpTex, uv).r;',
      '    vec2 epx = vec2(1.0 / 1024.0, 1.0 / 512.0);',
      '    float hR = texture2D(uBumpTex, vec2(fract(uv.x + epx.x), uv.y)).r;',
      '    float hL = texture2D(uBumpTex, vec2(fract(uv.x - epx.x), uv.y)).r;',
      '    float hD = texture2D(uBumpTex, vec2(uv.x, clamp(uv.y + epx.y, 0.002, 0.998))).r;',
      '    float hU = texture2D(uBumpTex, vec2(uv.x, clamp(uv.y - epx.y, 0.002, 0.998))).r;',
      '',
      '    float rXZ = max(0.001, length(vec2(nGeo.z, nGeo.x)));',
      '    vec3 T = vec3(nGeo.z / rXZ, 0.0, -nGeo.x / rXZ);',
      '    vec3 B = cross(nGeo, T);',
      '    vec3 nBumpGeo = normalize(nGeo - T * ((hR - hL) * 1.45) + B * ((hD - hU) * 1.45));',
      '',
      '    float ndlGeom = dot(nGeo, uSunGeo);',
      '    float ndlBump = dot(nBumpGeo, uSunGeo);',
      '    float dayTerm = smoothstep(-0.14, 0.28, ndlGeom);',
      '    float diffuse = max(0.0, ndlBump * 0.95 + 0.05) * dayTerm;',
      '',
      '    // Cloud shadow projected onto terrain/ocean surface',
      '    vec3 nCloudOnSurf = normalize(rotSpin(rotTilt(n, ct, st), cca, csa));',
      '    vec2 uvCloudSurf = dirToUV(nCloudOnSurf);',
      '    vec2 sunShadowOff = vec2(dot(uSunGeo, T), -dot(uSunGeo, B)) * 0.0045;',
      '    float cloudShadow = sampleCloud(vec2(fract(uvCloudSurf.x + sunShadowOff.x), clamp(uvCloudSurf.y + sunShadowOff.y, 0.002, 0.998)));',
      '',
      '    vec3 surfaceLit = albedo * (0.045 + 1.08 * diffuse * (1.0 - cloudShadow * 0.34));',
      '',
      '    // Ocean mask from Blue Marble chroma + flat topology',
      '    float oceanChroma = smoothstep(1.04, 1.32, albedo.b / max(0.015, max(albedo.r, albedo.g)));',
      '    float oceanMask = clamp(oceanChroma * smoothstep(0.18, 0.03, topoC), 0.0, 1.0);',
      '    vec3 V = normalize(ro - hitPos);',
      '    vec3 H = normalize(uSunWorld + V);',
      '    float spec = pow(max(0.0, dot(n, H)), 54.0) * oceanMask * dayTerm * (1.0 - cloudShadow * 0.82);',
      '    surfaceLit += vec3(0.84, 0.92, 1.0) * spec * 0.55;',
      '',
      '    // Golden atmospheric twilight scatter',
      '    float twilight = exp(-abs(ndlGeom + 0.02) * 13.5) * smoothstep(-0.28, 0.16, ndlGeom);',
      '    surfaceLit += vec3(0.95, 0.50, 0.20) * twilight * 0.14;',
      '',
      '    // NASA Black Marble city lights on night side',
      '    float nightMask = smoothstep(0.08, -0.22, ndlGeom);',
      '    vec3 nightCity = texture2D(uNightTex, uv).rgb;',
      '    surfaceLit += nightCity * nightMask * (1.0 - cloudShadow * 0.72) * mix(1.35, 0.45, uLightMode);',
      '',
      '    // Elevated rotating 3D cloud shell intersecting sphere above terrain',
      '    if (hCloud >= 0.0) {',
      '      float tc = -b - sqrt(hCloud);',
      '      vec3 hitCloud = ro + tc * rd;',
      '      vec3 nCW = normalize(hitCloud - C);',
      '      vec3 nCloudG = normalize(rotSpin(rotTilt(nCW, ct, st), cca, csa));',
      '      float cDensity = sampleCloud(dirToUV(nCloudG)) * uTexReady;',
      '      float cNdl = dot(nCW, uSunWorld);',
      '      float cDay = smoothstep(-0.18, 0.34, cNdl);',
      '      float cTwi = exp(-abs(cNdl + 0.02) * 13.0) * smoothstep(-0.30, 0.16, cNdl);',
      '      vec3 cloudCol = mix(vec3(0.055, 0.082, 0.135), vec3(0.96, 0.98, 1.0), cDay);',
      '      cloudCol += vec3(0.96, 0.56, 0.26) * cTwi * 0.38;',
      '      surfaceLit = mix(surfaceLit, cloudCol, cDensity * 0.84);',
      '    }',
      '',
      '    // Fresnel Rayleigh atmospheric limb',
      '    float ndv = max(0.0, dot(n, V));',
      '    float fresnel = pow(1.0 - ndv, 3.4);',
      '    float sunFace = smoothstep(-0.35, 0.48, dot(n, uSunWorld));',
      '    vec3 rimCol = mix(vec3(0.22, 0.46, 0.78), vec3(0.56, 0.82, 1.0), sunFace);',
      '    surfaceLit = mix(surfaceLit, rimCol, clamp(fresnel * (0.45 + 0.55 * sunFace), 0.0, 0.92));',
      '',
      '    float edgeAA = smoothstep(0.0, 0.016, h);',
      '    outCol = surfaceLit;',
      '    outAlpha = edgeAA * topFade * mix(0.32, 1.0, uTexReady);',
      '  } else {',
      '    float minDistSq = max(0.0, ocSq - b * b);',
      '    float perp = sqrt(minDistSq) - R;',
      '    if (b < 0.0 && perp >= 0.0 && perp < 0.72) {',
      '      vec3 closestDir = normalize((ro + (-b) * rd) - C);',
      '      float sunEdge = pow(max(0.0, dot(closestDir, uSunWorld) * 0.5 + 0.5), 1.6);',
      '      float glow = exp(-perp * 8.4) * (0.40 + 0.60 * sunEdge) * topFade;',
      '      vec3 haloDark = mix(vec3(0.24, 0.50, 0.82), vec3(0.58, 0.84, 1.0), sunEdge);',
      '      vec3 haloLight = mix(vec3(0.22, 0.48, 0.78), vec3(0.46, 0.74, 0.96), sunEdge);',
      '      outCol = mix(haloDark, haloLight, uLightMode);',
      '      outAlpha = clamp(glow * mix(0.86, 0.46, uLightMode), 0.0, 1.0);',
      '      if (hCloud >= 0.0) {',
      '        float tc = -b - sqrt(hCloud);',
      '        vec3 nCW = normalize((ro + tc * rd) - C);',
      '        float cRim = sampleCloud(dirToUV(normalize(rotSpin(rotTilt(nCW, ct, st), cca, csa)))) * uTexReady;',
      '        float cDay = smoothstep(-0.18, 0.34, dot(nCW, uSunWorld));',
      '        outCol = mix(outCol, mix(vec3(0.18, 0.32, 0.52), vec3(0.92, 0.96, 1.0), cDay), clamp(cRim * 0.55, 0.0, 0.65));',
      '        outAlpha = max(outAlpha, clamp(cRim * 0.52 * topFade, 0.0, 1.0));',
      '      }',
      '    }',
      '  }',
      '',
      '  gl_FragColor = vec4(outCol, outAlpha);',
      '}'
    ].join('\n');

    const compileShader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return false;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const makePlaceholderTex = (unit, r, g, b) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, 255]));
      return t;
    };

    const texEarth = makePlaceholderTex(0, 14, 42, 82);
    const texClouds = makePlaceholderTex(1, 0, 0, 0);
    const texBump = makePlaceholderTex(2, 0, 0, 0);
    const texNight = makePlaceholderTex(3, 0, 0, 0);

    const loadTex = (key, unit, tex, src) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (!earthEngine.gl || earthEngine.gl !== gl || gl.isContextLost()) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        earthEngine.texLoaded[key] = true;
        if (earthEngine.texLoaded.earth && earthEngine.texLoaded.clouds && !earthEngine.texFadeStartMs) {
          earthEngine.texFadeStartMs = performance.now();
        }
        renderRealtimeEarth();
      };
      img.src = src;
    };

    loadTex('earth', 0, texEarth, './assets/earth-blue-marble.jpg?v=22');
    loadTex('clouds', 1, texClouds, './assets/earth-clouds.jpg?v=22');
    loadTex('bump', 2, texBump, './assets/earth-topology.jpg?v=22');
    loadTex('night', 3, texNight, './assets/earth-night.jpg?v=22');

    earthEngine.mode = 'webgl';
    earthEngine.gl = gl;
    earthEngine.program = prog;
    earthEngine.uniforms = {
      uResolution: gl.getUniformLocation(prog, 'uResolution'),
      uTime: gl.getUniformLocation(prog, 'uTime'),
      uLonOffset: gl.getUniformLocation(prog, 'uLonOffset'),
      uSunGeo: gl.getUniformLocation(prog, 'uSunGeo'),
      uSunWorld: gl.getUniformLocation(prog, 'uSunWorld'),
      uParallax: gl.getUniformLocation(prog, 'uParallax'),
      uLightMode: gl.getUniformLocation(prog, 'uLightMode'),
      uTexReady: gl.getUniformLocation(prog, 'uTexReady'),
      uEarthTex: gl.getUniformLocation(prog, 'uEarthTex'),
      uCloudTex: gl.getUniformLocation(prog, 'uCloudTex'),
      uBumpTex: gl.getUniformLocation(prog, 'uBumpTex'),
      uNightTex: gl.getUniformLocation(prog, 'uNightTex')
    };

    gl.useProgram(prog);
    gl.uniform1i(earthEngine.uniforms.uEarthTex, 0);
    gl.uniform1i(earthEngine.uniforms.uCloudTex, 1);
    gl.uniform1i(earthEngine.uniforms.uBumpTex, 2);
    gl.uniform1i(earthEngine.uniforms.uNightTex, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  function renderWebGLEarth3DFrame() {
    const canvas = dom.realtimeEarthCanvas;
    const gl = earthEngine.gl;
    if (!canvas || !gl || !earthEngine.program) return;

    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width || window.innerWidth));
    const h = Math.max(160, Math.round(rect.height || Math.min(window.innerHeight * 0.46, 410)));
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const nowMs = performance.now();
    const elapsedSec = (nowMs - earthEngine.startMs) * 0.001;
    const eph = getSolarEphemeris();
    const spinAng = eph.lonOffset - elapsedSec * 0.022;
    const tilt = 0.418879; // 24 deg
    const sa = Math.sin(spinAng);
    const ca = Math.cos(spinAng);
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);

    // Transform live UTC solar vector into camera world space, then blend with upper-right studio key light
    const lStx = eph.sunGeo[0] * ca - eph.sunGeo[2] * sa;
    const lSty = eph.sunGeo[1];
    const lStz = eph.sunGeo[0] * sa + eph.sunGeo[2] * ca;
    const liveSwx = lStx;
    const liveSwy = lSty * ct + lStz * st;
    const liveSwz = -lSty * st + lStz * ct;

    const mixX = liveSwx * 0.36 + 0.42 * 0.64;
    const mixY = liveSwy * 0.36 + 0.46 * 0.64;
    const mixZ = liveSwz * 0.36 + 0.78 * 0.64;
    const mLen = Math.hypot(mixX, mixY, mixZ) || 1;
    const swx = mixX / mLen;
    const swy = mixY / mLen;
    const swz = mixZ / mLen;

    // Derive exact matching geo-space sun vector from studio-blended world sun
    const gTx = swx;
    const gTy = swy * ct - swz * st;
    const gTz = swy * st + swz * ct;
    const sgx = gTx * ca + gTz * sa;
    const sgy = gTy;
    const sgz = -gTx * sa + gTz * ca;

    earthEngine.parallaxX += (earthEngine.targetParallaxX - earthEngine.parallaxX) * 0.08;
    earthEngine.parallaxY += (earthEngine.targetParallaxY - earthEngine.parallaxY) * 0.08;

    let texReady = 0.0;
    if (earthEngine.texLoaded.earth) {
      if (earthEngine.texFadeStartMs) {
        texReady = Math.min(1.0, (nowMs - earthEngine.texFadeStartMs) / 420);
      } else {
        texReady = 1.0;
      }
    }

    const u = earthEngine.uniforms;
    gl.useProgram(earthEngine.program);
    gl.uniform2f(u.uResolution, pw, ph);
    gl.uniform1f(u.uTime, elapsedSec);
    gl.uniform1f(u.uLonOffset, eph.lonOffset);
    gl.uniform3f(u.uSunGeo, sgx, sgy, sgz);
    gl.uniform3f(u.uSunWorld, swx, swy, swz);
    gl.uniform2f(u.uParallax, earthEngine.parallaxX, earthEngine.parallaxY);
    gl.uniform1f(u.uLightMode, state.theme === 'light' ? 1.0 : 0.0);
    gl.uniform1f(u.uTexReady, texReady);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function renderRealtimeEarth2D() {
    const canvas = dom.realtimeEarthCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width || window.innerWidth));
    const h = Math.max(160, Math.round(rect.height || Math.min(window.innerHeight * 0.46, 410)));
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const isLight = state.theme === 'light';
    const R = Math.max(w * 0.62, 540);
    const cx = w / 2;
    const cy = R + Math.max(46, h * 0.22);

    const halo = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R + 44);
    halo.addColorStop(0, isLight ? 'rgba(42, 95, 138, 0.26)' : 'rgba(125, 163, 192, 0.36)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 44, Math.PI * 1.15, Math.PI * 1.85);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const grad = ctx.createRadialGradient(cx, cy - R * 0.6, R * 0.1, cx, cy - R * 0.15, R);
    grad.addColorStop(0, '#1d568c');
    grad.addColorStop(0.6, '#0d2b4e');
    grad.addColorStop(1, '#050b16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI * 1.18, Math.PI * 1.82);
    ctx.strokeStyle = isLight ? 'rgba(42, 95, 138, 0.48)' : 'rgba(165, 200, 228, 0.48)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  function isEarthSuspended() {
    return (
      document.hidden ||
      Boolean(dom.remoteControlModal && !dom.remoteControlModal.classList.contains('hidden'))
    );
  }

  function renderRealtimeEarth() {
    if (!dom.realtimeEarthCanvas || isEarthSuspended()) return;
    if (earthEngine.mode === 'webgl') {
      renderWebGLEarth3DFrame();
    } else if (earthEngine.mode === '2d') {
      renderRealtimeEarth2D();
    }
  }

  function scheduleEarthFrame() {
    if (earthEngine.mode !== 'webgl') {
      renderRealtimeEarth();
      return;
    }
    if (earthEngine.prefersReducedMotion || isEarthSuspended()) {
      if (earthEngine.rafId) {
        cancelAnimationFrame(earthEngine.rafId);
        earthEngine.rafId = 0;
      }
      if (!isEarthSuspended()) {
        renderWebGLEarth3DFrame();
      }
      return;
    }
    if (earthEngine.rafId) return;

    const tick = (now) => {
      earthEngine.rafId = 0;
      if (isEarthSuspended()) return;
      // 30fps cap (~33ms) for smooth satellite cloud drift with minimal GPU overhead
      if (now - earthEngine.lastFrameMs >= 33) {
        earthEngine.lastFrameMs = now;
        renderWebGLEarth3DFrame();
      }
      earthEngine.rafId = requestAnimationFrame(tick);
    };
    earthEngine.rafId = requestAnimationFrame(tick);
  }

  function initRealtimeEarth() {
    const canvas = dom.realtimeEarthCanvas;
    if (!canvas) return;
    earthEngine.prefersReducedMotion = Boolean(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );

    if (!initWebGLEarth3D(canvas)) {
      earthEngine.mode = '2d';
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (earthEngine.rafId) {
        cancelAnimationFrame(earthEngine.rafId);
        earthEngine.rafId = 0;
      }
      earthEngine.mode = '2d';
      renderRealtimeEarth2D();
    });

    window.addEventListener(
      'pointermove',
      (e) => {
        if (earthEngine.mode !== 'webgl' || earthEngine.prefersReducedMotion || isEarthSuspended()) return;
        const nx = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
        const ny = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
        earthEngine.targetParallaxX = Math.max(-1, Math.min(1, nx));
        earthEngine.targetParallaxY = Math.max(-1, Math.min(1, ny));
      },
      { passive: true }
    );

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderRealtimeEarth();
        scheduleEarthFrame();
      }, 200);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleEarthFrame();
    });

    if (!state.earthTimer) {
      state.earthTimer = setInterval(renderRealtimeEarth, 60000);
    }
    renderRealtimeEarth();
    scheduleEarthFrame();
  }

  function openSettingsModal() {
    const cfg = loadTurnConfig();
    dom.turnEnabled.checked = cfg.enabled;
    dom.turnUrl.value = cfg.urls;
    dom.turnUsername.value = cfg.username;
    dom.turnCredential.value = cfg.credential;
    if (dom.securityPinInput) {
      dom.securityPinInput.value = loadSecurityPin();
    }
    if (dom.btnThemeDark) dom.btnThemeDark.classList.toggle('is-active', state.theme === 'dark');
    if (dom.btnThemeLight) dom.btnThemeLight.classList.toggle('is-active', state.theme === 'light');
    if (dom.btnLangVi) dom.btnLangVi.classList.toggle('is-active', state.lang !== 'en');
    if (dom.btnLangEn) dom.btnLangEn.classList.toggle('is-active', state.lang === 'en');
    syncSaveDirModalUI();
    dom.settingsModal.classList.remove('hidden');
    dom.settingsModal.classList.add('flex');
  }

  function closeSettingsModal() {
    dom.settingsModal.classList.add('hidden');
    dom.settingsModal.classList.remove('flex');
  }

  function openQrModal() {
    updateLocalhostWarningUI();
    if (dom.shareBaseUrlInput) {
      dom.shareBaseUrlInput.value =
        state.shareBaseUrl || (isLocalhostHost(window.location.hostname) ? '' : window.location.origin);
    }
    if (state.myRoomId) {
      renderRoomIdAndQR(state.myRoomId);
    }
    dom.qrModal.classList.remove('hidden');
    dom.qrModal.classList.add('flex');
  }

  function closeQrModal() {
    dom.qrModal.classList.add('hidden');
    dom.qrModal.classList.remove('flex');
  }

  function bindEventListeners() {
    // Regenerate Room ID
    dom.btnRegenerateId.addEventListener('click', () => {
      state.manualDisconnect = true;
      cancelAutoReconnect();
      initPeerSession(true);
      showToast('Đã đổi sang Mã phòng mới', 'info');
    });

    // Copy Room ID
    dom.btnCopyId.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(state.myRoomId);
      if (ok) {
        showToast(`Đã sao chép mã: ${state.myRoomId}`, 'success');
      } else {
        showToast('Hãy bôi đen mã phòng để sao chép.', 'warning');
      }
    });

    // Copy Shareable Link
    const copyShareLinkHandler = async () => {
      if (!state.shareBaseUrl && isLocalhostHost(window.location.hostname)) {
        await detectShareBaseUrl();
      }
      const link = buildShareableLink(state.myRoomId);
      const ok = await copyTextToClipboard(link);
      if (ok) {
        if (isLocalhostHost(new URL(link).hostname)) {
          showToast('Cảnh báo: Link đang là localhost (điện thoại sẽ không mở được). Hãy nhập IP/Link công khai trong Mã QR!', 'warning');
        } else {
          showToast(`Đã sao chép Link: ${link}`, 'success');
        }
      } else {
        showToast('Không thể sao chép tự động.', 'warning');
      }
    };
    dom.btnCopyLink.addEventListener('click', copyShareLinkHandler);
    dom.btnCopyLinkModal.addEventListener('click', copyShareLinkHandler);

    // Custom Share Base URL Input inside QR Modal
    if (dom.shareBaseUrlInput) {
      dom.shareBaseUrlInput.addEventListener('input', () => {
        const val = dom.shareBaseUrlInput.value.trim();
        state.shareBaseUrl = val;
        try {
          if (val) {
            localStorage.setItem(STORAGE_KEY_SHARE_URL, val);
          } else {
            localStorage.removeItem(STORAGE_KEY_SHARE_URL);
          }
        } catch {
          // Ignore
        }
        if (state.myRoomId) {
          renderRoomIdAndQR(state.myRoomId);
        }
      });
    }

    // QR Modal & Native Share triggers
    if (dom.btnOpenQrModal) dom.btnOpenQrModal.addEventListener('click', openQrModal);
    if (dom.btnShowQrInline) dom.btnShowQrInline.addEventListener('click', openQrModal);
    if (dom.btnCloseQrModal) dom.btnCloseQrModal.addEventListener('click', closeQrModal);
    if (dom.qrModal) {
      dom.qrModal.addEventListener('click', (e) => {
        if (e.target === dom.qrModal) closeQrModal();
      });
    }

    // Focus Join Input from Header button (if present)
    if (dom.btnOpenJoinModal) {
      dom.btnOpenJoinModal.addEventListener('click', () => {
        if (state.activeConn && state.activeConn.open) {
          showToast(`Đang kết nối với ${state.remoteRoomId}. Bấm Ngắt nếu muốn đổi thiết bị.`, 'info');
          return;
        }
        if (dom.remoteRoomInput) dom.remoteRoomInput.focus();
      });
    }

    // Toggle Transfers Sheet
    dom.btnToggleTransfers.addEventListener('click', () => {
      dom.transfersDrawer.classList.toggle('hidden');
    });
    dom.btnCloseTransfers.addEventListener('click', () => {
      dom.transfersDrawer.classList.add('hidden');
    });

    // Native Share on mobile
    if (navigator.share && dom.btnNativeShare) {
      dom.btnNativeShare.classList.remove('hidden');
      dom.btnNativeShare.classList.add('flex');
      dom.btnNativeShare.addEventListener('click', async () => {
        try {
          await navigator.share({
            title: 'SyloBeam P2P',
            text: `Kết nối P2P với mình (Mã: ${state.myRoomId})`,
            url: buildShareableLink(state.myRoomId)
          });
        } catch {
          // User cancelled
        }
      });
    }

    // Manual Connect Form
    dom.connectForm.addEventListener('submit', (e) => {
      e.preventDefault();
      connectToRemotePeer(dom.remoteRoomInput.value);
    });

    // Auto-Reconnect Toggle & Cancel Reconnect
    if (dom.toggleAutoReconnect) {
      dom.toggleAutoReconnect.checked = isAutoReconnectEnabled();
      dom.toggleAutoReconnect.addEventListener('change', () => {
        setAutoReconnectEnabled(dom.toggleAutoReconnect.checked);
        if (!dom.toggleAutoReconnect.checked) {
          cancelAutoReconnect();
        }
      });
    }

    if (dom.btnCancelReconnect) {
      dom.btnCancelReconnect.addEventListener('click', () => {
        state.manualDisconnect = true;
        cancelAutoReconnect();
        setConnectionStatus('waiting', 'Đang chờ kết nối');
        showToast('Đã hủy tự động kết nối lại.', 'info');
      });
    }

    if (dom.btnClearRecentPeers) {
      dom.btnClearRecentPeers.addEventListener('click', () => {
        clearRecentPeers();
        showToast('Đã xóa danh sách thiết bị gần đây.', 'info');
      });
    }

    // Disconnect Peer (Intentional manual disconnect halts auto-reconnect)
    dom.btnDisconnectPeer.addEventListener('click', () => {
      state.manualDisconnect = true;
      cancelAutoReconnect();
      cleanupActiveConnection(true, true);
      setConnectionStatus('waiting', 'Đang chờ kết nối');
      showToast('Đã ngắt kết nối P2P', 'info');
    });

    // Consent Modal Actions
    dom.btnAcceptConsent.addEventListener('click', () => {
      acceptPendingConsent();
    });
    dom.btnRejectConsent.addEventListener('click', () => {
      rejectPendingConsent('Thiết bị đầu kia đã từ chối kết nối.');
    });

    // PIN Challenge Form (Initiator entering remote peer's PIN)
    dom.btnClosePinChallenge.addEventListener('click', () => {
      state.manualDisconnect = true;
      cancelAutoReconnect();
      closePinChallengeModal();
      cleanupActiveConnection(true, true);
      setConnectionStatus('waiting', 'Đang chờ kết nối');
    });

    dom.pinChallengeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pending = state.pendingPinChallenge;
      if (!pending || !pending.conn || !pending.conn.open) {
        closePinChallengeModal();
        showToast('Kết nối đã hết hạn, vui lòng thử lại.', 'warning');
        return;
      }
      const pin = (dom.pinChallengeInput.value || '').trim();
      if (!pin) return;
      const pinHash = await sha256HexFromText(`${pin}:${pending.nonce}`);
      closePinChallengeModal();
      try {
        pending.conn.send({
          type: 'consent-pin-submit',
          nonce: pending.nonce,
          pinHash,
          profile: state.myProfile
        });
        setConnectionStatus('connecting', `Đang chờ ${pending.remoteRoomId} đồng ý...`);
      } catch {
        showToast('Không thể gửi mã PIN, vui lòng thử lại.', 'error');
      }
    });

    // PairDrop One-Tap Avatar Click & File Select Button
    dom.btnPeerAvatarSend.addEventListener('click', () => {
      dom.fileInput.click();
    });
    dom.btnTriggerFileSelect.addEventListener('click', () => {
      dom.fileInput.click();
    });

    // Right-click on Peer Avatar opens Instant Text Modal
    dom.btnPeerAvatarSend.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.isPeerAuthorized) return;
      dom.textModal.classList.remove('hidden');
      dom.textModal.classList.add('flex');
      dom.textMessageInput.focus();
    });

    // Instant Text Modal
    dom.btnOpenTextModal.addEventListener('click', () => {
      if (!state.isPeerAuthorized) {
        showToast('Đang chờ thiết bị kia đồng ý kết nối!', 'warning');
        return;
      }
      dom.textModal.classList.remove('hidden');
      dom.textModal.classList.add('flex');
      dom.textMessageInput.focus();
    });
    const closeTextModal = () => {
      dom.textModal.classList.add('hidden');
      dom.textModal.classList.remove('flex');
    };
    dom.btnCloseTextModal.addEventListener('click', closeTextModal);
    dom.btnCancelText.addEventListener('click', closeTextModal);

    dom.sendTextForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = dom.textMessageInput.value.trim();
      if (!text) return;
      if (!state.activeConn || !state.activeConn.open || !state.isPeerAuthorized) {
        showToast('Chưa có kết nối P2P đã xác thực.', 'warning');
        return;
      }
      state.activeConn.send({ type: 'text-message', text });
      dom.textMessageInput.value = '';
      closeTextModal();
      showToast('Đã gửi văn bản / link tức thì!', 'success');
    });

    // Received Text Modal
    dom.btnCloseReceivedText.addEventListener('click', () => {
      dom.receivedTextModal.classList.add('hidden');
      dom.receivedTextModal.classList.remove('flex');
    });
    dom.btnCopyReceivedText.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(dom.receivedTextContent.textContent || '');
      if (ok) {
        showToast('Đã sao chép nội dung!', 'success');
      } else {
        showToast('Không thể sao chép tự động.', 'warning');
      }
    });

    // File Input Change
    dom.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        enqueueFilesForSending(e.target.files);
        e.target.value = '';
      }
    });

    // Global Drag & Drop on Radar Stage
    ['dragenter', 'dragover'].forEach((eventName) => {
      window.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dom.btnPeerAvatarSend.classList.add('drop-active');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      window.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dom.btnPeerAvatarSend.classList.remove('drop-active');
      });
    });

    window.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        enqueueFilesForSending(dt.files);
      }
    });

    // Download All & Open Downloads Folder (Desktop)
    if (dom.btnDownloadAll) {
      dom.btnDownloadAll.addEventListener('click', () => {
        downloadAllCompletedFiles();
      });
    }
    if (dom.btnOpenDownloads) {
      dom.btnOpenDownloads.addEventListener('click', () => {
        if (IS_DESKTOP_APP && window.swiftdropDesktop && window.swiftdropDesktop.openDownloadsFolder) {
          window.swiftdropDesktop.openDownloadsFolder('').catch(() => {});
        }
      });
    }

    // Clear completed transfers
    dom.btnClearCompleted.addEventListener('click', () => {
      state.transferRecords.forEach((record, id) => {
        if (record.status === 'completed' || record.status === 'error') {
          if (record.blobUrl) {
            try {
              URL.revokeObjectURL(record.blobUrl);
            } catch {}
          }
          if (record.element) record.element.remove();
          state.transferRecords.delete(id);
        }
      });
      updateTransferCountBadge();
      updateDownloadAllButtonUI();
    });

    // Settings Modal
    dom.btnOpenSettings.addEventListener('click', openSettingsModal);
    dom.btnConfigureTurnInline.addEventListener('click', openSettingsModal);
    dom.btnCloseSettings.addEventListener('click', closeSettingsModal);
    dom.btnCancelSettings.addEventListener('click', closeSettingsModal);

    // Dual Theme Toggles (Header + Settings Modal)
    if (dom.btnToggleTheme) {
      dom.btnToggleTheme.addEventListener('click', () => {
        const next = state.theme === 'light' ? 'dark' : 'light';
        applyTheme(next);
        showToast(next === 'light' ? t('toast_theme_light') : t('toast_theme_dark'), 'info');
      });
    }
    if (dom.btnThemeDark) {
      dom.btnThemeDark.addEventListener('click', () => applyTheme('dark'));
    }
    if (dom.btnThemeLight) {
      dom.btnThemeLight.addEventListener('click', () => applyTheme('light'));
    }
    if (dom.btnLangVi) {
      dom.btnLangVi.addEventListener('click', () => {
        applyLanguage('vi');
        showToast(t('toast_lang_changed'), 'info');
      });
    }
    if (dom.btnLangEn) {
      dom.btnLangEn.addEventListener('click', () => {
        applyLanguage('en');
        showToast(t('toast_lang_changed'), 'info');
      });
    }

    // Custom Save Folder Controls inside Settings Modal
    if (dom.btnChooseSaveDir) {
      dom.btnChooseSaveDir.addEventListener('click', async () => {
        if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.chooseDownloadDir === 'function') {
          try {
            const res = await window.swiftdropDesktop.chooseDownloadDir();
            if (res && res.downloadsDir && !res.cancelled) {
              state.desktopSaveDir = res.downloadsDir;
              if (dom.saveDirInput) dom.saveDirInput.value = res.downloadsDir;
              showToast(`Đã chọn thư mục lưu: ${getPathFolderName(res.downloadsDir) || res.downloadsDir}`, 'success');
            }
          } catch {
            showToast('Không thể mở hộp thoại chọn thư mục.', 'warning');
          }
          return;
        }
        if (typeof window.showDirectoryPicker === 'function') {
          try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            if (handle) {
              state.webSaveDirHandle = handle;
              await saveWebSaveDirHandle(handle);
              await syncSaveDirModalUI();
              showToast(`Đã chọn thư mục lưu: ${handle.name}`, 'success');
            }
          } catch (err) {
            if (!err || err.name !== 'AbortError') {
              showToast('Không thể chọn thư mục trên trình duyệt này.', 'warning');
            }
          }
        } else {
          showToast('Trình duyệt hiện tại tự lưu vào thư mục Downloads mặc định.', 'info');
        }
      });
    }
    if (dom.btnResetSaveDir) {
      dom.btnResetSaveDir.addEventListener('click', async () => {
        if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.setDownloadDir === 'function') {
          try {
            const res = await window.swiftdropDesktop.setDownloadDir('');
            if (res && res.ok) {
              state.desktopSaveDir = res.downloadsDir || '';
              if (dom.saveDirInput) dom.saveDirInput.value = res.downloadsDir || '';
              showToast('Đã khôi phục thư mục lưu Downloads mặc định.', 'info');
            }
          } catch {}
          return;
        }
        state.webSaveDirHandle = null;
        await saveWebSaveDirHandle(null);
        await syncSaveDirModalUI();
        showToast('Đã khôi phục thư mục lưu Downloads mặc định.', 'info');
      });
    }

    dom.btnParseTurnJson.addEventListener('click', () => {
      const raw = dom.turnJsonPaste.value.trim();
      if (!raw) {
        showToast('Hãy dán chuỗi JSON iceServers vào ô trước.', 'warning');
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.iceServers || [parsed];
        const turnUrls = [];
        let username = '';
        let credential = '';

        list.forEach((entry) => {
          const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls || entry.url];
          urls.forEach((u) => {
            if (u && (u.startsWith('turn:') || u.startsWith('turns:'))) {
              turnUrls.push(u);
            }
          });
          if (entry.username && !username) username = entry.username;
          if (entry.credential && !credential) credential = entry.credential;
        });

        if (turnUrls.length === 0) {
          showToast('Không tìm thấy URL turn: hoặc turns: nào trong JSON.', 'warning');
          return;
        }

        dom.turnEnabled.checked = true;
        dom.turnUrl.value = turnUrls.join(', ');
        dom.turnUsername.value = username;
        dom.turnCredential.value = credential;
        showToast(`Đã trích xuất ${turnUrls.length} TURN URL!`, 'success');
      } catch {
        showToast('Định dạng JSON không hợp lệ.', 'error');
      }
    });

    dom.btnResetTurn.addEventListener('click', () => {
      dom.turnEnabled.checked = false;
      dom.turnUrl.value = '';
      dom.turnUsername.value = '';
      dom.turnCredential.value = '';
      dom.turnJsonPaste.value = '';
      if (dom.securityPinInput) dom.securityPinInput.value = '';
      saveTurnConfig({ enabled: false, urls: '', username: '', credential: '' });
      saveSecurityPin('');
      updateTurnIndicatorUI();
      showToast('Đã khôi phục cài đặt mặc định.', 'info');
    });

    dom.turnSettingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (IS_DESKTOP_APP && dom.saveDirInput && window.swiftdropDesktop && typeof window.swiftdropDesktop.setDownloadDir === 'function') {
        try {
          const dirRes = await window.swiftdropDesktop.setDownloadDir(dom.saveDirInput.value.trim());
          if (!dirRes || !dirRes.ok) {
            showToast(`Đường dẫn thư mục không hợp lệ: ${(dirRes && dirRes.error) || ''}`, 'warning');
            return;
          }
          state.desktopSaveDir = dirRes.downloadsDir || '';
          dom.saveDirInput.value = state.desktopSaveDir;
        } catch {
          showToast('Không thể cập nhật thư mục lưu file.', 'warning');
          return;
        }
      }
      const config = {
        enabled: dom.turnEnabled.checked,
        urls: dom.turnUrl.value.trim(),
        username: dom.turnUsername.value.trim(),
        credential: dom.turnCredential.value.trim()
      };
      if (dom.securityPinInput) {
        saveSecurityPin(dom.securityPinInput.value);
      }
      saveTurnConfig(config);
      closeSettingsModal();
      initPeerSession(false);
      showToast('Đã lưu cài đặt giao diện, lưu trữ & mạng!', 'success');
    });

    // Image Preview Modal Close
    dom.btnClosePreview.addEventListener('click', closeImagePreviewModal);
    dom.imagePreviewModal.addEventListener('click', (e) => {
      if (e.target === dom.imagePreviewModal) closeImagePreviewModal();
    });

    // Resume Signaling & Auto-Reconnect immediately when returning from mobile background / switching 4G tower
    const handleNetworkRecovery = () => {
      if (document.visibilityState === 'hidden') return;
      if (!state.inboxWs || state.inboxWs.readyState > 1) {
        initRelayInbox();
      }
      if (state.peer && !state.peer.destroyed && state.peer.disconnected) {
        try {
          state.peer.reconnect();
        } catch {
          // Ignore
        }
      }
      if (
        !state.activeConn &&
        !state.manualDisconnect &&
        state.isInitiator &&
        state.lastConnectedPeerId &&
        isAutoReconnectEnabled()
      ) {
        scheduleAutoReconnect();
      }
    };
    document.addEventListener('visibilitychange', handleNetworkRecovery);
    window.addEventListener('online', handleNetworkRecovery);

    window.addEventListener('beforeunload', () => {
      cleanupActiveConnection(true, true);
      closeRelayInbox();
    });

    // PWA Installation Prompt (Never show inside Desktop App / Standalone PWA)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      const isStandalone =
        IS_DESKTOP_APP ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        Boolean(window.navigator && window.navigator.standalone);
      if (isStandalone) {
        if (dom.btnInstallPwa) {
          dom.btnInstallPwa.classList.add('hidden');
          dom.btnInstallPwa.classList.remove('inline-flex', 'flex');
        }
        return;
      }
      state.deferredPwaPrompt = e;
      if (dom.btnInstallPwa) {
        dom.btnInstallPwa.classList.remove('hidden');
        dom.btnInstallPwa.classList.add('inline-flex');
      }
    });

    dom.btnInstallPwa.addEventListener('click', async () => {
      if (!state.deferredPwaPrompt) return;
      state.deferredPwaPrompt.prompt();
      await state.deferredPwaPrompt.userChoice;
      state.deferredPwaPrompt = null;
      dom.btnInstallPwa.classList.add('hidden');
      dom.btnInstallPwa.classList.remove('inline-flex');
    });
  }

  // ============================================================================
  // 15. BOOTSTRAP APPLICATION
  // ============================================================================
  function checkUrlAutoJoinParam() {
    const params = new URLSearchParams(window.location.search);
    const joinParam = params.get('join');
    if (joinParam) {
      const cleaned = sanitizeRoomId(joinParam);
      if (cleaned.length >= 4) {
        state.pendingAutoJoinId = cleaned;
        dom.remoteRoomInput.value = cleaned;
      }
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js')
          .then((reg) => {
            if (reg && typeof reg.update === 'function') {
              reg.update().catch(() => {});
            }
          })
          .catch(() => {});
      });
    }
  }

  async function initDesktopHardwareTelemetry() {
    if (!IS_DESKTOP_APP) return;
    if (dom.btnDownloadWindowsApp) {
      dom.btnDownloadWindowsApp.classList.add('hidden');
      dom.btnDownloadWindowsApp.classList.remove('flex', 'inline-flex');
    }
    if (dom.btnInstallPwa) {
      dom.btnInstallPwa.classList.add('hidden');
      dom.btnInstallPwa.classList.remove('flex', 'inline-flex');
    }
    if (window.swiftdropDesktop && typeof window.swiftdropDesktop.getHardwareInfo === 'function') {
      try {
        const hw = await window.swiftdropDesktop.getHardwareInfo();
        if (hw && hw.downloadsDir) {
          state.desktopSaveDir = hw.downloadsDir;
        }
        if (hw && hw.hardwareEncoder) {
          const disp = hw.display ? `${hw.display.width}×${hw.display.height}` : '';
          const label = `${hw.hardwareEncoder}${disp ? ` • ${disp}` : ''}`;
          if (dom.desktopHwBadge) {
            dom.desktopHwBadge.textContent = label;
            dom.desktopHwBadge.classList.remove('hidden');
          }
          if (dom.iceModeSummary) {
            dom.iceModeSummary.textContent = `${hw.hardwareEncoder} (${hw.primaryGpu || 'GPU'}) • 60Hz Ready`;
          }
        }
      } catch {}
    }
  }

  function bootstrap() {
    applyTheme(loadSavedTheme(), { persist: false, redrawEarth: false });
    applyLanguage(loadSavedLanguage(), { persist: false });
    initRealtimeEarth();
    loadWebSaveDirHandle();
    state.myProfile = detectDeviceProfile();
    if (dom.myDeviceDisplayName) {
      dom.myDeviceDisplayName.textContent = state.myProfile.label;
    }
    updateTurnIndicatorUI();
    initDesktopHardwareTelemetry();
    if (dom.btnDownloadWindowsApp && isTouchMobileOrTablet()) {
      dom.btnDownloadWindowsApp.classList.add('hidden');
      dom.btnDownloadWindowsApp.classList.remove('flex', 'inline-flex');
    }
    renderRecentPeersUI();
    checkUrlAutoJoinParam();
    bindEventListeners();
    bindRemoteControlListeners();
    if (IS_DESKTOP_APP && window.swiftdropDesktop && typeof window.swiftdropDesktop.onEmergencyStop === 'function') {
      window.swiftdropDesktop.onEmergencyStop(() => revokeRemoteControl(true));
    }
    if (IS_DESKTOP_APP) {
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.altKey && e.key === 'Escape') {
          revokeRemoteControl(true);
        }
      });
    }
    registerServiceWorker();
    initPeerSession(false);
    detectShareBaseUrl();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
