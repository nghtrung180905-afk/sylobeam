$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$csharpCode = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class SwiftDropWin32 {
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();

    private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));

    private static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
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
        { "vol_mute", 0xAD }, { "vol_down", 0xAE }, { "vol_up", 0xAF },
        { "media_next", 0xB0 }, { "media_prev", 0xB1 }, { "media_stop", 0xB2 }, { "media_play_pause", 0xB3 }
    };

    public static void Init() {
        try { SetProcessDPIAware(); } catch {}
    }

    public static int ScreenWidth() { return Math.Max(1, GetSystemMetrics(0)); }
    public static int ScreenHeight() { return Math.Max(1, GetSystemMetrics(1)); }

    public static void MoveRelative(int dx, int dy) {
        if (dx == 0 && dy == 0) return;
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = dx;
        inputs[0].U.mi.dy = dy;
        inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE;
        SendInput(1, inputs, InputSize);
    }

    public static void MoveAbsoluteNormalized(double nx, double ny) {
        double cx = Math.Max(0.0, Math.Min(1.0, nx));
        double cy = Math.Max(0.0, Math.Min(1.0, ny));
        int sw = ScreenWidth();
        int sh = ScreenHeight();
        int px = (int)Math.Round(cx * Math.Max(1, sw - 1));
        int py = (int)Math.Round(cy * Math.Max(1, sh - 1));
        SetCursorPos(px, py);
        // Dispatch both SetCursorPos and hardware SendInput so Windows 11 moves cursor across all apps/games
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = (int)Math.Round(cx * 65535.0);
        inputs[0].U.mi.dy = (int)Math.Round(cy * 65535.0);
        inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        SendInput(1, inputs, InputSize);
    }

    private static uint ButtonFlag(string button, bool down) {
        if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) {
            return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        }
        if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) {
            return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        }
        return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    }

    public static void MouseButton(string button, bool down) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dwFlags = ButtonFlag(button, down);
        SendInput(1, inputs, InputSize);
    }

    public static void MouseClick(string button, int count) {
        int clicks = Math.Max(1, Math.Min(2, count));
        uint downFlag = ButtonFlag(button, true);
        uint upFlag = ButtonFlag(button, false);
        INPUT[] inputs = new INPUT[clicks * 2];
        for (int i = 0; i < clicks; i++) {
            inputs[i * 2].type = INPUT_MOUSE;
            inputs[i * 2].U.mi.dwFlags = downFlag;
            inputs[i * 2 + 1].type = INPUT_MOUSE;
            inputs[i * 2 + 1].U.mi.dwFlags = upFlag;
        }
        SendInput((uint)inputs.Length, inputs, InputSize);
    }

    public static void MouseScroll(int deltaY, int deltaX) {
        var list = new List<INPUT>(2);
        if (deltaY != 0) {
            INPUT inp = new INPUT();
            inp.type = INPUT_MOUSE;
            inp.U.mi.dwFlags = MOUSEEVENTF_WHEEL;
            inp.U.mi.mouseData = unchecked((uint)deltaY);
            list.Add(inp);
        }
        if (deltaX != 0) {
            INPUT inp = new INPUT();
            inp.type = INPUT_MOUSE;
            inp.U.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            inp.U.mi.mouseData = unchecked((uint)deltaX);
            list.Add(inp);
        }
        if (list.Count > 0) {
            SendInput((uint)list.Count, list.ToArray(), InputSize);
        }
    }

    private static ushort ResolveVk(string key) {
        if (string.IsNullOrEmpty(key)) return 0;
        ushort vk;
        if (KeyMap.TryGetValue(key, out vk)) return vk;
        if (key.Length == 1) {
            char c = char.ToUpperInvariant(key[0]);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
                return (ushort)c;
            }
        }
        return 0;
    }

    public static void PressKey(string key) {
        ushort vk = ResolveVk(key);
        if (vk == 0) return;
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = vk;
        inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(2, inputs, InputSize);
    }

    public static void PressCombo(string[] keys) {
        if (keys == null || keys.Length == 0) return;
        var vks = new List<ushort>();
        foreach (string k in keys) {
            ushort vk = ResolveVk(k);
            if (vk != 0) vks.Add(vk);
        }
        if (vks.Count == 0) return;

        var inputs = new List<INPUT>(vks.Count * 2);
        for (int i = 0; i < vks.Count; i++) {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wVk = vks[i];
            inputs.Add(down);
        }
        for (int i = vks.Count - 1; i >= 0; i--) {
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.U.ki.wVk = vks[i];
            up.U.ki.dwFlags = KEYEVENTF_KEYUP;
            inputs.Add(up);
        }
        SendInput((uint)inputs.Count, inputs.ToArray(), InputSize);
    }

    public static void TypeUnicodeText(string text) {
        if (string.IsNullOrEmpty(text)) return;
        if (text.Length > 500) text = text.Substring(0, 500);
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (char ch in text) {
            if (ch == '\r') continue;
            if (ch == '\n') {
                INPUT d = new INPUT(); d.type = INPUT_KEYBOARD; d.U.ki.wVk = 0x0D; inputs.Add(d);
                INPUT u = new INPUT(); u.type = INPUT_KEYBOARD; u.U.ki.wVk = 0x0D; u.U.ki.dwFlags = KEYEVENTF_KEYUP; inputs.Add(u);
                continue;
            }
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wScan = (ushort)ch;
            down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs.Add(down);

            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.U.ki.wScan = (ushort)ch;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            inputs.Add(up);
        }
        if (inputs.Count > 0) {
            SendInput((uint)inputs.Count, inputs.ToArray(), InputSize);
        }
    }

    public static void LockPc() {
        LockWorkStation();
    }

    private static double ToDouble(Dictionary<string, object> map, string key, double fallback) {
        object val;
        if (!map.TryGetValue(key, out val) || val == null) return fallback;
        try { return Convert.ToDouble(val, CultureInfo.InvariantCulture); } catch { return fallback; }
    }

    private static int ToInt(Dictionary<string, object> map, string key, int fallback) {
        return (int)Math.Round(ToDouble(map, key, fallback));
    }

    private static bool ToBool(Dictionary<string, object> map, string key) {
        object val;
        if (!map.TryGetValue(key, out val) || val == null) return false;
        try { return Convert.ToBoolean(val); } catch { return false; }
    }

    private static string ToStr(Dictionary<string, object> map, string key, string fallback) {
        object val;
        if (!map.TryGetValue(key, out val) || val == null) return fallback;
        return Convert.ToString(val);
    }

    // Ultra-fast pure C# stdin event loop (< 0.04ms per mouse move, zero PowerShell overhead)
    public static void RunLoop() {
        Init();
        int w = ScreenWidth();
        int h = ScreenHeight();
        Console.Out.WriteLine("{\"ready\":true,\"width\":" + w + ",\"height\":" + h + "}");
        Console.Out.Flush();

        var serializer = new JavaScriptSerializer();
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            if (line.Length == 0) continue;
            try {
                // Fast-path compact binary-style text protocol for 60-120Hz mouse events
                if (line.Length > 2 && line[1] == '|') {
                    char code = line[0];
                    string[] p = line.Split('|');
                    if (code == 'A' && p.Length >= 3) {
                        double nx = double.Parse(p[1], CultureInfo.InvariantCulture);
                        double ny = double.Parse(p[2], CultureInfo.InvariantCulture);
                        MoveAbsoluteNormalized(nx, ny);
                        continue;
                    }
                    if (code == 'M' && p.Length >= 3) {
                        int dx = int.Parse(p[1], CultureInfo.InvariantCulture);
                        int dy = int.Parse(p[2], CultureInfo.InvariantCulture);
                        MoveRelative(dx, dy);
                        continue;
                    }
                    if (code == 'S' && p.Length >= 3) {
                        int dy = int.Parse(p[1], CultureInfo.InvariantCulture);
                        int dx = int.Parse(p[2], CultureInfo.InvariantCulture);
                        MouseScroll(dy, dx);
                        continue;
                    }
                }

                // Full JSON protocol for clicks, drags, keyboard, Unicode text & system commands
                var cmd = serializer.DeserializeObject(line) as Dictionary<string, object>;
                if (cmd == null) continue;
                string action = ToStr(cmd, "action", "");
                switch (action) {
                    case "ping": {
                        int cw = ScreenWidth();
                        int ch = ScreenHeight();
                        Console.Out.WriteLine("{\"ok\":true,\"width\":" + cw + ",\"height\":" + ch + "}");
                        Console.Out.Flush();
                        break;
                    }
                    case "mouse_move": {
                        MoveRelative(ToInt(cmd, "dx", 0), ToInt(cmd, "dy", 0));
                        break;
                    }
                    case "mouse_abs": {
                        MoveAbsoluteNormalized(ToDouble(cmd, "nx", 0), ToDouble(cmd, "ny", 0));
                        string btn = ToStr(cmd, "button", "left");
                        if (ToBool(cmd, "down")) {
                            MouseButton(btn, true);
                        } else if (ToBool(cmd, "up")) {
                            MouseButton(btn, false);
                        } else if (ToBool(cmd, "click")) {
                            MouseClick(btn, ToInt(cmd, "count", 1));
                        }
                        break;
                    }
                    case "mouse_click": {
                        MouseClick(ToStr(cmd, "button", "left"), ToInt(cmd, "count", 1));
                        break;
                    }
                    case "mouse_down": {
                        MouseButton(ToStr(cmd, "button", "left"), true);
                        break;
                    }
                    case "mouse_up": {
                        MouseButton(ToStr(cmd, "button", "left"), false);
                        break;
                    }
                    case "mouse_scroll": {
                        MouseScroll(ToInt(cmd, "dy", 0), ToInt(cmd, "dx", 0));
                        break;
                    }
                    case "key_press": {
                        string k = ToStr(cmd, "key", "");
                        if (!string.IsNullOrEmpty(k)) PressKey(k);
                        break;
                    }
                    case "key_combo": {
                        object rawKeys;
                        if (cmd.TryGetValue("keys", out rawKeys) && rawKeys is object[]) {
                            object[] arr = (object[])rawKeys;
                            string[] strs = new string[arr.Length];
                            for (int i = 0; i < arr.Length; i++) strs[i] = Convert.ToString(arr[i]);
                            PressCombo(strs);
                        }
                        break;
                    }
                    case "key_text": {
                        string txt = ToStr(cmd, "text", "");
                        if (!string.IsNullOrEmpty(txt)) TypeUnicodeText(txt);
                        break;
                    }
                    case "system_action": {
                        string sys = ToStr(cmd, "command", "");
                        if (sys == "lock_pc") LockPc();
                        else if (!string.IsNullOrEmpty(sys)) PressKey(sys);
                        break;
                    }
                }
            } catch {
                // Ignore malformed command
            }
        }
    }
}
'@

Add-Type -TypeDefinition $csharpCode -Language CSharp -ReferencedAssemblies System.Web.Extensions
[SwiftDropWin32]::RunLoop()
