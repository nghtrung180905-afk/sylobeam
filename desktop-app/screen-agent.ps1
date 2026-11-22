param(
  [int]$Width = 1600,
  [int]$Height = 900,
  [int]$Fps = 60,
  [int]$Quality = 78,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'

$csharpCode = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class SwiftDropRingStreamer {
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;
    private const int COLORONCOLOR = 3;
    private const int HALFTONE = 4;
    private const int CURSOR_SHOWING = 0x00000001;
    private const int SLOT_COUNT = 4;
    private const int WORKER_COUNT = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO {
        public BITMAPINFOHEADER bmiHeader;
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] private static extern IntPtr CopyIcon(IntPtr hIcon);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr hObject);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);
    [DllImport("gdi32.dll", SetLastError = true)] private static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);
    [DllImport("gdi32.dll", SetLastError = true)] private static extern bool StretchBlt(IntPtr hdcDest, int nXOriginDest, int nYOriginDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXOriginSrc, int nYOriginSrc, int nWidthSrc, int nHeightSrc, int dwRop);
    [DllImport("gdi32.dll")] private static extern int SetStretchBltMode(IntPtr hdc, int iStretchMode);
    [DllImport("gdi32.dll")] private static extern bool GdiFlush();
    [DllImport("winmm.dll")] private static extern uint timeBeginPeriod(uint uMilliseconds);
    [DllImport("winmm.dll")] private static extern uint timeEndPeriod(uint uMilliseconds);

    private const byte FLAG_KEYFRAME = 0;
    private const byte FLAG_DELTA = 1;
    private const byte FLAG_REST_HD = 2;
    private const byte FLAG_MOTION = 4;

    private sealed class RingSlot {
        public int Index;
        public IntPtr hDC;
        public IntPtr hDib;
        public IntPtr Bits;
        public int Stride;
        public Bitmap Bmp;
        public int State; // 0=Idle, 1=Capturing, 2=Ready, 3=Encoding
        public long Seq;
        public int Width;
        public int Height;
        public byte CursorVis;
        public ushort CursorXNorm;
        public ushort CursorYNorm;
    }

    private static volatile int _targetW;
    private static volatile int _targetH;
    private static volatile int _targetFps;
    private static volatile int _jpegQuality;
    private static volatile int _motionQuality = 46;
    private static volatile bool _running = true;

    private static readonly object _ringLock = new object();
    private static readonly object _deltaLock = new object();
    private static readonly object _outLock = new object();
    private static RingSlot[] _slots = new RingSlot[SLOT_COUNT];
    private static long _captureSeq = 0;
    private static long _lastWrittenSeq = 0;
    private static byte[] _prevPixels = null;
    private static byte[] _curPixels = null;
    private static int _prevPixW = 0;
    private static int _prevPixH = 0;
    private static byte[] _cachedStaticJpeg = null;
    private static int _cachedPixW = 0;
    private static int _cachedPixH = 0;
    private static bool _needsRestFrame = false;
    private static long _lastEmitTickMs = 0;
    private static ushort _prevCursorX = 0;
    private static ushort _prevCursorY = 0;
    private static Stopwatch _clock = Stopwatch.StartNew();
    private static Stream _outStream;
    private static ImageCodecInfo _jpegCodec;

    private static ImageCodecInfo GetJpegEncoder() {
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
        }
        return null;
    }

    private static void AllocateSlots(int dstW, int dstH) {
        DisposeSlots();
        int stride = ((dstW * 3 + 3) & ~3);
        for (int i = 0; i < SLOT_COUNT; i++) {
            BITMAPINFO bmi = new BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = dstW;
            bmi.bmiHeader.biHeight = -dstH; // Top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 24;

            IntPtr bits;
            IntPtr hDC = CreateCompatibleDC(IntPtr.Zero);
            IntPtr hDib = CreateDIBSection(hDC, ref bmi, 0, out bits, IntPtr.Zero, 0);
            SelectObject(hDC, hDib);
            SetStretchBltMode(hDC, COLORONCOLOR);

            RingSlot slot = new RingSlot();
            slot.Index = i;
            slot.hDC = hDC;
            slot.hDib = hDib;
            slot.Bits = bits;
            slot.Stride = stride;
            slot.Bmp = new Bitmap(dstW, dstH, stride, PixelFormat.Format24bppRgb, bits);
            slot.Width = dstW;
            slot.Height = dstH;
            slot.State = 0;
            slot.Seq = 0;
            _slots[i] = slot;
        }
    }

    private static void DisposeSlots() {
        for (int i = 0; i < SLOT_COUNT; i++) {
            RingSlot s = _slots[i];
            if (s != null) {
                if (s.Bmp != null) { try { s.Bmp.Dispose(); } catch {} }
                if (s.hDib != IntPtr.Zero) { try { DeleteObject(s.hDib); } catch {} }
                if (s.hDC != IntPtr.Zero) { try { DeleteDC(s.hDC); } catch {} }
                _slots[i] = null;
            }
        }
    }

    private static void DrawScaledCursor(IntPtr targetHdc, int srcW, int srcH, int dstW, int dstH, out byte curVis, out ushort cxNorm, out ushort cyNorm) {
        curVis = 0;
        cxNorm = 0;
        cyNorm = 0;
        try {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & CURSOR_SHOWING) == 0) return;

            int rawX = ci.ptScreenPos.x;
            int rawY = ci.ptScreenPos.y;
            if (rawX < 0 || rawY < 0 || rawX > srcW || rawY > srcH) return;

            curVis = 1;
            double nx = srcW > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawX / srcW)) : 0.0;
            double ny = srcH > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawY / srcH)) : 0.0;
            cxNorm = (ushort)Math.Round(nx * 65535.0);
            cyNorm = (ushort)Math.Round(ny * 65535.0);

            int x = rawX;
            int y = rawY;
            IntPtr hIcon = CopyIcon(ci.hCursor);
            if (hIcon == IntPtr.Zero) return;
            try {
                ICONINFO ii;
                if (GetIconInfo(hIcon, out ii)) {
                    try {
                        x -= ii.xHotspot;
                        y -= ii.yHotspot;
                    } finally {
                        if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                        if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                    }
                }
                double sx = (double)dstW / srcW;
                double sy = (double)dstH / srcH;
                int dx = (int)Math.Round(x * sx);
                int dy = (int)Math.Round(y * sy);
                int cw = Math.Max(14, (int)Math.Round(32 * sx));
                int ch = Math.Max(14, (int)Math.Round(32 * sy));
                DrawIconEx(targetHdc, dx, dy, hIcon, cw, ch, 0, IntPtr.Zero, 0x0003);
            } finally {
                DestroyIcon(hIcon);
            }
        } catch {
            // Ignore transient cursor handle failure
        }
    }

    private static void FillTrailer(byte[] trailer, byte flags, byte curVis, ushort cxNorm, ushort cyNorm) {
        trailer[0] = flags;
        trailer[1] = curVis;
        trailer[2] = (byte)(cxNorm & 0xFF);
        trailer[3] = (byte)((cxNorm >> 8) & 0xFF);
        trailer[4] = (byte)(cyNorm & 0xFF);
        trailer[5] = (byte)((cyNorm >> 8) & 0xFF);
        trailer[6] = (byte)'S';
        trailer[7] = (byte)'D';
    }

    private static void DrawStatusFallback(Bitmap bmp, int w, int h, string reason) {
        using (Graphics g = Graphics.FromImage(bmp)) {
            g.Clear(Color.FromArgb(8, 9, 11));
            using (Brush accent = new SolidBrush(Color.FromArgb(42, 125, 163, 192))) {
                g.FillEllipse(accent, w / 2 - 120, h / 2 - 120, 240, 240);
            }
            using (Font titleFont = new Font("Segoe UI", 20, FontStyle.Bold))
            using (Font subFont = new Font("Segoe UI", 11, FontStyle.Regular))
            using (Brush whiteBrush = new SolidBrush(Color.FromArgb(244, 245, 247)))
            using (Brush mutedBrush = new SolidBrush(Color.FromArgb(136, 141, 150)))
            using (StringFormat fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {
                g.DrawString("SwiftDrop 60Hz — Dang cho quyen Desktop Windows", titleFont, whiteBrush, new RectangleF(32, h / 2 - 44, w - 64, 40), fmt);
                g.DrawString(reason, subFont, mutedBrush, new RectangleF(32, h / 2 + 4, w - 64, 36), fmt);
            }
        }
    }

    private static bool WriteFrameWithTrailer(long capSeq, byte[] jpegBuf, int jpegLen, byte[] trailer) {
        int totalLen = jpegLen + 8;
        lock (_outLock) {
            if (!_running || capSeq <= _lastWrittenSeq) {
                return false;
            }
            _lastWrittenSeq = capSeq;
            byte[] lenHdr = new byte[4];
            lenHdr[0] = (byte)(totalLen & 0xFF);
            lenHdr[1] = (byte)((totalLen >> 8) & 0xFF);
            lenHdr[2] = (byte)((totalLen >> 16) & 0xFF);
            lenHdr[3] = (byte)((totalLen >> 24) & 0xFF);
            _outStream.Write(lenHdr, 0, 4);
            _outStream.Write(jpegBuf, 0, jpegLen);
            _outStream.Write(trailer, 0, 8);
            _outStream.Flush();
            return true;
        }
    }

    private static void PrepareFullFrameAction(
        RingSlot picked,
        out bool shouldEmit,
        out byte[] cachedJpeg,
        out byte flags,
        out int encQuality,
        out bool cacheResult
    ) {
        shouldEmit = false;
        cachedJpeg = null;
        flags = FLAG_KEYFRAME;
        int baseQ = _jpegQuality;
        encQuality = baseQ;
        cacheResult = false;

        int w = picked.Width;
        int h = picked.Height;
        int stride = picked.Stride;
        int totalBytes = stride * h;

        lock (_deltaLock) {
            if (_curPixels == null || _curPixels.Length != totalBytes) {
                _curPixels = new byte[totalBytes];
            }
            Marshal.Copy(picked.Bits, _curPixels, 0, totalBytes);

            long nowMs = _clock.ElapsedMilliseconds;
            bool forceReset = (_prevPixels == null || _prevPixels.Length != totalBytes || _prevPixW != w || _prevPixH != h);

            if (forceReset) {
                _prevPixels = _curPixels;
                _curPixels = new byte[totalBytes];
                _prevPixW = w;
                _prevPixH = h;
                _cachedStaticJpeg = null;
                _cachedPixW = 0;
                _cachedPixH = 0;
                _needsRestFrame = false;
                _lastEmitTickMs = nowMs;
                _prevCursorX = picked.CursorXNorm;
                _prevCursorY = picked.CursorYNorm;
                shouldEmit = true;
                flags = FLAG_KEYFRAME;
                encQuality = Math.Min(84, baseQ + 8);
                cacheResult = true;
                return;
            }

            // Fast 8x8 pixel grid sampling to detect motion intensity & static state
            int changed = 0;
            int samples = 0;
            byte[] prev = _prevPixels;
            byte[] cur = _curPixels;
            for (int y = 0; y < h; y += 8) {
                int rowOff = y * stride;
                for (int x = 0; x < w; x += 8) {
                    samples++;
                    int idx = rowOff + x * 3;
                    int dr = cur[idx] - prev[idx]; if (dr < 0) dr = -dr;
                    int dg = cur[idx + 1] - prev[idx + 1]; if (dg < 0) dg = -dg;
                    int db = cur[idx + 2] - prev[idx + 2]; if (db < 0) db = -db;
                    if (dr + dg + db > 24) {
                        changed++;
                    }
                }
            }

            // Swap pixel buffers O(1)
            _prevPixels = cur;
            _curPixels = prev;

            bool cursorMoved = (picked.CursorVis != 0 && (Math.Abs((int)picked.CursorXNorm - (int)_prevCursorX) > 20 || Math.Abs((int)picked.CursorYNorm - (int)_prevCursorY) > 20));
            _prevCursorX = picked.CursorXNorm;
            _prevCursorY = picked.CursorYNorm;

            if (changed == 0 && !cursorMoved) {
                if (_needsRestFrame) {
                    _needsRestFrame = false;
                    _lastEmitTickMs = nowMs;
                    shouldEmit = true;
                    flags = FLAG_REST_HD;
                    encQuality = Math.Min(84, Math.Max(baseQ + 14, 78));
                    cacheResult = true;
                    return;
                }
                if (_cachedStaticJpeg != null && _cachedPixW == w && _cachedPixH == h) {
                    if ((nowMs - _lastEmitTickMs) < 24) {
                        shouldEmit = false;
                        return;
                    }
                    _lastEmitTickMs = nowMs;
                    shouldEmit = true;
                    cachedJpeg = _cachedStaticJpeg;
                    flags = FLAG_REST_HD;
                    return;
                }
                _lastEmitTickMs = nowMs;
                shouldEmit = true;
                flags = FLAG_REST_HD;
                encQuality = Math.Min(84, baseQ + 12);
                cacheResult = true;
                return;
            }

            _cachedStaticJpeg = null;
            _needsRestFrame = true;
            _lastEmitTickMs = nowMs;
            shouldEmit = true;

            int changedPct = (changed * 100) / Math.Max(1, samples);
            if (changedPct >= 12) {
                flags = FLAG_MOTION;
                encQuality = Math.Max(36, Math.Min(_motionQuality, baseQ - 10));
            } else {
                flags = FLAG_KEYFRAME;
                encQuality = baseQ;
            }
        }
    }

    private static void WorkerLoop() {
        MemoryStream ms = new MemoryStream(256 * 1024);
        EncoderParameters ep = null;
        int lastQ = -1;
        byte[] trailer = new byte[8];

        try {
            while (_running) {
                RingSlot picked = null;
                long pickedSeq = 0;

                lock (_ringLock) {
                    while (_running) {
                        int bestIdx = -1;
                        long bestSeq = -1;
                        for (int i = 0; i < SLOT_COUNT; i++) {
                            if (_slots[i] != null && _slots[i].State == 2 && _slots[i].Seq > bestSeq) {
                                bestSeq = _slots[i].Seq;
                                bestIdx = i;
                            }
                        }
                        if (bestIdx >= 0) {
                            picked = _slots[bestIdx];
                            picked.State = 3; // Encoding
                            pickedSeq = bestSeq;
                            break;
                        }
                        Monitor.Wait(_ringLock, 50);
                    }
                }

                if (!_running || picked == null) break;

                try {
                    bool shouldEmit, cacheResult;
                    byte[] cachedJpeg;
                    byte flags;
                    int encQ;
                    PrepareFullFrameAction(picked, out shouldEmit, out cachedJpeg, out flags, out encQ, out cacheResult);
                    if (!shouldEmit) {
                        continue;
                    }

                    FillTrailer(trailer, flags, picked.CursorVis, picked.CursorXNorm, picked.CursorYNorm);

                    if (cachedJpeg != null) {
                        WriteFrameWithTrailer(pickedSeq, cachedJpeg, cachedJpeg.Length, trailer);
                        continue;
                    }

                    if (ep == null || encQ != lastQ) {
                        if (ep != null) ep.Dispose();
                        ep = new EncoderParameters(1);
                        ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)encQ);
                        lastQ = encQ;
                    }

                    ms.SetLength(0);
                    picked.Bmp.Save(ms, _jpegCodec, ep);
                    int jpegLen = (int)ms.Length;

                    if (flags == FLAG_MOTION) {
                        if (jpegLen > 48000 && _motionQuality > 36) _motionQuality = Math.Max(36, _motionQuality - 4);
                        else if (jpegLen < 28000 && _motionQuality < _jpegQuality - 10) _motionQuality = Math.Min(_jpegQuality - 10, _motionQuality + 2);
                    }

                    if (cacheResult) {
                        byte[] snap = new byte[jpegLen];
                        Buffer.BlockCopy(ms.GetBuffer(), 0, snap, 0, jpegLen);
                        lock (_deltaLock) {
                            if (_prevPixW == picked.Width && _prevPixH == picked.Height) {
                                _cachedStaticJpeg = snap;
                                _cachedPixW = picked.Width;
                                _cachedPixH = picked.Height;
                            }
                        }
                    }

                    WriteFrameWithTrailer(pickedSeq, ms.GetBuffer(), jpegLen, trailer);
                } catch {
                    // Ignore slot encode exception on teardown/resize
                } finally {
                    lock (_ringLock) {
                        if (picked != null && picked.State == 3) {
                            picked.State = 0; // Idle
                            Monitor.PulseAll(_ringLock);
                        }
                    }
                }
            }
        } finally {
            if (ep != null) ep.Dispose();
            ms.Dispose();
        }
    }

    private static void StartStdinConfigWatcher() {
        Thread t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line == "QUIT") {
                        _running = false;
                        lock (_ringLock) { Monitor.PulseAll(_ringLock); }
                        break;
                    }
                    if (line.StartsWith("CFG|")) {
                        string[] parts = line.Split('|');
                        if (parts.Length >= 5) {
                            int nw, nh, nfps, nq;
                            if (int.TryParse(parts[1], out nw) && nw >= 320 && nw <= 3840) _targetW = nw;
                            if (int.TryParse(parts[2], out nh) && nh >= 240 && nh <= 2160) _targetH = nh;
                            if (int.TryParse(parts[3], out nfps) && nfps >= 5 && nfps <= 60) _targetFps = nfps;
                            if (int.TryParse(parts[4], out nq) && nq >= 40 && nq <= 95) _jpegQuality = nq;
                        }
                    }
                }
            } catch {}
            _running = false;
            lock (_ringLock) { Monitor.PulseAll(_ringLock); }
        });
        t.IsBackground = true;
        t.Start();
    }

    public static void Run(int initW, int initH, int initFps, int initQuality, bool singleShot) {
        try { SetProcessDPIAware(); } catch {}
        bool timerSet = false;
        try { timerSet = (timeBeginPeriod(1) == 0); } catch {}

        _targetW = Math.Max(320, Math.Min(3840, initW));
        _targetH = Math.Max(240, Math.Min(2160, initH));
        _targetFps = Math.Max(5, Math.Min(60, initFps));
        _jpegQuality = Math.Max(40, Math.Min(95, initQuality));
        _motionQuality = Math.Max(38, _jpegQuality - 16);

        _jpegCodec = GetJpegEncoder();
        if (_jpegCodec == null) {
            if (timerSet) { try { timeEndPeriod(1); } catch {} }
            return;
        }
        _outStream = Console.OpenStandardOutput();

        if (!singleShot) {
            StartStdinConfigWatcher();
        }

        Thread[] workers = null;
        if (!singleShot) {
            workers = new Thread[WORKER_COUNT];
            for (int i = 0; i < WORKER_COUNT; i++) {
                workers[i] = new Thread(WorkerLoop);
                workers[i].IsBackground = true;
                workers[i].Priority = ThreadPriority.AboveNormal;
                workers[i].Start();
            }
        }

        Stopwatch sw = new Stopwatch();
        int curSlotW = 0, curSlotH = 0;
        bool loggedUnavailable = false;

        try {
            while (_running) {
                sw.Restart();

                int rawW = GetSystemMetrics(SM_CXSCREEN);
                int rawH = GetSystemMetrics(SM_CYSCREEN);
                int srcW = rawW > 0 ? rawW : 1920;
                int srcH = rawH > 0 ? rawH : 1080;

                int reqW = _targetW;
                int reqH = _targetH;
                double scale = Math.Min(1.0, Math.Min((double)reqW / srcW, (double)reqH / srcH));
                int dstW = Math.Max(320, ((int)Math.Round(srcW * scale)) & ~1);
                int dstH = Math.Max(240, ((int)Math.Round(srcH * scale)) & ~1);

                if (_slots[0] == null || dstW != curSlotW || dstH != curSlotH) {
                    lock (_ringLock) {
                        while (_running) {
                            bool anyEncoding = false;
                            for (int i = 0; i < SLOT_COUNT; i++) {
                                if (_slots[i] != null && _slots[i].State == 3) { anyEncoding = true; break; }
                            }
                            if (!anyEncoding) break;
                            Monitor.Wait(_ringLock, 10);
                        }
                        if (!_running) break;
                        AllocateSlots(dstW, dstH);
                        curSlotW = dstW;
                        curSlotH = dstH;
                    }
                }

                RingSlot slot = null;
                lock (_ringLock) {
                    while (_running && slot == null) {
                        for (int i = 0; i < SLOT_COUNT; i++) {
                            if (_slots[i] != null && _slots[i].State == 0) { slot = _slots[i]; break; }
                        }
                        // If all remaining slots are unconsumed Ready frames (2), steal oldest Ready slot
                        if (slot == null) {
                            long minSeq = long.MaxValue;
                            for (int i = 0; i < SLOT_COUNT; i++) {
                                if (_slots[i] != null && _slots[i].State == 2 && _slots[i].Seq < minSeq) {
                                    minSeq = _slots[i].Seq;
                                    slot = _slots[i];
                                }
                            }
                        }
                        if (slot != null) {
                            slot.State = 1; // Capturing
                            break;
                        }
                        Monitor.Wait(_ringLock, 5);
                    }
                }

                if (!_running || slot == null) break;

                bool captured = false;
                byte curVis = 0;
                ushort cxNorm = 0, cyNorm = 0;
                IntPtr hScreenDC = GetDC(IntPtr.Zero);
                if (hScreenDC != IntPtr.Zero) {
                    try {
                        bool bltOk;
                        if (dstW == srcW && dstH == srcH) {
                            bltOk = BitBlt(slot.hDC, 0, 0, dstW, dstH, hScreenDC, 0, 0, SRCCOPY);
                        } else {
                            bltOk = StretchBlt(slot.hDC, 0, 0, dstW, dstH, hScreenDC, 0, 0, srcW, srcH, SRCCOPY);
                        }
                        if (bltOk) {
                            DrawScaledCursor(slot.hDC, srcW, srcH, dstW, dstH, out curVis, out cxNorm, out cyNorm);
                            GdiFlush();
                            captured = true;
                            loggedUnavailable = false;
                        } else {
                            int err = Marshal.GetLastWin32Error();
                            if (!loggedUnavailable) {
                                Console.Error.WriteLine("DESKTOP_HANDLE_WAITING:BitBlt/StretchBlt failed code=" + err);
                                loggedUnavailable = true;
                            }
                        }
                    } finally {
                        ReleaseDC(IntPtr.Zero, hScreenDC);
                    }
                } else if (!loggedUnavailable) {
                    Console.Error.WriteLine("DESKTOP_HANDLE_WAITING:GetDC returned null");
                    loggedUnavailable = true;
                }

                slot.CursorVis = curVis;
                slot.CursorXNorm = cxNorm;
                slot.CursorYNorm = cyNorm;

                if (!captured) {
                    DrawStatusFallback(slot.Bmp, dstW, dstH, "Windows dang khoa / cho quyen UAC hoac phien an");
                }

                long seq = Interlocked.Increment(ref _captureSeq);

                if (singleShot) {
                    byte[] trailer = new byte[8];
                    FillTrailer(trailer, FLAG_KEYFRAME, curVis, cxNorm, cyNorm);
                    using (MemoryStream ms = new MemoryStream(256 * 1024))
                    using (EncoderParameters ep = new EncoderParameters(1)) {
                        ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)_jpegQuality);
                        slot.Bmp.Save(ms, _jpegCodec, ep);
                        WriteFrameWithTrailer(seq, ms.GetBuffer(), (int)ms.Length, trailer);
                    }
                    break;
                }

                lock (_ringLock) {
                    // Supersede any stale Ready frame so encoders work exclusively on freshest frame
                    for (int i = 0; i < SLOT_COUNT; i++) {
                        if (_slots[i] != null && _slots[i] != slot && _slots[i].State == 2) {
                            _slots[i].State = 0;
                        }
                    }
                    slot.Seq = seq;
                    slot.State = 2; // Ready
                    Monitor.Pulse(_ringLock);
                }

                if (!captured) {
                    Thread.Sleep(24);
                    continue;
                }

                int frameBudgetMs = Math.Max(8, (int)Math.Round(1000.0 / _targetFps));
                int elapsedMs = (int)sw.ElapsedMilliseconds;
                int sleepMs = frameBudgetMs - elapsedMs;
                if (sleepMs > 1) {
                    Thread.Sleep(sleepMs);
                }
            }
        } catch (Exception ex) {
            Console.Error.WriteLine("STREAMER_EXIT:" + ex.Message);
        } finally {
            _running = false;
            lock (_ringLock) { Monitor.PulseAll(_ringLock); }
            lock (_outLock) { Monitor.PulseAll(_outLock); }
            if (workers != null) {
                for (int i = 0; i < workers.Length; i++) {
                    try { workers[i].Join(200); } catch {}
                }
            }
            DisposeSlots();
            if (timerSet) { try { timeEndPeriod(1); } catch {} }
        }
    }
}
'@

Add-Type -TypeDefinition $csharpCode -Language CSharp -ReferencedAssemblies System.Drawing
[SwiftDropRingStreamer]::Run($Width, $Height, $Fps, $Quality, [bool]$Once)
