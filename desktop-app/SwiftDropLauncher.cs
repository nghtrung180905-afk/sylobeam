using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace SwiftDropLauncher
{
    internal static class NativeWin32
    {
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x01000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const int CURSOR_SHOWING = 0x00000001;

        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
        [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
        [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

        [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER { public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount; public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant; }
        [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; }

        [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool LockWorkStation();
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
        [DllImport("user32.dll")] public static extern IntPtr CopyIcon(IntPtr hIcon);
        [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
        [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
        [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);
        [DllImport("gdi32.dll", SetLastError = true)] public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);
        [DllImport("gdi32.dll", SetLastError = true)] public static extern bool StretchBlt(IntPtr hdcDest, int nXOriginDest, int nYOriginDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXOriginSrc, int nYOriginSrc, int nWidthSrc, int nHeightSrc, int dwRop);
        [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr hdc, int iStretchMode);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint uMilliseconds);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint uMilliseconds);

        private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
        private static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            { "backspace", 0x08 }, { "tab", 0x09 }, { "enter", 0x0D }, { "return", 0x0D },
            { "shift", 0x10 }, { "ctrl", 0x11 }, { "control", 0x11 }, { "alt", 0x12 },
            { "pause", 0x13 }, { "capslock", 0x14 }, { "escape", 0x1B }, { "esc", 0x1B },
            { "space", 0x20 }, { " ", 0x20 },
            { "pageup", 0x21 }, { "pagedown", 0x22 }, { "end", 0x23 }, { "home", 0x24 },
            { "arrowleft", 0x25 }, { "left", 0x25 }, { "arrowup", 0x26 }, { "up", 0x26 },
            { "arrowright", 0x27 }, { "right", 0x27 }, { "arrowdown", 0x28 }, { "down", 0x28 },
            { "printscreen", 0x2C }, { "insert", 0x2D }, { "delete", 0x2E }, { "del", 0x2E },
            { "win", 0x5B }, { "meta", 0x5B }, { "lwin", 0x5B },
            { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 },
            { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 },
            { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B },
            { ";", 0xBA }, { "=", 0xBB }, { "+", 0xBB }, { ",", 0xBC }, { "-", 0xBD }, { "_", 0xBD },
            { ".", 0xBE }, { "/", 0xBF }, { "`", 0xC0 }, { "[", 0xDB }, { "\\", 0xDC }, { "]", 0xDD }, { "'", 0xDE },
            { "vol_mute", 0xAD }, { "vol_down", 0xAE }, { "vol_up", 0xAF },
            { "media_next", 0xB0 }, { "media_prev", 0xB1 }, { "media_stop", 0xB2 }, { "media_play_pause", 0xB3 }
        };

        private static uint ButtonFlag(string button, bool down)
        {
            if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        }

        private static ushort ResolveVk(string key)
        {
            if (string.IsNullOrEmpty(key)) return 0;
            ushort vk;
            if (KeyMap.TryGetValue(key, out vk)) return vk;
            if (key.Length == 1)
            {
                char c = char.ToUpperInvariant(key[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
            }
            return 0;
        }

        public static void DispatchInput(Dictionary<string, object> cmd)
        {
            if (cmd == null) return;
            object actObj;
            if (!cmd.TryGetValue("action", out actObj) || actObj == null) return;
            string action = Convert.ToString(actObj);

            switch (action)
            {
                case "mouse_move":
                    int dx = ToInt(cmd, "dx", 0), dy = ToInt(cmd, "dy", 0);
                    if (dx != 0 || dy != 0)
                    {
                        INPUT[] inp = new INPUT[1];
                        inp[0].type = INPUT_MOUSE;
                        inp[0].U.mi.dx = dx; inp[0].U.mi.dy = dy; inp[0].U.mi.dwFlags = MOUSEEVENTF_MOVE;
                        SendInput(1, inp, InputSize);
                    }
                    break;
                case "mouse_abs":
                    double nx = Math.Max(0.0, Math.Min(1.0, ToDouble(cmd, "nx", 0)));
                    double ny = Math.Max(0.0, Math.Min(1.0, ToDouble(cmd, "ny", 0)));
                    int msw = Math.Max(1, GetSystemMetrics(0));
                    int msh = Math.Max(1, GetSystemMetrics(1));
                    SetCursorPos((int)Math.Round(nx * Math.Max(1, msw - 1)), (int)Math.Round(ny * Math.Max(1, msh - 1)));
                    INPUT[] absInp = new INPUT[1];
                    absInp[0].type = INPUT_MOUSE;
                    absInp[0].U.mi.dx = (int)Math.Round(nx * 65535.0);
                    absInp[0].U.mi.dy = (int)Math.Round(ny * 65535.0);
                    absInp[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
                    SendInput(1, absInp, InputSize);
                    string btn = ToStr(cmd, "button", "left");
                    if (ToBool(cmd, "down")) MouseBtn(btn, true);
                    else if (ToBool(cmd, "up")) MouseBtn(btn, false);
                    else if (ToBool(cmd, "click")) MouseClick(btn, ToInt(cmd, "count", 1));
                    break;
                case "mouse_click":
                    MouseClick(ToStr(cmd, "button", "left"), ToInt(cmd, "count", 1));
                    break;
                case "mouse_down":
                    MouseBtn(ToStr(cmd, "button", "left"), true);
                    break;
                case "mouse_up":
                    MouseBtn(ToStr(cmd, "button", "left"), false);
                    break;
                case "mouse_scroll":
                    int sdy = ToInt(cmd, "dy", 0), sdx = ToInt(cmd, "dx", 0);
                    var slist = new List<INPUT>(2);
                    if (sdy != 0) { var i = new INPUT { type = INPUT_MOUSE }; i.U.mi.dwFlags = MOUSEEVENTF_WHEEL; i.U.mi.mouseData = unchecked((uint)sdy); slist.Add(i); }
                    if (sdx != 0) { var i = new INPUT { type = INPUT_MOUSE }; i.U.mi.dwFlags = MOUSEEVENTF_HWHEEL; i.U.mi.mouseData = unchecked((uint)sdx); slist.Add(i); }
                    if (slist.Count > 0) SendInput((uint)slist.Count, slist.ToArray(), InputSize);
                    break;
                case "key_press":
                    PressVk(ResolveVk(ToStr(cmd, "key", "")));
                    break;
                case "key_combo":
                    object rawKeys;
                    if (cmd.TryGetValue("keys", out rawKeys) && rawKeys is object[])
                    {
                        var vks = new List<ushort>();
                        foreach (object k in (object[])rawKeys)
                        {
                            ushort vk = ResolveVk(Convert.ToString(k));
                            if (vk != 0) vks.Add(vk);
                        }
                        if (vks.Count > 0)
                        {
                            var kinp = new List<INPUT>(vks.Count * 2);
                            for (int i = 0; i < vks.Count; i++) { var d = new INPUT { type = INPUT_KEYBOARD }; d.U.ki.wVk = vks[i]; kinp.Add(d); }
                            for (int i = vks.Count - 1; i >= 0; i--) { var u = new INPUT { type = INPUT_KEYBOARD }; u.U.ki.wVk = vks[i]; u.U.ki.dwFlags = KEYEVENTF_KEYUP; kinp.Add(u); }
                            SendInput((uint)kinp.Count, kinp.ToArray(), InputSize);
                        }
                    }
                    break;
                case "key_text":
                    string txt = ToStr(cmd, "text", "");
                    if (!string.IsNullOrEmpty(txt))
                    {
                        if (txt.Length > 500) txt = txt.Substring(0, 500);
                        var uinp = new List<INPUT>(txt.Length * 2);
                        foreach (char ch in txt)
                        {
                            if (ch == '\r') continue;
                            if (ch == '\n') { PressVk(0x0D); continue; }
                            var d = new INPUT { type = INPUT_KEYBOARD }; d.U.ki.wScan = ch; d.U.ki.dwFlags = KEYEVENTF_UNICODE; uinp.Add(d);
                            var u = new INPUT { type = INPUT_KEYBOARD }; u.U.ki.wScan = ch; u.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; uinp.Add(u);
                        }
                        if (uinp.Count > 0) SendInput((uint)uinp.Count, uinp.ToArray(), InputSize);
                    }
                    break;
                case "system_action":
                    string sys = ToStr(cmd, "command", "");
                    if (sys == "lock_pc") LockWorkStation();
                    else PressVk(ResolveVk(sys));
                    break;
            }
        }

        private static void MouseBtn(string btn, bool down)
        {
            INPUT[] inp = new INPUT[1];
            inp[0].type = INPUT_MOUSE;
            inp[0].U.mi.dwFlags = ButtonFlag(btn, down);
            SendInput(1, inp, InputSize);
        }

        private static void MouseClick(string btn, int count)
        {
            int clicks = Math.Max(1, Math.Min(2, count));
            uint d = ButtonFlag(btn, true), u = ButtonFlag(btn, false);
            INPUT[] inp = new INPUT[clicks * 2];
            for (int i = 0; i < clicks; i++)
            {
                inp[i * 2].type = INPUT_MOUSE; inp[i * 2].U.mi.dwFlags = d;
                inp[i * 2 + 1].type = INPUT_MOUSE; inp[i * 2 + 1].U.mi.dwFlags = u;
            }
            SendInput((uint)inp.Length, inp, InputSize);
        }

        private static void PressVk(ushort vk)
        {
            if (vk == 0) return;
            INPUT[] inp = new INPUT[2];
            inp[0].type = INPUT_KEYBOARD; inp[0].U.ki.wVk = vk;
            inp[1].type = INPUT_KEYBOARD; inp[1].U.ki.wVk = vk; inp[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
            SendInput(2, inp, InputSize);
        }

        private static double ToDouble(Dictionary<string, object> m, string k, double f) { object v; if (!m.TryGetValue(k, out v) || v == null) return f; try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return f; } }
        private static int ToInt(Dictionary<string, object> m, string k, int f) { return (int)Math.Round(ToDouble(m, k, f)); }
        private static bool ToBool(Dictionary<string, object> m, string k) { object v; if (!m.TryGetValue(k, out v) || v == null) return false; try { return Convert.ToBoolean(v); } catch { return false; } }
        private static string ToStr(Dictionary<string, object> m, string k, string f) { object v; if (!m.TryGetValue(k, out v) || v == null) return f; return Convert.ToString(v); }
    }

    internal sealed class StandaloneHost
    {
        private readonly string _webRoot;
        private readonly string _token;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        private readonly Dictionary<string, object> _hwInfo;
        private readonly string _defaultDownloadsDir;
        private readonly string _settingsFile;
        private string _downloadsDir;
        private readonly object _settingsLock = new object();
        private int _port;
        private volatile bool _running = true;
        private volatile bool _rcAuth = true;
        private int _sseClients = 0;
        private volatile bool _hadSseClient = false;
        private HttpListener _listener;
        private Process _activeCaptureProc = null;
        private readonly object _captureLock = new object();

        public StandaloneHost(string webRoot)
        {
            NativeWin32.SetProcessDPIAware();
            _webRoot = Path.GetFullPath(webRoot);
            byte[] tb = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(tb);
            _token = BitConverter.ToString(tb).Replace("-", "").ToLowerInvariant();
            _defaultDownloadsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            _settingsFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SwiftDrop", "settings.json");
            _downloadsDir = LoadSavedDownloadsDir(_defaultDownloadsDir);
            _hwInfo = DetectHardware();
            _hwInfo["downloadsDir"] = _downloadsDir;
        }

        private string LoadSavedDownloadsDir(string fallbackDir)
        {
            try
            {
                if (File.Exists(_settingsFile))
                {
                    var obj = _json.DeserializeObject(File.ReadAllText(_settingsFile, Encoding.UTF8)) as Dictionary<string, object>;
                    object v;
                    if (obj != null && obj.TryGetValue("downloadsDir", out v) && v != null)
                    {
                        string s = Convert.ToString(v).Trim();
                        if (!string.IsNullOrEmpty(s))
                        {
                            string full = Path.GetFullPath(s);
                            if (Directory.Exists(full) || Directory.Exists(Path.GetDirectoryName(full)))
                            {
                                return full;
                            }
                        }
                    }
                }
            }
            catch { }
            return fallbackDir;
        }

        private Dictionary<string, object> SetDownloadsDir(string rawPath)
        {
            string cleaned = string.IsNullOrWhiteSpace(rawPath) ? "" : rawPath.Trim();
            lock (_settingsLock)
            {
                if (string.IsNullOrEmpty(cleaned))
                {
                    _downloadsDir = _defaultDownloadsDir;
                    _hwInfo["downloadsDir"] = _downloadsDir;
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(_settingsFile));
                        File.WriteAllText(_settingsFile, _json.Serialize(new Dictionary<string, object> { { "downloadsDir", "" } }), Encoding.UTF8);
                    }
                    catch { }
                    return new Dictionary<string, object> { { "ok", true }, { "downloadsDir", _downloadsDir }, { "defaultDir", _defaultDownloadsDir } };
                }
                try
                {
                    string resolved = Path.GetFullPath(cleaned);
                    Directory.CreateDirectory(resolved);
                    _downloadsDir = resolved;
                    _hwInfo["downloadsDir"] = _downloadsDir;
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(_settingsFile));
                        File.WriteAllText(_settingsFile, _json.Serialize(new Dictionary<string, object> { { "downloadsDir", resolved } }), Encoding.UTF8);
                    }
                    catch { }
                    return new Dictionary<string, object> { { "ok", true }, { "downloadsDir", _downloadsDir }, { "defaultDir", _defaultDownloadsDir } };
                }
                catch (Exception ex)
                {
                    return new Dictionary<string, object> { { "ok", false }, { "downloadsDir", _downloadsDir }, { "error", ex.Message } };
                }
            }
        }

        private Dictionary<string, object> ChooseDownloadsDirDialog()
        {
            string chosen = "";
            string curDir = _downloadsDir;
            var t = new Thread(() =>
            {
                try
                {
                    using (var owner = new Form())
                    using (var dlg = new FolderBrowserDialog())
                    {
                        owner.TopMost = true;
                        owner.StartPosition = FormStartPosition.Manual;
                        owner.Location = new Point(-32000, -32000);
                        owner.Size = new Size(1, 1);
                        owner.ShowInTaskbar = false;
                        dlg.Description = "Chọn thư mục lưu file nhận qua SyloBeam";
                        dlg.ShowNewFolderButton = true;
                        if (Directory.Exists(curDir)) dlg.SelectedPath = curDir;
                        owner.Show();
                        owner.Activate();
                        if (dlg.ShowDialog(owner) == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath))
                        {
                            chosen = dlg.SelectedPath.Trim();
                        }
                        owner.Close();
                    }
                }
                catch { }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            if (string.IsNullOrEmpty(chosen))
            {
                return new Dictionary<string, object> { { "ok", true }, { "downloadsDir", _downloadsDir }, { "cancelled", true } };
            }
            var updated = SetDownloadsDir(chosen);
            updated["cancelled"] = false;
            return updated;
        }

        private static Dictionary<string, object> DetectHardware()
        {
            var gpus = new List<Dictionary<string, object>>();
            string bestName = "Windows Display Adapter", bestEnc = "Universal Fallback";
            int bestRank = -1;
            try
            {
                using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"))
                {
                    if (key != null)
                    {
                        foreach (string sub in key.GetSubKeyNames())
                        {
                            if (sub.Length != 4) continue;
                            using (var sk = key.OpenSubKey(sub))
                            {
                                object descObj = sk == null ? null : sk.GetValue("DriverDesc");
                                if (descObj == null) continue;
                                string name = Convert.ToString(descObj).Trim();
                                string vendor = "Other", enc = "Universal Multi-Thread";
                                int rank = 0;
                                string low = name.ToLowerInvariant();
                                if (low.Contains("nvidia") || low.Contains("geforce") || low.Contains("rtx") || low.Contains("gtx")) { vendor = "NVIDIA"; enc = "NVIDIA NVENC"; rank = 3; }
                                else if (low.Contains("amd") || low.Contains("radeon")) { vendor = "AMD"; enc = "AMD AMF"; rank = 2; }
                                else if (low.Contains("intel") || low.Contains("uhd") || low.Contains("iris") || low.Contains("arc")) { vendor = "Intel"; enc = "Intel QuickSync"; rank = 1; }
                                gpus.Add(new Dictionary<string, object> { { "name", name }, { "vendor", vendor }, { "encoder", enc }, { "driverVersion", Convert.ToString(sk.GetValue("DriverVersion") ?? "") } });
                                if (rank > bestRank) { bestRank = rank; bestName = name; bestEnc = enc; }
                            }
                        }
                    }
                }
            }
            catch { }

            int w = Math.Max(1, NativeWin32.GetSystemMetrics(0));
            int h = Math.Max(1, NativeWin32.GetSystemMetrics(1));
            return new Dictionary<string, object>
            {
                { "os", "win32" },
                { "arch", Environment.Is64BitOperatingSystem ? "x64" : "x86" },
                { "runtime", "standalone-win32" },
                { "gpus", gpus.ToArray() },
                { "primaryGpu", bestName },
                { "hardwareEncoder", bestEnc },
                { "display", new Dictionary<string, object> { { "width", w }, { "height", h }, { "refreshRate", 60 } } }
            };
        }

        private static int FindFreePort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int p = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return p;
        }

        public int Run(bool checkOnly)
        {
            _port = FindFreePort();
            if (checkOnly)
            {
                Console.WriteLine(_json.Serialize(new Dictionary<string, object> { { "ok", true }, { "port", _port }, { "hardware", _hwInfo } }));
                return 0;
            }

            _listener = new HttpListener();
            _listener.Prefixes.Add("http://127.0.0.1:" + _port + "/");
            _listener.Start();

            Thread srv = new Thread(AcceptLoop) { IsBackground = true };
            srv.Start();

            string url = "http://127.0.0.1:" + _port + "/?desktopToken=" + Uri.EscapeDataString(_token);
            var launchedSw = Stopwatch.StartNew();
            Process browser = Program.LaunchHardwareBrowser(url);
            if (browser != null)
            {
                browser.WaitForExit();
                // If Edge/Chrome handed off to an existing process (<5s), stay alive while SSE client is open!
                if (launchedSw.ElapsedMilliseconds > 5000 && Thread.VolatileRead(ref _sseClients) == 0)
                {
                    _running = false;
                    StopActiveCaptureProcess();
                    try { _listener.Stop(); } catch { }
                    return 0;
                }
                int waitSec = 0;
                while (_running)
                {
                    Thread.Sleep(500);
                    waitSec++;
                    if (_hadSseClient && Thread.VolatileRead(ref _sseClients) == 0)
                    {
                        Thread.Sleep(4000);
                        if (Thread.VolatileRead(ref _sseClients) == 0) break;
                    }
                    else if (!_hadSseClient && waitSec > 120)
                    {
                        break;
                    }
                }
                _running = false;
                StopActiveCaptureProcess();
                try { _listener.Stop(); } catch { }
                return 0;
            }

            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            while (_running) Thread.Sleep(500);
            return 0;
        }

        private void AcceptLoop()
        {
            while (_running && _listener != null && _listener.IsListening)
            {
                try
                {
                    var ctx = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleRequest(ctx));
                }
                catch { break; }
            }
        }

        private bool CheckAuth(HttpListenerRequest req)
        {
            string h = (req.Headers["Host"] ?? "").ToLowerInvariant();
            if (h != "127.0.0.1:" + _port && h != "localhost:" + _port) return false;
            return req.Headers["X-SwiftDrop-Token"] == _token || req.QueryString["token"] == _token;
        }

        private void HandleRequest(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            try
            {
                string p = Uri.UnescapeDataString(req.Url.AbsolutePath);
                if (p == "/api/host-info" || p == "/host-info.json")
                {
                    WriteJson(res, 200, new Dictionary<string, object>
                    {
                        { "lanIp", "127.0.0.1" }, { "port", _port },
                        { "lanUrl", "http://127.0.0.1:" + _port },
                        { "publicUrl", "https://sylobeam.pages.dev" },
                        { "isDesktopHost", true }, { "hardware", _hwInfo }
                    });
                    return;
                }
                if (p == "/api/hardware-info")
                {
                    if (!CheckAuth(req)) { WriteJson(res, 403, new { ok = false }); return; }
                    WriteJson(res, 200, _hwInfo);
                    return;
                }
                if (p == "/api/desktop-events")
                {
                    if (!CheckAuth(req)) { WriteJson(res, 403, new { ok = false }); return; }
                    res.ContentType = "text/event-stream; charset=utf-8";
                    _hadSseClient = true;
                    Interlocked.Increment(ref _sseClients);
                    try
                    {
                        byte[] msg = Encoding.UTF8.GetBytes("data: " + _json.Serialize(new Dictionary<string, object> { { "type", "connected" }, { "hardware", _hwInfo } }) + "\n\n");
                        res.OutputStream.Write(msg, 0, msg.Length);
                        res.OutputStream.Flush();
                        while (_running) { Thread.Sleep(15000); try { byte[] hb = Encoding.UTF8.GetBytes(": ping\n\n"); res.OutputStream.Write(hb, 0, hb.Length); res.OutputStream.Flush(); } catch { break; } }
                    }
                    finally
                    {
                        Interlocked.Decrement(ref _sseClients);
                    }
                    return;
                }
                if (p == "/api/screen-raw")
                {
                    if (!CheckAuth(req)) { WriteJson(res, 403, new { ok = false }); return; }
                    StreamScreenLoop(req, res);
                    return;
                }
                if (p.StartsWith("/api/desktop-rpc/") && req.HttpMethod == "POST")
                {
                    if (!CheckAuth(req)) { WriteJson(res, 403, new { ok = false }); return; }
                    string act = p.Substring("/api/desktop-rpc/".Length);
                    if (act == "save-file")
                    {
                        string fn = Uri.UnescapeDataString(req.Headers["X-File-Name"] ?? "swiftdrop_file");
                        foreach (char c in Path.GetInvalidFileNameChars()) fn = fn.Replace(c, '_');
                        fn = string.IsNullOrWhiteSpace(fn) ? "swiftdrop_file" : fn.TrimStart('.');
                        Directory.CreateDirectory(_downloadsDir);
                        string target = Path.Combine(_downloadsDir, fn);
                        int n = 1;
                        while (File.Exists(target) && n < 9999)
                        {
                            target = Path.Combine(_downloadsDir, Path.GetFileNameWithoutExtension(fn) + " (" + n + ")" + Path.GetExtension(fn));
                            n++;
                        }
                        using (var fs = File.Create(target)) req.InputStream.CopyTo(fs);
                        WriteJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "savedPath", target }, { "fileName", Path.GetFileName(target) } });
                        return;
                    }
                    string body;
                    using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) body = sr.ReadToEnd();
                    var payload = string.IsNullOrWhiteSpace(body) ? new Dictionary<string, object>() : _json.DeserializeObject(body) as Dictionary<string, object>;
                    if (act == "set-auth")
                    {
                        object en;
                        _rcAuth = payload != null && payload.TryGetValue("enabled", out en) && Convert.ToBoolean(en);
                        if (!_rcAuth) StopActiveCaptureProcess();
                        WriteJson(res, 200, new Dictionary<string, object> { { "authorized", _rcAuth } });
                        return;
                    }
                    if (act == "input")
                    {
                        if (_rcAuth) NativeWin32.DispatchInput(payload);
                        WriteJson(res, 200, new { ok = true });
                        return;
                    }
                    if (act == "screen-config")
                    {
                        int cw = ToInt(payload, "width", 1600);
                        int ch = ToInt(payload, "height", 900);
                        int cfps = ToInt(payload, "fps", 60);
                        int cq = ToInt(payload, "quality", 54);
                        lock (_captureLock)
                        {
                            if (_activeCaptureProc != null)
                            {
                                try
                                {
                                    if (!_activeCaptureProc.HasExited)
                                    {
                                        _activeCaptureProc.StandardInput.WriteLine(string.Format("CFG|{0}|{1}|{2}|{3}", cw, ch, cfps, cq));
                                        _activeCaptureProc.StandardInput.Flush();
                                    }
                                }
                                catch { }
                            }
                        }
                        WriteJson(res, 200, new { ok = true });
                        return;
                    }
                    if (act == "screen-stop")
                    {
                        StopActiveCaptureProcess();
                        WriteJson(res, 200, new { ok = true });
                        return;
                    }
                    if (act == "open-downloads")
                    {
                        object fpObj;
                        string fp = (payload != null && payload.TryGetValue("filePath", out fpObj)) ? Convert.ToString(fpObj) : "";
                        if (!string.IsNullOrEmpty(fp) && File.Exists(fp)) Process.Start("explorer.exe", "/select,\"" + fp + "\"");
                        else Process.Start("explorer.exe", _downloadsDir);
                        WriteJson(res, 200, new { ok = true });
                        return;
                    }
                    if (act == "get-download-dir")
                    {
                        WriteJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "downloadsDir", _downloadsDir }, { "defaultDir", _defaultDownloadsDir } });
                        return;
                    }
                    if (act == "set-download-dir")
                    {
                        object dirObj;
                        string raw = (payload != null && payload.TryGetValue("downloadsDir", out dirObj) && dirObj != null) ? Convert.ToString(dirObj) : "";
                        var r = SetDownloadsDir(raw);
                        bool ok = r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]);
                        WriteJson(res, ok ? 200 : 400, r);
                        return;
                    }
                    if (act == "choose-download-dir")
                    {
                        WriteJson(res, 200, ChooseDownloadsDirDialog());
                        return;
                    }
                    WriteJson(res, 200, new { ok = true });
                    return;
                }

                string rel = (p == "/" ? "index.html" : p.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar);
                string full = Path.GetFullPath(Path.Combine(_webRoot, rel));
                if (!full.StartsWith(_webRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                {
                    res.StatusCode = 404; res.Close(); return;
                }
                res.ContentType = GetMime(Path.GetExtension(full));
                res.Headers["Cache-Control"] = "no-cache";
                byte[] bytes = File.ReadAllBytes(full);
                res.ContentLength64 = bytes.Length;
                res.OutputStream.Write(bytes, 0, bytes.Length);
                res.Close();
            }
            catch
            {
                try { res.Abort(); } catch { }
            }
        }

        private void StopActiveCaptureProcess()
        {
            Process toStop = null;
            lock (_captureLock)
            {
                toStop = _activeCaptureProc;
                _activeCaptureProc = null;
            }
            if (toStop != null)
            {
                try
                {
                    if (!toStop.HasExited)
                    {
                        try { toStop.StandardInput.WriteLine("QUIT"); toStop.StandardInput.Flush(); } catch { }
                        if (!toStop.WaitForExit(180))
                        {
                            try { toStop.Kill(); } catch { }
                        }
                    }
                }
                catch { }
                try { toStop.Dispose(); } catch { }
            }
        }

        private static int ToInt(Dictionary<string, object> m, string k, int fallback)
        {
            if (m == null) return fallback;
            object v;
            if (!m.TryGetValue(k, out v) || v == null) return fallback;
            try { return Convert.ToInt32(Convert.ToDouble(v, CultureInfo.InvariantCulture)); }
            catch { return fallback; }
        }

        private void StreamScreenLoop(HttpListenerRequest req, HttpListenerResponse res)
        {
            int tw = 1600, th = 900, fps = 60, q = 54;
            int.TryParse(req.QueryString["w"], out tw); if (tw < 320) tw = 1600;
            int.TryParse(req.QueryString["h"], out th); if (th < 240) th = 900;
            int.TryParse(req.QueryString["fps"], out fps); if (fps < 10) fps = 60;
            int.TryParse(req.QueryString["q"], out q); if (q < 36) q = 54;

            res.ContentType = "application/octet-stream";
            res.SendChunked = true;

            // Prefer native DXGI Desktop Duplication binary (SwiftDropCapture.exe) when present
            string capExe = Path.Combine(_webRoot, "desktop-app", "SwiftDropCapture.exe");
            if (File.Exists(capExe))
            {
                StopActiveCaptureProcess();
                Process proc = null;
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = capExe,
                        Arguments = string.Format("--width {0} --height {1} --fps {2} --quality {3}", tw, th, fps, q),
                        UseShellExecute = false,
                        RedirectStandardInput = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    proc = Process.Start(psi);
                    if (proc != null)
                    {
                        proc.ErrorDataReceived += (s, ev) => { };
                        try { proc.BeginErrorReadLine(); } catch { }
                        lock (_captureLock) { _activeCaptureProc = proc; }
                        byte[] buf = new byte[65536];
                        Stream stdout = proc.StandardOutput.BaseStream;
                        while (_running && !proc.HasExited)
                        {
                            int n = stdout.Read(buf, 0, buf.Length);
                            if (n <= 0) break;
                            res.OutputStream.Write(buf, 0, n);
                            res.OutputStream.Flush();
                        }
                        return;
                    }
                }
                catch { }
                finally
                {
                    lock (_captureLock)
                    {
                        if (_activeCaptureProc == proc) _activeCaptureProc = null;
                    }
                    if (proc != null)
                    {
                        try
                        {
                            if (!proc.HasExited)
                            {
                                try { proc.StandardInput.WriteLine("QUIT"); proc.StandardInput.Flush(); } catch { }
                                if (!proc.WaitForExit(150)) { try { proc.Kill(); } catch { } }
                            }
                        }
                        catch { }
                        try { proc.Dispose(); } catch { }
                    }
                }
            }

            ImageCodecInfo jpegCodec = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) { jpegCodec = c; break; }
            if (jpegCodec == null) return;

            bool timerSet = false;
            try { timerSet = (NativeWin32.timeBeginPeriod(1) == 0); } catch { }

            int swW = Math.Max(1, NativeWin32.GetSystemMetrics(0));
            int swH = Math.Max(1, NativeWin32.GetSystemMetrics(1));
            double scale = Math.Min(1.0, Math.Min((double)tw / swW, (double)th / swH));
            int dw = Math.Max(320, ((int)Math.Round(swW * scale)) & ~1);
            int dh = Math.Max(240, ((int)Math.Round(swH * scale)) & ~1);
            int stride = ((dw * 3 + 3) & ~3);
            int totalBytes = stride * dh;

            const int slots = 4;
            IntPtr[] hDCs = new IntPtr[slots];
            IntPtr[] hDibs = new IntPtr[slots];
            IntPtr[] dibBits = new IntPtr[slots];
            Bitmap[] bmps = new Bitmap[slots];
            int[] states = new int[slots]; // 0=Idle, 1=Cap, 2=Ready, 3=Enc
            long[] seqs = new long[slots];
            byte[] cVis = new byte[slots];
            ushort[] cxArr = new ushort[slots];
            ushort[] cyArr = new ushort[slots];

            for (int i = 0; i < slots; i++)
            {
                var bmi = new NativeWin32.BITMAPINFO();
                bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(NativeWin32.BITMAPINFOHEADER));
                bmi.bmiHeader.biWidth = dw; bmi.bmiHeader.biHeight = -dh; bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 24;
                IntPtr bits;
                hDCs[i] = NativeWin32.CreateCompatibleDC(IntPtr.Zero);
                hDibs[i] = NativeWin32.CreateDIBSection(hDCs[i], ref bmi, 0, out bits, IntPtr.Zero, 0);
                NativeWin32.SelectObject(hDCs[i], hDibs[i]);
                NativeWin32.SetStretchBltMode(hDCs[i], 3);
                dibBits[i] = bits;
                bmps[i] = new Bitmap(dw, dh, stride, PixelFormat.Format24bppRgb, bits);
            }

            object ringLock = new object();
            object deltaLock = new object();
            object outLock = new object();
            long capSeq = 0, outSeq = 0;
            bool streamAlive = true;

            byte[] prevPixels = null;
            byte[] curPixels = new byte[totalBytes];
            byte[] cachedStaticJpeg = null;
            bool needsRestFrame = false;
            long lastEmitMs = 0;
            ushort prevCurX = 0, prevCurY = 0;
            int motionQuality = Math.Max(38, q - 16);
            Stopwatch clock = Stopwatch.StartNew();

            ThreadStart encodeWorker = () =>
            {
                MemoryStream ms = new MemoryStream(256 * 1024);
                EncoderParameters ep = null;
                int lastEncQ = -1;
                byte[] lenBuf = new byte[4];
                byte[] trailer = new byte[8];

                try
                {
                    while (_running && streamAlive)
                    {
                        int picked = -1;
                        long pSeq = -1;
                        lock (ringLock)
                        {
                            while (_running && streamAlive)
                            {
                                for (int i = 0; i < slots; i++)
                                {
                                    if (states[i] == 2 && seqs[i] > pSeq) { pSeq = seqs[i]; picked = i; }
                                }
                                if (picked >= 0) { states[picked] = 3; break; }
                                Monitor.Wait(ringLock, 40);
                            }
                        }
                        if (!_running || !streamAlive || picked < 0) break;

                        try
                        {
                            bool shouldEmit = false;
                            bool cacheResult = false;
                            byte[] cachedSnap = null;
                            byte flags = 0;
                            int encQ = q;
                            byte curV = cVis[picked];
                            ushort curXN = cxArr[picked];
                            ushort curYN = cyArr[picked];

                            lock (deltaLock)
                            {
                                Marshal.Copy(dibBits[picked], curPixels, 0, totalBytes);
                                long nowMs = clock.ElapsedMilliseconds;
                                if (prevPixels == null)
                                {
                                    prevPixels = curPixels;
                                    curPixels = new byte[totalBytes];
                                    cachedStaticJpeg = null;
                                    needsRestFrame = false;
                                    lastEmitMs = nowMs;
                                    prevCurX = curXN;
                                    prevCurY = curYN;
                                    shouldEmit = true;
                                    cacheResult = true;
                                    flags = 0;
                                    encQ = Math.Min(84, q + 8);
                                }
                                else
                                {
                                    int changed = 0;
                                    int samples = 0;
                                    for (int y = 0; y < dh; y += 8)
                                    {
                                        int rowOff = y * stride;
                                        for (int x = 0; x < dw; x += 8)
                                        {
                                            samples++;
                                            int idx = rowOff + x * 3;
                                            int dr = curPixels[idx] - prevPixels[idx]; if (dr < 0) dr = -dr;
                                            int dg = curPixels[idx + 1] - prevPixels[idx + 1]; if (dg < 0) dg = -dg;
                                            int db = curPixels[idx + 2] - prevPixels[idx + 2]; if (db < 0) db = -db;
                                            if (dr + dg + db > 24) changed++;
                                        }
                                    }

                                    byte[] tmp = prevPixels;
                                    prevPixels = curPixels;
                                    curPixels = tmp;

                                    bool curMoved = (curV != 0 && (Math.Abs((int)curXN - (int)prevCurX) > 20 || Math.Abs((int)curYN - (int)prevCurY) > 20));
                                    prevCurX = curXN;
                                    prevCurY = curYN;

                                    if (changed == 0 && !curMoved)
                                    {
                                        if (needsRestFrame)
                                        {
                                            needsRestFrame = false;
                                            lastEmitMs = nowMs;
                                            shouldEmit = true;
                                            cacheResult = true;
                                            flags = 2;
                                            encQ = Math.Min(84, Math.Max(q + 14, 78));
                                        }
                                        else if (cachedStaticJpeg != null)
                                        {
                                            if ((nowMs - lastEmitMs) >= 24)
                                            {
                                                lastEmitMs = nowMs;
                                                shouldEmit = true;
                                                cachedSnap = cachedStaticJpeg;
                                                flags = 2;
                                            }
                                        }
                                        else
                                        {
                                            lastEmitMs = nowMs;
                                            shouldEmit = true;
                                            cacheResult = true;
                                            flags = 2;
                                            encQ = Math.Min(84, q + 12);
                                        }
                                    }
                                    else
                                    {
                                        cachedStaticJpeg = null;
                                        needsRestFrame = true;
                                        lastEmitMs = nowMs;
                                        shouldEmit = true;
                                        int changedPct = (changed * 100) / Math.Max(1, samples);
                                        if (changedPct >= 12)
                                        {
                                            flags = 4;
                                            encQ = Math.Max(36, Math.Min(motionQuality, q - 10));
                                        }
                                        else
                                        {
                                            flags = 0;
                                            encQ = q;
                                        }
                                    }
                                }
                            }

                            if (!shouldEmit) continue;

                            trailer[0] = flags;
                            trailer[1] = curV;
                            trailer[2] = (byte)(curXN & 0xff); trailer[3] = (byte)((curXN >> 8) & 0xff);
                            trailer[4] = (byte)(curYN & 0xff); trailer[5] = (byte)((curYN >> 8) & 0xff);
                            trailer[6] = (byte)'S'; trailer[7] = (byte)'D';

                            if (cachedSnap != null)
                            {
                                int flc = cachedSnap.Length + 8;
                                lock (outLock)
                                {
                                    if (streamAlive && pSeq > outSeq)
                                    {
                                        outSeq = pSeq;
                                        lenBuf[0] = (byte)(flc & 0xff); lenBuf[1] = (byte)((flc >> 8) & 0xff);
                                        lenBuf[2] = (byte)((flc >> 16) & 0xff); lenBuf[3] = (byte)((flc >> 24) & 0xff);
                                        res.OutputStream.Write(lenBuf, 0, 4);
                                        res.OutputStream.Write(cachedSnap, 0, cachedSnap.Length);
                                        res.OutputStream.Write(trailer, 0, 8);
                                        res.OutputStream.Flush();
                                    }
                                }
                                continue;
                            }

                            if (ep == null || encQ != lastEncQ)
                            {
                                if (ep != null) ep.Dispose();
                                ep = new EncoderParameters(1);
                                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)encQ);
                                lastEncQ = encQ;
                            }
                            ms.SetLength(0);
                            bmps[picked].Save(ms, jpegCodec, ep);

                            int jpegLen = (int)ms.Length;
                            if (flags == 4)
                            {
                                if (jpegLen > 48000 && motionQuality > 36) motionQuality = Math.Max(36, motionQuality - 4);
                                else if (jpegLen < 28000 && motionQuality < q - 10) motionQuality = Math.Min(q - 10, motionQuality + 2);
                            }

                            if (cacheResult)
                            {
                                byte[] snap = new byte[jpegLen];
                                Buffer.BlockCopy(ms.GetBuffer(), 0, snap, 0, jpegLen);
                                lock (deltaLock) { cachedStaticJpeg = snap; }
                            }

                            int fl = jpegLen + 8;
                            lock (outLock)
                            {
                                if (streamAlive && pSeq > outSeq)
                                {
                                    outSeq = pSeq;
                                    lenBuf[0] = (byte)(fl & 0xff); lenBuf[1] = (byte)((fl >> 8) & 0xff);
                                    lenBuf[2] = (byte)((fl >> 16) & 0xff); lenBuf[3] = (byte)((fl >> 24) & 0xff);
                                    res.OutputStream.Write(lenBuf, 0, 4);
                                    res.OutputStream.Write(ms.GetBuffer(), 0, jpegLen);
                                    res.OutputStream.Write(trailer, 0, 8);
                                    res.OutputStream.Flush();
                                }
                            }
                        }
                        catch { streamAlive = false; }
                        finally
                        {
                            lock (ringLock) { if (states[picked] == 3) states[picked] = 0; Monitor.PulseAll(ringLock); }
                        }
                    }
                }
                finally
                {
                    if (ep != null) ep.Dispose();
                    ms.Dispose();
                }
            };

            Thread w1 = new Thread(encodeWorker) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            Thread w2 = new Thread(encodeWorker) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            Thread w3 = new Thread(encodeWorker) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            Thread w4 = new Thread(encodeWorker) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            w1.Start(); w2.Start(); w3.Start(); w4.Start();

            try
            {
                var sw = new Stopwatch();
                while (_running && streamAlive)
                {
                    sw.Restart();
                    int slot = -1;
                    lock (ringLock)
                    {
                        while (_running && streamAlive && slot < 0)
                        {
                            for (int i = 0; i < slots; i++) if (states[i] == 0) { slot = i; break; }
                            if (slot < 0)
                            {
                                long minS = long.MaxValue;
                                for (int i = 0; i < slots; i++) if (states[i] == 2 && seqs[i] < minS) { minS = seqs[i]; slot = i; }
                            }
                            if (slot >= 0) { states[slot] = 1; break; }
                            Monitor.Wait(ringLock, 5);
                        }
                    }
                    if (!_running || !streamAlive || slot < 0) break;

                    bool capOk = false;
                    byte vis = 0; ushort xn = 0, yn = 0;
                    IntPtr hScr = NativeWin32.GetDC(IntPtr.Zero);
                    if (hScr != IntPtr.Zero)
                    {
                        try
                        {
                            capOk = (dw == swW && dh == swH)
                                ? NativeWin32.BitBlt(hDCs[slot], 0, 0, dw, dh, hScr, 0, 0, 0x00CC0020)
                                : NativeWin32.StretchBlt(hDCs[slot], 0, 0, dw, dh, hScr, 0, 0, swW, swH, 0x00CC0020);
                            if (capOk)
                            {
                                var ci = new NativeWin32.CURSORINFO { cbSize = Marshal.SizeOf(typeof(NativeWin32.CURSORINFO)) };
                                if (NativeWin32.GetCursorInfo(ref ci) && (ci.flags & NativeWin32.CURSOR_SHOWING) != 0)
                                {
                                    int rawX = ci.ptScreenPos.x, rawY = ci.ptScreenPos.y;
                                    if (rawX >= 0 && rawY >= 0 && rawX <= swW && rawY <= swH)
                                    {
                                        vis = 1;
                                        double ncx = swW > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawX / swW)) : 0.0;
                                        double ncy = swH > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawY / swH)) : 0.0;
                                        xn = (ushort)Math.Round(ncx * 65535.0);
                                        yn = (ushort)Math.Round(ncy * 65535.0);
                                    }
                                    IntPtr hi = NativeWin32.CopyIcon(ci.hCursor);
                                    if (hi != IntPtr.Zero)
                                    {
                                        NativeWin32.ICONINFO ii;
                                        int cx = rawX, cy = rawY;
                                        if (NativeWin32.GetIconInfo(hi, out ii)) { cx -= ii.xHotspot; cy -= ii.yHotspot; if (ii.hbmMask != IntPtr.Zero) NativeWin32.DeleteObject(ii.hbmMask); if (ii.hbmColor != IntPtr.Zero) NativeWin32.DeleteObject(ii.hbmColor); }
                                        double sx = (double)dw / swW, sy = (double)dh / swH;
                                        NativeWin32.DrawIconEx(hDCs[slot], (int)(cx * sx), (int)(cy * sy), hi, Math.Max(14, (int)(32 * sx)), Math.Max(14, (int)(32 * sy)), 0, IntPtr.Zero, 3);
                                        NativeWin32.DestroyIcon(hi);
                                    }
                                }
                                NativeWin32.GdiFlush();
                            }
                        }
                        finally { NativeWin32.ReleaseDC(IntPtr.Zero, hScr); }
                    }
                    cVis[slot] = vis; cxArr[slot] = xn; cyArr[slot] = yn;
                    if (!capOk) using (var g = Graphics.FromImage(bmps[slot])) g.Clear(Color.FromArgb(3, 3, 5));

                    long nextSeq = Interlocked.Increment(ref capSeq);
                    lock (ringLock)
                    {
                        for (int i = 0; i < slots; i++) if (i != slot && states[i] == 2) states[i] = 0;
                        seqs[slot] = nextSeq;
                        states[slot] = 2;
                        Monitor.Pulse(ringLock);
                    }
                    if (!capOk) { Thread.Sleep(24); continue; }
                    int wait = Math.Max(8, 1000 / fps) - (int)sw.ElapsedMilliseconds;
                    if (wait > 1) Thread.Sleep(wait);
                }
            }
            finally
            {
                streamAlive = false;
                lock (ringLock) { Monitor.PulseAll(ringLock); }
                lock (outLock) { Monitor.PulseAll(outLock); }
                try { w1.Join(200); } catch { }
                try { w2.Join(200); } catch { }
                try { w3.Join(200); } catch { }
                try { w4.Join(200); } catch { }
                for (int i = 0; i < slots; i++) { bmps[i].Dispose(); NativeWin32.DeleteObject(hDibs[i]); NativeWin32.DeleteDC(hDCs[i]); }
                if (timerSet) { try { NativeWin32.timeEndPeriod(1); } catch { } }
            }
        }

        private void WriteJson(HttpListenerResponse res, int status, object obj)
        {
            byte[] b = Encoding.UTF8.GetBytes(_json.Serialize(obj));
            res.StatusCode = status;
            res.ContentType = "application/json; charset=utf-8";
            res.Headers["Cache-Control"] = "no-store";
            res.ContentLength64 = b.Length;
            res.OutputStream.Write(b, 0, b.Length);
            res.Close();
        }

        private static string GetMime(string ext)
        {
            switch (ext.ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".ico": return "image/x-icon";
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".woff2": return "font/woff2";
                case ".exe": return "application/vnd.microsoft.portable-executable";
                default: return "application/octet-stream";
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string desktopDir = Path.Combine(baseDir, "desktop-app");
            string nativeHostJs = Path.Combine(desktopDir, "native-host.js");
            string electronExe = Path.Combine(desktopDir, "node_modules", "electron", "dist", "electron.exe");

            bool forceElectron = false, forceStandalone = false, checkOnly = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--electron", StringComparison.OrdinalIgnoreCase)) forceElectron = true;
                else if (string.Equals(a, "--standalone", StringComparison.OrdinalIgnoreCase)) forceStandalone = true;
                else if (string.Equals(a, "--check", StringComparison.OrdinalIgnoreCase)) checkOnly = true;
            }

            if (forceElectron && File.Exists(electronExe))
            {
                return LaunchProcess(electronExe, "\"" + desktopDir + "\"", desktopDir);
            }

            if (!forceStandalone)
            {
                string nodeExe = FindNodeExecutable();
                if (!string.IsNullOrEmpty(nodeExe) && File.Exists(nativeHostJs))
                {
                    if (checkOnly) return 0;
                    return LaunchProcess(nodeExe, "\"" + nativeHostJs + "\"", baseDir);
                }
            }

            // Universal Zero-Dependency Standalone Host (Works on ANY Windows 10/11 PC without Node or Electron!)
            return new StandaloneHost(baseDir).Run(checkOnly);
        }

        public static Process LaunchHardwareBrowser(string url)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] browsers = new[]
            {
                Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe")
            };
            foreach (string exe in browsers)
            {
                if (!string.IsNullOrEmpty(exe) && File.Exists(exe))
                {
                    string profile = Path.Combine(local, "SwiftDrop", "BrowserProfile");
                    Directory.CreateDirectory(profile);
                    string bArgs = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --window-size=1140,780 --no-first-run --no-default-browser-check --disable-background-mode --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --enable-features=WebRTCHardwareVideoEncoding,WebRTCHardwareVideoDecoding";
                    return Process.Start(new ProcessStartInfo { FileName = exe, Arguments = bArgs, UseShellExecute = false });
                }
            }
            return null;
        }

        private static string FindNodeExecutable()
        {
            string[] known = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
            };
            foreach (string c in known) if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
            string envPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string dir in envPath.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                try { string f = Path.Combine(dir.Trim(), "node.exe"); if (File.Exists(f)) return f; } catch { }
            }
            return null;
        }

        private static int LaunchProcess(string exePath, string arguments, string workingDir)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = arguments,
                    WorkingDirectory = workingDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                return Process.Start(psi) == null ? 1 : 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Không thể khởi chạy SyloBeam Desktop:\n" + ex.Message, "SyloBeam Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
