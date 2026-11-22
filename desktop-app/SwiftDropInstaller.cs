using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace SwiftDropInstaller
{
    internal static class InstallerCore
    {
        public const string ResourceName = "SwiftDropPayload.zip";
        public const string UninstallRegPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\SyloBeam";
        public const string AppVersion = "2.0.0";

        public static string GetDefaultInstallDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "SyloBeam"
            );
        }

        public static string GetDesktopShortcutPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "SyloBeam.lnk"
            );
        }

        public static string GetStartMenuFolder()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                "SyloBeam"
            );
        }

        public static string GetStartMenuShortcutPath()
        {
            return Path.Combine(GetStartMenuFolder(), "SyloBeam.lnk");
        }

        public static Stream OpenPayloadStream()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream s = asm.GetManifestResourceStream(ResourceName);
            if (s != null) return s;
            foreach (string name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("SwiftDropPayload.zip", StringComparison.OrdinalIgnoreCase))
                {
                    return asm.GetManifestResourceStream(name);
                }
            }
            throw new InvalidOperationException("Không tìm thấy dữ liệu cài đặt nhúng (SwiftDropPayload.zip).");
        }

        public static bool VerifyEmbeddedPayload(out int entryCount, out long totalBytes, out string detail)
        {
            entryCount = 0;
            totalBytes = 0;
            bool hasExe = false;
            bool hasCapture = false;
            bool hasIndex = false;

            using (Stream raw = OpenPayloadStream())
            using (ZipArchive zip = new ZipArchive(raw, ZipArchiveMode.Read, false))
            {
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    if (string.IsNullOrEmpty(e.Name)) continue;
                    entryCount++;
                    totalBytes += e.Length;
                    string norm = e.FullName.Replace('/', '\\');
                    if (string.Equals(norm, "SyloBeam.exe", StringComparison.OrdinalIgnoreCase)) hasExe = true;
                    if (string.Equals(norm, @"desktop-app\SwiftDropCapture.exe", StringComparison.OrdinalIgnoreCase)) hasCapture = true;
                    if (string.Equals(norm, "index.html", StringComparison.OrdinalIgnoreCase)) hasIndex = true;
                }
            }

            detail = string.Format("entries={0}, bytes={1}, exe={2}, capture={3}, index={4}", entryCount, totalBytes, hasExe, hasCapture, hasIndex);
            return hasExe && hasCapture && hasIndex;
        }

        public static void StopRunningSwiftDropProcesses()
        {
            string[] names = new[] { "SyloBeam", "SwiftDrop", "SwiftDropCapture" };
            foreach (string n in names)
            {
                try
                {
                    Process[] procs = Process.GetProcessesByName(n);
                    foreach (Process p in procs)
                    {
                        try
                        {
                            if (!p.HasExited)
                            {
                                p.CloseMainWindow();
                                if (!p.WaitForExit(350))
                                {
                                    p.Kill();
                                    p.WaitForExit(500);
                                }
                            }
                        }
                        catch { }
                        finally
                        {
                            try { p.Dispose(); } catch { }
                        }
                    }
                }
                catch { }
            }
        }

        public static void ExtractPayloadTo(string installDir, Action<int, string> onProgress)
        {
            string fullRoot = Path.GetFullPath(installDir);
            Directory.CreateDirectory(fullRoot);
            string rootPrefix = fullRoot.EndsWith(Path.DirectorySeparatorChar.ToString())
                ? fullRoot
                : fullRoot + Path.DirectorySeparatorChar;

            using (Stream raw = OpenPayloadStream())
            using (ZipArchive zip = new ZipArchive(raw, ZipArchiveMode.Read, false))
            {
                int total = Math.Max(1, zip.Entries.Count);
                int idx = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    idx++;
                    string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                    if (string.IsNullOrWhiteSpace(rel) || string.IsNullOrEmpty(entry.Name))
                    {
                        continue;
                    }

                    string destPath = Path.GetFullPath(Path.Combine(fullRoot, rel));
                    if (!destPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("Đường dẫn tệp trong gói cài đặt không hợp lệ: " + rel);
                    }

                    string parentDir = Path.GetDirectoryName(destPath);
                    if (!string.IsNullOrEmpty(parentDir))
                    {
                        Directory.CreateDirectory(parentDir);
                    }

                    using (Stream src = entry.Open())
                    using (FileStream dst = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        src.CopyTo(dst);
                    }

                    if (onProgress != null)
                    {
                        int pct = 10 + (int)Math.Round((idx * 70.0) / total);
                        onProgress(pct, "Đang giải nén: " + entry.Name);
                    }
                }
            }
        }

        public static void CreateShortcut(string shortcutPath, string targetExe, string workingDir, string iconPath, string description)
        {
            string dir = Path.GetDirectoryName(shortcutPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            Type tShell = Type.GetTypeFromProgID("WScript.Shell");
            if (tShell == null)
            {
                throw new InvalidOperationException("WScript.Shell không khả dụng trên hệ thống.");
            }
            object shell = Activator.CreateInstance(tShell);
            object shortcut = null;
            try
            {
                shortcut = tShell.InvokeMember(
                    "CreateShortcut",
                    BindingFlags.InvokeMethod,
                    null,
                    shell,
                    new object[] { shortcutPath }
                );
                Type tSc = shortcut.GetType();
                tSc.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetExe });
                tSc.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                tSc.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
                if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
                {
                    tSc.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath + ",0" });
                }
                tSc.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut))
                {
                    try { Marshal.FinalReleaseComObject(shortcut); } catch { }
                }
                if (shell != null && Marshal.IsComObject(shell))
                {
                    try { Marshal.FinalReleaseComObject(shell); } catch { }
                }
            }
        }

        public static void WriteUninstallRegistration(string installDir)
        {
            string iconPath = Path.Combine(installDir, "assets", "swiftdrop.ico");
            string uninstallExe = Path.Combine(installDir, "Uninstall.exe");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallRegPath))
            {
                if (key != null)
                {
                    key.SetValue("DisplayName", "SyloBeam");
                    key.SetValue("DisplayVersion", AppVersion);
                    key.SetValue("Publisher", "SyloBeam P2P");
                    key.SetValue("InstallLocation", installDir);
                    if (File.Exists(iconPath)) key.SetValue("DisplayIcon", iconPath);
                    key.SetValue("UninstallString", "\"" + uninstallExe + "\" --uninstall");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("EstimatedSize", 1024, RegistryValueKind.DWord);
                }
            }
        }

        public static int RunSilentTestDir(string targetDir)
        {
            string fullDir = Path.GetFullPath(targetDir);
            ExtractPayloadTo(fullDir, null);
            string targetExe = Path.Combine(fullDir, "SyloBeam.exe");
            string iconPath = Path.Combine(fullDir, "assets", "swiftdrop.ico");
            string uninstallExe = Path.Combine(fullDir, "Uninstall.exe");
            File.Copy(Application.ExecutablePath, uninstallExe, true);
            CreateShortcut(
                Path.Combine(fullDir, "SyloBeam-Test.lnk"),
                targetExe,
                fullDir,
                iconPath,
                "SyloBeam P2P File Share & 60Hz Remote Control"
            );
            return File.Exists(targetExe) && File.Exists(Path.Combine(fullDir, "SyloBeam-Test.lnk")) ? 0 : 2;
        }

        public static int RunUninstall()
        {
            DialogResult confirm = MessageBox.Show(
                "Bạn có chắc chắn muốn gỡ cài đặt SyloBeam khỏi máy tính này?\n(Các file bạn đã tải về trong Downloads sẽ được giữ nguyên.)",
                "Gỡ cài đặt SyloBeam",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return 0;

            StopRunningSwiftDropProcesses();

            string installDir = "";
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallRegPath))
                {
                    if (key != null)
                    {
                        installDir = Convert.ToString(key.GetValue("InstallLocation") ?? "");
                    }
                }
            }
            catch { }

            if (string.IsNullOrWhiteSpace(installDir))
            {
                installDir = AppDomain.CurrentDomain.BaseDirectory;
            }
            installDir = Path.GetFullPath(installDir);

            try { if (File.Exists(GetDesktopShortcutPath())) File.Delete(GetDesktopShortcutPath()); } catch { }
            try
            {
                string sm = GetStartMenuFolder();
                if (Directory.Exists(sm)) Directory.Delete(sm, true);
            }
            catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath, false); } catch { }

            // Delete folder cleanly after Uninstall.exe exits if inside installDir
            string defaultSafePrefix = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (Directory.Exists(installDir) &&
                installDir.StartsWith(defaultSafePrefix, StringComparison.OrdinalIgnoreCase) &&
                File.Exists(Path.Combine(installDir, "SyloBeam.exe")))
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + installDir + "\"",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(psi);
                }
                catch { }
            }

            MessageBox.Show(
                "Đã gỡ cài đặt SyloBeam thành công.",
                "SyloBeam",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            return 0;
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Color BgObsidian = Color.FromArgb(8, 9, 11);
        private readonly Color SurfaceCard = Color.FromArgb(16, 18, 22);
        private readonly Color BorderSubtle = Color.FromArgb(38, 44, 54);
        private readonly Color TextPrimary = Color.FromArgb(244, 245, 247);
        private readonly Color TextMuted = Color.FromArgb(148, 163, 184);
        private readonly Color AccentSteel = Color.FromArgb(125, 163, 192);

        private Panel _stepWelcome;
        private Panel _stepProgress;
        private Panel _stepComplete;

        private TextBox _txtPath;
        private CheckBox _chkDesktop;
        private CheckBox _chkStartMenu;
        private CheckBox _chkLaunch;
        private ProgressBar _progressBar;
        private Label _lblProgressStatus;
        private Label _lblCompleteSummary;
        private string _installedExePath = "";

        public SetupForm()
        {
            Text = "Cài đặt SyloBeam";
            ClientSize = new Size(560, 410);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = BgObsidian;
            ForeColor = TextPrimary;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            try
            {
                Icon assoc = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (assoc != null) Icon = assoc;
            }
            catch { }

            BuildHeader();
            BuildWelcomePanel();
            BuildProgressPanel();
            BuildCompletePanel();
            ShowStep(0);
        }

        private void BuildHeader()
        {
            Panel hdr = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = SurfaceCard
            };
            hdr.Paint += (s, e) =>
            {
                using (Pen p = new Pen(BorderSubtle, 1))
                {
                    e.Graphics.DrawLine(p, 0, hdr.Height - 1, hdr.Width, hdr.Height - 1);
                }
                using (SolidBrush b = new SolidBrush(AccentSteel))
                {
                    e.Graphics.FillRectangle(b, 24, 20, 4, 36);
                }
            };

            Label lblTitle = new Label
            {
                Text = "SYLOBEAM DESKTOP",
                Font = new Font("Segoe UI Semibold", 13.5f, FontStyle.Bold),
                ForeColor = TextPrimary,
                Location = new Point(38, 17),
                AutoSize = true
            };

            Label lblSub = new Label
            {
                Text = "Chia sẻ file P2P & Điều khiển PC 60Hz DXGI • Trình cài đặt chính thức",
                Font = new Font("Segoe UI", 9f),
                ForeColor = TextMuted,
                Location = new Point(38, 43),
                AutoSize = true
            };

            hdr.Controls.Add(lblTitle);
            hdr.Controls.Add(lblSub);
            Controls.Add(hdr);
        }

        private void BuildWelcomePanel()
        {
            _stepWelcome = new Panel
            {
                Location = new Point(0, 76),
                Size = new Size(560, 334),
                BackColor = BgObsidian
            };

            Label lblIntro = new Label
            {
                Text = "Trình hướng dẫn sẽ cài đặt SyloBeam vào máy tính của bạn, tự động tạo lối tắt trên màn hình nền (Desktop) để khởi chạy nhanh như một ứng dụng Windows.",
                Location = new Point(26, 20),
                Size = new Size(508, 40),
                ForeColor = TextMuted
            };

            Label lblDir = new Label
            {
                Text = "Thư mục cài đặt:",
                Location = new Point(26, 74),
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                ForeColor = TextPrimary
            };

            _txtPath = new TextBox
            {
                Text = InstallerCore.GetDefaultInstallDir(),
                Location = new Point(26, 98),
                Size = new Size(414, 27),
                BackColor = SurfaceCard,
                ForeColor = TextPrimary,
                BorderStyle = BorderStyle.FixedSingle
            };

            Button btnBrowse = new Button
            {
                Text = "Chọn...",
                Location = new Point(448, 97),
                Size = new Size(86, 27),
                FlatStyle = FlatStyle.Flat,
                BackColor = SurfaceCard,
                ForeColor = TextPrimary,
                Cursor = Cursors.Hand
            };
            btnBrowse.FlatAppearance.BorderColor = BorderSubtle;
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "Chọn thư mục cài đặt SyloBeam";
                    dlg.ShowNewFolderButton = true;
                    if (Directory.Exists(_txtPath.Text)) dlg.SelectedPath = _txtPath.Text;
                    if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath))
                    {
                        _txtPath.Text = Path.Combine(dlg.SelectedPath, "SyloBeam");
                    }
                }
            };

            _chkDesktop = new CheckBox
            {
                Text = "Tạo biểu tượng trên màn hình nền (Desktop Shortcut)",
                Checked = true,
                Location = new Point(26, 146),
                Size = new Size(500, 24),
                ForeColor = TextPrimary
            };

            _chkStartMenu = new CheckBox
            {
                Text = "Thêm vào Start Menu của Windows",
                Checked = true,
                Location = new Point(26, 174),
                Size = new Size(500, 24),
                ForeColor = TextPrimary
            };

            _chkLaunch = new CheckBox
            {
                Text = "Khởi động SyloBeam ngay sau khi cài đặt xong",
                Checked = true,
                Location = new Point(26, 202),
                Size = new Size(500, 24),
                ForeColor = TextPrimary
            };

            Button btnCancel = new Button
            {
                Text = "Hủy",
                Location = new Point(320, 274),
                Size = new Size(96, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = SurfaceCard,
                ForeColor = TextMuted,
                Cursor = Cursors.Hand
            };
            btnCancel.FlatAppearance.BorderColor = BorderSubtle;
            btnCancel.Click += (s, e) => Close();

            Button btnInstall = new Button
            {
                Text = "Cài đặt ngay",
                Location = new Point(426, 274),
                Size = new Size(108, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(244, 245, 247),
                ForeColor = Color.FromArgb(8, 9, 11),
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += OnStartInstallClick;

            _stepWelcome.Controls.AddRange(new Control[]
            {
                lblIntro, lblDir, _txtPath, btnBrowse,
                _chkDesktop, _chkStartMenu, _chkLaunch,
                btnCancel, btnInstall
            });
            Controls.Add(_stepWelcome);
        }

        private void BuildProgressPanel()
        {
            _stepProgress = new Panel
            {
                Location = new Point(0, 76),
                Size = new Size(560, 334),
                BackColor = BgObsidian
            };

            Label lblWait = new Label
            {
                Text = "Đang cài đặt SyloBeam Desktop...",
                Location = new Point(26, 78),
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 11f, FontStyle.Bold),
                ForeColor = TextPrimary
            };

            _progressBar = new ProgressBar
            {
                Location = new Point(26, 114),
                Size = new Size(508, 22),
                Minimum = 0,
                Maximum = 100,
                Style = ProgressBarStyle.Continuous
            };

            _lblProgressStatus = new Label
            {
                Text = "Đang chuẩn bị dữ liệu cài đặt...",
                Location = new Point(26, 146),
                Size = new Size(508, 24),
                ForeColor = TextMuted
            };

            _stepProgress.Controls.AddRange(new Control[] { lblWait, _progressBar, _lblProgressStatus });
            Controls.Add(_stepProgress);
        }

        private void BuildCompletePanel()
        {
            _stepComplete = new Panel
            {
                Location = new Point(0, 76),
                Size = new Size(560, 334),
                BackColor = BgObsidian
            };

            Label lblDone = new Label
            {
                Text = "Cài đặt hoàn tất!",
                Location = new Point(26, 48),
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 14f, FontStyle.Bold),
                ForeColor = AccentSteel
            };

            _lblCompleteSummary = new Label
            {
                Text = "",
                Location = new Point(26, 90),
                Size = new Size(508, 120),
                ForeColor = TextMuted
            };

            Button btnFinish = new Button
            {
                Text = "Hoàn tất",
                Location = new Point(418, 274),
                Size = new Size(116, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(244, 245, 247),
                ForeColor = Color.FromArgb(8, 9, 11),
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnFinish.FlatAppearance.BorderSize = 0;
            btnFinish.Click += (s, e) =>
            {
                if (_chkLaunch.Checked && !string.IsNullOrEmpty(_installedExePath) && File.Exists(_installedExePath))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = _installedExePath,
                            WorkingDirectory = Path.GetDirectoryName(_installedExePath),
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
                Close();
            };

            _stepComplete.Controls.AddRange(new Control[] { lblDone, _lblCompleteSummary, btnFinish });
            Controls.Add(_stepComplete);
        }

        private void ShowStep(int idx)
        {
            _stepWelcome.Visible = (idx == 0);
            _stepProgress.Visible = (idx == 1);
            _stepComplete.Visible = (idx == 2);
        }

        private void UpdateProgress(int pct, string text)
        {
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke(new Action(() =>
            {
                _progressBar.Value = Math.Max(0, Math.Min(100, pct));
                _lblProgressStatus.Text = text;
            }));
        }

        private void OnStartInstallClick(object sender, EventArgs e)
        {
            string rawDir = (_txtPath.Text ?? "").Trim();
            if (string.IsNullOrEmpty(rawDir))
            {
                MessageBox.Show("Vui lòng chọn thư mục cài đặt hợp lệ.", "SyloBeam Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string installDir;
            try
            {
                installDir = Path.GetFullPath(rawDir);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Đường dẫn không hợp lệ:\n" + ex.Message, "SyloBeam Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            bool makeDesktop = _chkDesktop.Checked;
            bool makeStartMenu = _chkStartMenu.Checked;

            ShowStep(1);
            ControlBox = false;

            Thread worker = new Thread(() =>
            {
                try
                {
                    UpdateProgress(5, "Đang đóng các phiên SyloBeam cũ nếu đang chạy...");
                    InstallerCore.StopRunningSwiftDropProcesses();

                    InstallerCore.ExtractPayloadTo(installDir, UpdateProgress);

                    UpdateProgress(85, "Đang cài đặt trình gỡ bỏ & thông tin hệ thống...");
                    string targetExe = Path.Combine(installDir, "SyloBeam.exe");
                    string iconPath = Path.Combine(installDir, "assets", "swiftdrop.ico");
                    string uninstallExe = Path.Combine(installDir, "Uninstall.exe");
                    File.Copy(Application.ExecutablePath, uninstallExe, true);

                    UpdateProgress(92, "Đang tạo lối tắt trên Desktop & Start Menu...");
                    if (makeDesktop)
                    {
                        InstallerCore.CreateShortcut(
                            InstallerCore.GetDesktopShortcutPath(),
                            targetExe,
                            installDir,
                            iconPath,
                            "SyloBeam — Chia sẻ file P2P & Điều khiển PC 60Hz"
                        );
                    }
                    if (makeStartMenu)
                    {
                        InstallerCore.CreateShortcut(
                            InstallerCore.GetStartMenuShortcutPath(),
                            targetExe,
                            installDir,
                            iconPath,
                            "SyloBeam — Chia sẻ file P2P & Điều khiển PC 60Hz"
                        );
                    }

                    UpdateProgress(97, "Đang đăng ký ứng dụng với Windows...");
                    InstallerCore.WriteUninstallRegistration(installDir);
                    UpdateProgress(100, "Hoàn tất!");

                    BeginInvoke(new Action(() =>
                    {
                        ControlBox = true;
                        _installedExePath = targetExe;
                        _lblCompleteSummary.Text =
                            "SyloBeam đã được cài đặt thành công tại:\n" + installDir + "\n\n" +
                            (makeDesktop ? "• Đã tạo biểu tượng SyloBeam ngoài Desktop.\n" : "") +
                            (makeStartMenu ? "• Đã thêm vào Start Menu & danh sách Ứng dụng Windows.\n" : "") +
                            "\nBạn có thể mở app bất cứ lúc nào từ Desktop!";
                        ShowStep(2);
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(() =>
                    {
                        ControlBox = true;
                        ShowStep(0);
                        MessageBox.Show(
                            "Cài đặt không thành công:\n" + ex.Message,
                            "Lỗi cài đặt SyloBeam",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--check", StringComparison.OrdinalIgnoreCase))
                {
                    int cnt;
                    long bytes;
                    string detail;
                    bool ok = InstallerCore.VerifyEmbeddedPayload(out cnt, out bytes, out detail);
                    return ok ? 0 : 1;
                }
                if (string.Equals(args[i], "--silent-test-dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    return InstallerCore.RunSilentTestDir(args[i + 1]);
                }
                if (string.Equals(args[i], "--uninstall", StringComparison.OrdinalIgnoreCase))
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    return InstallerCore.RunUninstall();
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
            return 0;
        }
    }
}
