using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

// DSH-QQ 群小助手 · 托盘启动器（N26）
// - 同一时间只允许一个实例（命名互斥体）
// - 启动时顺带拉起 NapCat，退出时顺带关掉它（只动 NapCat 目录里的进程，绝不碰你自己的 QQ）
// - NapCat 的控制台/QQ 窗口默认藏起来，后台跑
// - 托盘图标用 launcher/DSHQQTray.ico
static class Program
{
    const string AppName = "DSH-QQ 群小助手";
    const string RunKey = "DSHQQTray";
    const string MutexName = "Local\\DSHQQTray.SingleInstance";

    static NotifyIcon tray;
    static Process child;
    static bool childStartFailed;   // 起过一次失败就别每 3 秒再弹一次窗（新机器没装 Node 时就是这种）
    static bool nodeChecked;
    static bool lastNodeOk;

    // 进程对象在"没真正起来"或"已经退出"时，.NET 会抛 InvalidOperationException
    // 「没有与此对象关联的进程」—— 一律吞掉，绝不让它弹窗。
    static bool AliveProc(Process p) { if (p == null) return false; try { return !p.HasExited; } catch { return false; } }
    static int PidOf(Process p) { if (p == null) return -1; try { return p.Id; } catch { return -1; } }
    static string NameOf(Process p) { if (p == null) return "?"; try { return p.ProcessName; } catch { return "?"; } }
    static string root, entry, nodeExe, dataDir, logDir, logFile, configFile, napcatDir, napcatExe;
    static ToolStripMenuItem miStart, miStop, miWeb, miAuto, miStatus, miNapcat, miNapcatStart, miNapcatStop, miNapcatShow, miPorts;
    static Timer timer;
    static readonly object logLock = new object();
    static Icon appIcon;
    static System.Threading.Mutex singleInstance;   // 必须静态持有！局部变量会被 GC 收掉，句柄一关命名互斥体就消失，单实例就失效了
    static bool autoLaunch = true, autoClose = true, hideWindow = true;
    // NapCat 快速登录：给了 QQ 号就按 "NapCatWinBootMain.exe <uin>" 启动（等价于 napcat.quick.bat），
    // 否则走原来的无参启动 = 每次都要手动去控制台选登录。
    static string napcatUin = "";
    // 本地 STT 侧车（tools/stt-server.py）随托盘启停，省得每次手动开。
    static bool sttAutoStart = true;
    static Process sttProc = null;
    static int onebotPort = 3001;
    static int webuiPort = 6099;      // NapCat 网页控制台的端口（app.json 的 runtime.napcatWebui 可改）
    static int hideWatchdogTicks = 0;
    // 意外退出的自愈：每 30 分钟最多自动重启 3 次，避免崩溃循环
    static int autoRestarts = 0;
    static DateTime autoRestartWindow = DateTime.MinValue;
    static bool botWasAlive = false;
    static bool manualStop = false;
    // 已经有一个实例在服务时认领它（避免每次启动都弹『端口被占用』）
    static bool adoptedExisting = false;
    static DateTime lastRecoverTry = DateTime.MinValue;   // 上次尝试自愈的时间（失败要按间隔重试）
    static bool recoveryWarned = false;                  // 自愈放弃时只提示一次
    static int napcatVisibleWindows = 0;
    // 手动"显示 NapCat 窗口"之后，这段时间内巡检不再把它藏回去（登录/扫码要能看见）
    static DateTime showWindowsUntil = DateTime.MinValue;

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    const int SW_HIDE = 0;
    const int SW_SHOW = 5;
    const int SW_RESTORE = 9;

    // 藏窗口不能只看 Process.MainWindowHandle —— 实测 NapCat 那几个进程的主窗口句柄全是 0，
    // 真正露在外面的是 ConPTY 的 PseudoConsoleWindow。所以得按 PID 枚举所有顶层窗口。
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);

    [STAThread]
    static void Main(string[] args)
    {
        // 任何没接住的异常都变成"人话弹窗 + 写日志"，不再让用户看到 .NET 的原始报错
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate (object s, System.Threading.ThreadExceptionEventArgs e) { ReportCrash(e.Exception); };
        AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e) { ReportCrash(e.ExceptionObject as Exception); };
        root = FindRoot();
        entry = Path.Combine(root, "app", "main.js");
        dataDir = Path.Combine(root, "app", "dsh-data");
        logDir = Path.Combine(dataDir, "logs");
        logFile = Path.Combine(logDir, "bot.log");
        configFile = Path.Combine(dataDir, "config", "app.json");
        nodeExe = FindNode();
        LoadNapCatSettings();

        if (args != null && Array.IndexOf(args, "--probe") >= 0) { WriteProbe(); return; }

        // 单实例：已经有一个在跑就提示一声，然后自己退出
        bool createdNew = false;
        singleInstance = new System.Threading.Mutex(true, MutexName, out createdNew);
        if (!createdNew)
        {
            try
            {
                var old = new NotifyIcon();
                old.Icon = LoadIcon();
                old.Visible = true;
                old.BalloonTipTitle = AppName;
                old.BalloonTipText = "已经在运行了，看右下角托盘图标（双击打开配置端）";
                old.ShowBalloonTip(3000);
                System.Threading.Thread.Sleep(2600);
                old.Visible = false;
                old.Dispose();
            }
            catch (Exception) { }
            return;
        }
        GC.KeepAlive(singleInstance);

        var menu = new ContextMenuStrip();
        miStatus = new ToolStripMenuItem("● 未运行") { Enabled = false };
        menu.Items.Add(miStatus);
        miNapcat = new ToolStripMenuItem("NapCat: 检测中…") { Enabled = false };
        menu.Items.Add(miNapcat);
        miPorts = new ToolStripMenuItem("端口: 检测中…") { Enabled = false };
        menu.Items.Add(miPorts);
        menu.Items.Add(new ToolStripSeparator());
        miStart = new ToolStripMenuItem("启动", null, delegate { StartAll(); });
        miStop = new ToolStripMenuItem("停止", null, delegate { StopAll(); });
        menu.Items.Add(miStart);
        menu.Items.Add(miStop);
        menu.Items.Add(new ToolStripMenuItem("重启", null, delegate { StopAll(); StartAll(); }));
        menu.Items.Add(new ToolStripMenuItem("诊断信息（出问题发我）", null, delegate { ShowDiag(); }));
        menu.Items.Add(new ToolStripSeparator());
        miNapcatStart = new ToolStripMenuItem("只启动 NapCat", null, delegate { StartNapCat(); NapCatWaitForPort(20000); Refresh(); });
        miNapcatStop = new ToolStripMenuItem("只关闭 NapCat", null, delegate { StopNapCat(); Refresh(); });
        var miNapcatHide = new ToolStripMenuItem("立刻隐藏 NapCat 窗口", null, delegate { showWindowsUntil = DateTime.MinValue; HideNapCatWindows(); Refresh(); });
        // 掉登录要扫码、看令牌要看控制台 —— 都要求窗口能露出来（默认是全藏的）
        miNapcatShow = new ToolStripMenuItem("显示 NapCat 窗口（登录 / 扫码，10 分钟不自动隐藏）", null, delegate { ShowNapCatWindows(); Refresh(); });
        menu.Items.Add(miNapcatStart);
        menu.Items.Add(miNapcatStop);
        menu.Items.Add(miNapcatShow);
        menu.Items.Add(miNapcatHide);
        menu.Items.Add(new ToolStripMenuItem("复制 NapCat 登录令牌", null, delegate { CopyNapCatToken(); }));
        menu.Items.Add(new ToolStripSeparator());
        miWeb = new ToolStripMenuItem("打开配置端", null, delegate { OpenWeb(); });
        menu.Items.Add(miWeb);
        menu.Items.Add(new ToolStripMenuItem("NapCat 控制台", null, delegate { Shell(NapCatWebUrl()); }));
        menu.Items.Add(new ToolStripMenuItem("打开数据目录", null, delegate { Shell(dataDir); }));
        menu.Items.Add(new ToolStripMenuItem("查看日志", null, delegate { Shell(logFile); }));
        menu.Items.Add(new ToolStripSeparator());
        miAuto = new ToolStripMenuItem("开机自启", null, delegate { ToggleAutoStart(); });
        miAuto.CheckOnClick = true;
        miAuto.Checked = IsAutoStart();
        menu.Items.Add(miAuto);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出（顺带关掉 NapCat）", null, delegate { StopAll(); tray.Visible = false; Application.Exit(); }));

        appIcon = LoadIcon();
        tray = new NotifyIcon();
        tray.Icon = appIcon;
        tray.Text = AppName + " · 已停止";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenWeb(); };

        timer = new Timer();
        timer.Interval = 3000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();

        Refresh();
        if (File.Exists(entry)) StartAll();      // 双击就全套拉起来
        Application.Run();
    }

    // ---------- 路径与配置 ----------
    static string FindRoot()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string p = Path.GetFullPath(baseDir);
        for (int i = 0; i < 3 && p != null; i++)
        {
            if (File.Exists(Path.Combine(p, "app", "main.js"))) return p;
            p = Path.GetDirectoryName(p);
        }
        return Path.GetFullPath(Path.Combine(baseDir, ".."));
    }

    static string FindNode()
    {
        string bundled = Path.Combine(root, "runtime", "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(Path.PathSeparator))
        {
            if (dir.Length == 0) continue;
            try { string c = Path.Combine(dir, "node.exe"); if (File.Exists(c)) return c; } catch (Exception) { }
        }
        return "node";
    }

    static string ReadConfigText()
    {
        try { return File.ReadAllText(configFile, Encoding.UTF8); } catch (Exception) { return ""; }
    }

    static string JsonString(string json, string key, string dflt)
    {
        try
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            if (m.Success) return m.Groups[1].Value;
        }
        catch (Exception) { }
        return dflt;
    }

    static bool JsonBool(string json, string key, bool dflt)
    {
        try
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)");
            if (m.Success) return m.Groups[1].Value == "true";
        }
        catch (Exception) { }
        return dflt;
    }

    static void LoadNapCatSettings()
    {
        string json = ReadConfigText();
        autoLaunch = JsonBool(json, "autoLaunch", true);
        autoClose = JsonBool(json, "autoClose", true);
        hideWindow = JsonBool(json, "hideWindow", true);
        napcatUin = JsonString(json, "uin", "");
        sttAutoStart = JsonBool(json, "sttAutoStart", true);
        string configured = JsonString(json, "launchPath", "");
        string wsUrl = JsonString(json, "wsUrl", "");
        var pm = Regex.Match(wsUrl ?? "", ":(\\d+)");
        if (pm.Success) { int p; if (int.TryParse(pm.Groups[1].Value, out p)) onebotPort = p; }
        var wm = Regex.Match(JsonString(json, "napcatWebui", ""), ":(\\d+)");
        if (wm.Success) { int wp; if (int.TryParse(wm.Groups[1].Value, out wp)) webuiPort = wp; }

        if (configured.Length > 0 && File.Exists(configured)) { napcatExe = configured; }
        else napcatExe = AutoFindNapCat();
        napcatDir = napcatExe == null ? null : NapCatRoot(Path.GetDirectoryName(napcatExe));
    }

    // NapCat 的"势力范围"：找到的 exe 如果在 bootmain/bin 这类子目录里，范围要抬到上一层，
    // 否则会出现"启动了 A 目录的 NapCat，却关不掉真在跑的 B 目录那只"。
    static string NapCatRoot(string exeDir)
    {
        if (exeDir == null) return null;
        string d = Path.GetFullPath(exeDir).TrimEnd('\\');
        string name = Path.GetFileName(d).ToLowerInvariant();
        if (name == "bootmain" || name == "boot" || name == "bin" || name == "launcher" || name == "shell")
        {
            string up = Path.GetDirectoryName(d);
            if (up != null && Path.GetDirectoryName(up.TrimEnd('\\')) != null) return up;   // 别把整个盘当地盘
        }
        return d;
    }

    // 没配置就在常见位置找。机器上可能有好几份 NapCat，优先挑"能真跑起来"的那份：
    // 同目录下有 QQ.exe 的最像本体，目录名带 Shell 的次之。
    static string AutoFindNapCat()
    {
        var roots = new List<string>();
        roots.Add(Path.Combine(root, "napcat"));
        foreach (string drive in new string[] { "E:", "D:", "C:" })
        {
            roots.Add(drive + "\\NapCat");
            roots.Add(drive + "\\Napcat");
            roots.Add(drive + "\\napcat");
        }
        var cands = new List<string>();
        foreach (string r in roots)
        {
            try
            {
                if (!Directory.Exists(r)) continue;
                foreach (string exe in Directory.GetFiles(r, "NapCatWinBootMain.exe", SearchOption.AllDirectories))
                    if (!cands.Contains(exe)) cands.Add(exe);
            }
            catch (Exception) { }
        }
        string best = null;
        int bestScore = -1;
        foreach (string c in cands)
        {
            int score = 0;
            string dir = Path.GetDirectoryName(c);
            try { if (File.Exists(Path.Combine(dir, "QQ.exe"))) score += 4; } catch (Exception) { }
            if (dir.ToLowerInvariant().Contains("shell")) score += 2;
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return best;
    }

    static string NapCatWebUrl()
    {
        string u = JsonString(ReadConfigText(), "napcatWebui", "");
        return u.Length > 0 ? u : "http://127.0.0.1:6099";
    }

    // 端口在听不一定代表小助手活着（强杀后可能残留）；真应答 /api/status 才算。
    static bool PortAnswersHttp(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/status");
            req.Method = "GET";
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using (var resp = (HttpWebResponse)req.GetResponse()) { resp.Close(); }
            return true;
        }
        catch (Exception) { return false; }
    }

    static int ReadPort()
    {
        try
        {
            string txt = ReadConfigText();
            int at = txt.IndexOf("webui");
            if (at < 0) return 8799;
            int pt = txt.IndexOf("port", at);
            if (pt < 0) return 8799;
            int colon = txt.IndexOf(':', pt);
            if (colon < 0) return 8799;
            int i = colon + 1;
            while (i < txt.Length && !char.IsDigit(txt[i])) i++;
            int j = i;
            while (j < txt.Length && char.IsDigit(txt[j])) j++;
            if (j > i) return int.Parse(txt.Substring(i, j - i));
        }
        catch (Exception) { }
        return 8799;
    }

    // ---------- NapCat ----------
    static List<Process> NapCatProcesses()
    {
        var list = new List<Process>();
        if (napcatDir == null) return list;
        string dir = Path.GetFullPath(napcatDir).TrimEnd('\\') + "\\";   // 只认这个目录树下的进程，你自己装的 QQ 在别处，绝不会被牵连
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                string path = p.MainModule == null ? null : p.MainModule.FileName;
                if (path == null) { p.Dispose(); continue; }
                if (Path.GetFullPath(path).StartsWith(dir, StringComparison.OrdinalIgnoreCase)) list.Add(p);
                else p.Dispose();
            }
            catch (Exception) { try { p.Dispose(); } catch (Exception) { } }
        }
        return list;
    }

    static bool NapCatAlive()
    {
        var l = NapCatProcesses();
        bool any = l.Count > 0;
        foreach (var p in l) { try { p.Dispose(); } catch (Exception) { } }
        return any;
    }

    // 只把 NapCat 目录下的进程藏起来，你自己的 QQ 窗口纹丝不动。
    // 返回这次藏了几个；顺便记下现在还有没有露在外面的窗口。
    static void HideNapCatWindows()
    {
        if (!hideWindow) return;
        var procs = NapCatProcesses();
        if (procs.Count == 0) return;
        var pids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in procs)
        {
            try { pids.Add((uint)p.Id); } catch (Exception) { }
            finally { try { p.Dispose(); } catch (Exception) { } }
        }
        int hiddenNow = 0;
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) return true;
                if (!IsWindowVisible(h)) return true;
                var cls = new StringBuilder(128);
                GetClassName(h, cls, 128);
                string c = cls.ToString();
                // 别去动系统输入法/提示这类窗口，只收控制台与宿主窗口
                if (c == "IME" || c == "MSCTFIME UI" || c == "TooltipWindow" || c == "SysShadow") return true;
                if (ShowWindow(h, SW_HIDE)) hiddenNow++;
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception) { }
        if (hiddenNow > 0) AppendLog("[napcat] 藏起了 " + hiddenNow + " 个窗口");
        // 看看还剩下几个可见的（下一轮继续收）
        int stillVisible = 0;
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pids.Contains(pid) && IsWindowVisible(h)) stillVisible++;
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception) { }
        napcatVisibleWindows = stillVisible;
    }


    // 把 NapCat 的窗口露出来：QQ 掉登录要扫码、确认 OneBot 服务端要看控制台，都靠它。
    // 露出后 10 分钟内巡检不再自动隐藏，否则自己 3 秒一次的把窗口又收走了。
    static void ShowNapCatWindows()
    {
        var procs = NapCatProcesses();
        if (procs.Count == 0)
        {
            AppendLog("[napcat] 没在跑，没法显示窗口");
            Notify("NapCat 没在跑", "先在托盘菜单点「只启动 NapCat」，起来再点这个");
            return;
        }
        var pids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in procs)
        {
            try { pids.Add((uint)p.Id); } catch (Exception) { }
            finally { try { p.Dispose(); } catch (Exception) { } }
        }
        int shown = 0;
        IntPtr first = IntPtr.Zero;
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) return true;
                var cls = new StringBuilder(128);
                GetClassName(h, cls, 128);
                string c = cls.ToString();
                if (c == "IME" || c == "MSCTFIME UI" || c == "TooltipWindow" || c == "SysShadow") return true;
                ShowWindow(h, SW_SHOW);
                ShowWindow(h, SW_RESTORE);
                if (first == IntPtr.Zero) first = h;
                shown++;
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception) { }
        if (first != IntPtr.Zero) { try { SetForegroundWindow(first); } catch (Exception) { } }
        showWindowsUntil = DateTime.Now.AddMinutes(10);
        napcatVisibleWindows = shown;
        AppendLog("[napcat] 显示窗口 " + shown + " 个（10 分钟内不自动隐藏）");
        Notify("NapCat 窗口已显示", shown > 0 ? ("露出 " + shown + " 个窗口，10 分钟内不会被自动隐藏") : "没找到可显示的窗口，NapCat 可能还没起来");
    }

    // 登录 NapCat 网页控制台要填的那串令牌，就在它自己的 webui.json 里 —— 直接进剪贴板，省得翻文件
    static void CopyNapCatToken()
    {
        string file = FindNapCatWebuiJson();
        if (file == null)
        {
            AppendLog("[napcat] 没找到 webui.json，没法复制登录令牌");
            Notify("没找到 NapCat 的 webui.json", "它的登录令牌就存在那个文件里；填一下 app.json 的 napcat.launchPath / configPath 指路");
            return;
        }
        string tok = JsonString(ReadAllTextSafe(file), "token", "");
        if (tok.Length == 0) { Notify("webui.json 里没有 token", file); return; }
        try
        {
            Clipboard.SetText(tok);
            AppendLog("[napcat] 已复制登录令牌（" + file + "）");
            Notify("NapCat 登录令牌已复制", "粘进 " + NapCatWebUrl() + " 的登录框就能进去");
        }
        catch (Exception ex) { Notify("复制失败", ex.Message); }
    }

    static string ReadAllTextSafe(string f)
    {
        try { return File.ReadAllText(f, Encoding.UTF8); } catch (Exception) { return ""; }
    }

    static void AddWebuiCand(List<string> cands, string dir)
    {
        try
        {
            string f = Path.Combine(dir, "webui.json");
            if (File.Exists(f))
            {
                string abs = Path.GetFullPath(f);
                if (!cands.Contains(abs)) cands.Add(abs);
            }
        }
        catch (Exception) { }
    }

    // NapCat 的数据目录是版本化的：<NapCat>\<宿主目录>\versions\<版本>\resources\app\napcat\config\webui.json
    static string FindNapCatWebuiJson()
    {
        var cands = new List<string>();
        var roots = new List<string>();
        if (napcatDir != null) roots.Add(napcatDir);
        if (napcatExe != null) { try { roots.Add(Path.GetDirectoryName(napcatExe)); } catch (Exception) { } }
        roots.Add(Path.Combine(root, "napcat"));
        foreach (string r in roots)
        {
            if (r == null || r.Length == 0) continue;
            AddWebuiCand(cands, r);
            AddWebuiCand(cands, Path.Combine(r, "config"));
            AddWebuiCand(cands, Path.Combine(r, "napcat", "config"));
            AddWebuiCand(cands, Path.Combine(r, "resources", "app", "napcat", "config"));
            try
            {
                foreach (string v in Directory.GetDirectories(Path.Combine(r, "versions")))
                    AddWebuiCand(cands, Path.Combine(v, "resources", "app", "napcat", "config"));
                foreach (string host in Directory.GetDirectories(r))
                {
                    AddWebuiCand(cands, Path.Combine(host, "config"));
                    try
                    {
                        foreach (string v in Directory.GetDirectories(Path.Combine(host, "versions")))
                            AddWebuiCand(cands, Path.Combine(v, "resources", "app", "napcat", "config"));
                    }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
        }
        if (cands.Count == 0) return null;
        cands.Sort(delegate (string a, string b)
        {
            try { return File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)); } catch (Exception) { return 0; }
        });
        return cands[0];
    }

    static string PortMark(int port) { return PortOpenOn(port) ? "●通" : "○不通"; }

    static void StartNapCat()
    {
        if (napcatExe == null || !File.Exists(napcatExe))
        {
            AppendLog("[napcat] 没找到 NapCatWinBootMain.exe（在「调整 → 权限与配置端」或 app.json 里填 napcat.launchPath）");
            return;
        }
        if (NapCatAlive()) { AppendLog("[napcat] 已经在跑了"); return; }
        AppendLog("[napcat] 启动 " + napcatExe + "（无窗口）");
        try
        {
            var psi = new ProcessStartInfo(napcatExe);
            if (!string.IsNullOrEmpty(napcatUin)) { psi.Arguments = napcatUin; AppendLog("[napcat] 使用快速登录（已指定 QQ 号）"); }
            psi.WorkingDirectory = napcatDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            var p = Process.Start(psi);
            if (p != null) { AppendLog("[napcat] 已拉起 PID " + PidOf(p)); p.Dispose(); }
        }
        catch (Exception ex) { AppendLog("[napcat] 启动失败：" + ex.Message); }
        HideNapCatWindows();
        hideWatchdogTicks = 12;    // 接下来 12 个 tick（约 36 秒）持续盯着，新冒出来的窗口也藏掉
    }

    static void StopNapCat()
    {
        var list = NapCatProcesses();
        if (list.Count == 0) { AppendLog("[napcat] 没在跑"); return; }
        foreach (var p in list)
        {
            try
            {
                int np = PidOf(p);
                AppendLog("[napcat] 关闭 " + NameOf(p) + " PID " + np);
                if (np <= 0) continue;
                var kill = new ProcessStartInfo("taskkill", "/PID " + np + " /T /F");
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                Process.Start(kill).WaitForExit(4000);
            }
            catch (Exception) { try { p.Kill(); } catch (Exception) { } }
            finally { try { p.Dispose(); } catch (Exception) { } }
        }
    }

    static bool NapCatWaitForPort(int ms)
    {
        var t0 = DateTime.Now;
        while ((DateTime.Now - t0).TotalMilliseconds < ms)
        {
            if (PortOpen()) return true;
            System.Threading.Thread.Sleep(400);
        }
        return PortOpen();
    }

    static bool PortOpen() { return PortOpenOn(onebotPort); }

    static bool PortOpenOn(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = ar.AsyncWaitHandle.WaitOne(600);
                if (ok && c.Connected) { c.EndConnect(ar); return true; }
            }
        }
        catch (Exception) { }
        return false;
    }

    // ---------- 小助手本体 ----------
    static void StartAll()
    {
        if (autoLaunch && !NapCatAlive())
        {
            StartNapCat();
            // 等不到 OneBot 端口就别闷着：NapCat 在跑却没端口，基本就是 QQ 掉登录 / 服务端没开
            if (!NapCatWaitForPort(20000) && NapCatAlive())
            {
                AppendLog("[napcat] OneBot 端口 " + onebotPort + " 一直没通（NapCat 在跑）—— 多半是 QQ 掉登录或服务端没开");
                Notify("NapCat 的 OneBot 端口没通", "NapCat 在跑，但 " + onebotPort + " 没开：点「显示 NapCat 窗口」扫码登录，或用「复制 NapCat 登录令牌」进 " + NapCatWebUrl() + " 看网络配置");
            }
        }
        else if (NapCatAlive()) { /* 已经在了，不重复启动 */ }
        StartStt();
        StartBot();
    }

    static void StopAll()
    {
        StopBot();
        StopStt();
        if (autoClose) StopNapCat();
    }

    // 本地 STT 侧车：起之前先探 /health，已经在跑就不重复起；退出时只关自己起的那个。
    // 清掉「不是本托盘起的」小助手实例（上次启动器留下的孤儿）：它会一直占着配置端端口，
    // 导致新实例起不来、用户又点「停止」无效。只认工作区里的 app/main.js，不碰别的 node 进程。
    static void KillStrayBot()
    {
        try
        {
            int mine = 0;
            try { mine = child == null ? 0 : PidOf(child); } catch (Exception) { mine = 0; }
            var q = new System.Management.ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'");
            foreach (var mo in q.Get())
            {
                string cmd = Convert.ToString(mo["CommandLine"]);
                if (cmd == null || cmd.IndexOf("main.js", StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (cmd.IndexOf(root, StringComparison.OrdinalIgnoreCase) < 0 && cmd.IndexOf("app\\main.js") < 0 && cmd.IndexOf("app/main.js") < 0) continue;
                int pid2 = Convert.ToInt32(mo["ProcessId"]);
                if (pid2 == mine) continue;
                AppendLog("[停止] 清掉残留实例 pid " + pid2);
                Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid2 + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
            }
        }
        catch (Exception ex) { AppendLog("[停止] 清理残留实例失败：" + ex.Message); }
    }
    static void StartStt()
    {
        if (!sttAutoStart) return;
        if (sttProc != null && !sttProc.HasExited) return;
        try
        {
            try { var wc = new System.Net.WebClient(); string h = wc.DownloadString("http://127.0.0.1:8910/health"); if (h.IndexOf("\"ok\": true") >= 0 || h.IndexOf("\"ok\":true") >= 0) { AppendLog("[stt] 已经在跑"); return; } } catch (Exception) { }
            string script = Path.Combine(root, "tools", "stt-server.py");
            if (!File.Exists(script)) { AppendLog("[stt] 没找到 tools/stt-server.py，跳过"); return; }
            var psi = new ProcessStartInfo("python");
            psi.Arguments = "\"" + script + "\"";
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
            sttProc = Process.Start(psi);
            AppendLog(sttProc != null ? ("[stt] 已随托盘启动 PID " + PidOf(sttProc)) : "[stt] 启动失败");
        }
        catch (Exception ex) { AppendLog("[stt] 启动失败：" + ex.Message); }
    }
    static void StopStt()
    {
        var p = sttProc; sttProc = null;
        if (p == null) return;
        try { if (!p.HasExited) { int pid = PidOf(p); Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true }); AppendLog("[stt] 已关闭"); } } catch (Exception) { }
    }
    static void StartBot()
    {
        manualStop = false;
        if (AliveProc(child)) return;
        if (childStartFailed) return;      // 上次就起不来，等用户自己再点「启动」（别每 3 秒弹一次）
        if (!File.Exists(entry)) { MessageBox.Show("找不到 " + entry, AppName); childStartFailed = true; return; }
        if (!NodeOk()) return;             // 没装 Node.js 就地讲清楚，别让它去抛 .NET 异常
        // 【重要】只要端口在听就不要再起第二个 —— 以前这里还要求"端口能应答"，
        // 但应用启动时端口**已经在听而 HTTP 还没起来**，托盘就误判成"没在跑"又起一个；
        // 第二个抢同一个端口失败，用户看到的就是「配置端端口 8799 被占用」。
        // 现在：端口在听＝已经有一个实例（可能正在启动）→ 接管它，不再重复启动，也不弹窗。
        int webPort = ReadPort();
        if (PortOpenOn(webPort))
        {
            if (!adoptedExisting)
            {
                adoptedExisting = true;
                AppendLog("[启动] 配置端 " + webPort + " 已在监听 → 接管现有实例（不重复启动；如果是它还在启动中，稍等它自己就绪）");
            }
            botWasAlive = true;
            childStartFailed = false;
            Refresh();
            return;
        }
        Directory.CreateDirectory(logDir);
        AppendLog("=== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 ===");
        var psi = new ProcessStartInfo(nodeExe, Quote(entry));
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        try
        {
            var p = new Process();
            p.StartInfo = psi;
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog("[err] " + e.Data); };
            p.EnableRaisingEvents = true;
            p.Exited += delegate { AppendLog("=== 进程结束 ==="); };
            p.Start();
            child = p;
            childStartFailed = false;
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            AppendLog("[启动失败] " + ex.Message);
            child = null;
            childStartFailed = true;
            MessageBox.Show("启动失败：" + ex.Message + "\r\n\r\n日志：" + logFile, AppName);
        }
        Refresh();
    }

    static void StopBot()
    {
        manualStop = true;          // 手动停的不许自愈
        botWasAlive = false;
        if (!AliveProc(child)) { KillStrayBot(); child = null; Refresh(); return; }
        try
        {
            int cp = PidOf(child);
            if (cp <= 0) { child = null; Refresh(); return; }
            // 先请它自己收尾（最多等 4 秒）再决定是否强杀：
            // 以前直接 taskkill /T /F，攒着写的状态（预算用量、消息表、学习权重）就丢了
            TryHttpShutdown();
            var t0 = DateTime.Now;
            while (AliveProc(child) && (DateTime.Now - t0).TotalSeconds < 4) System.Threading.Thread.Sleep(200);
            if (AliveProc(child))
            {
                var kill = new ProcessStartInfo("taskkill", "/PID " + cp + " /T /F");
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                Process.Start(kill).WaitForExit(4000);
            }
        }
        catch (Exception) { try { child.Kill(); } catch (Exception) { } }
        child = null;
        Refresh();
    }

    static void OpenWeb()
    {
        // 先确保服务在，并且**等它就绪**再开浏览器：
        // 以前拉起后立刻 Shell()，页面头几秒连不上，看起来像「服务重新连接」。
        if (!AliveProc(child)) { StartAll(); WaitForPort(ReadPort(), 20000); }
        Shell("http://127.0.0.1:" + ReadPort());
    }

    static bool WaitForPort(int port, int ms)
    {
        var t0 = DateTime.Now;
        while ((DateTime.Now - t0).TotalMilliseconds < ms)
        {
            if (PortOpenOn(port)) return true;
            System.Threading.Thread.Sleep(300);
        }
        return PortOpenOn(port);
    }

    // 请小助手自己收尾（预算/消息表/学习权重落盘），只走本机回环
    static void TryHttpShutdown()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + ReadPort() + "/api/action");
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            var body = Encoding.UTF8.GetBytes("{\"action\":\"shutdown\"}");
            req.ContentLength = body.Length;
            using (var st = req.GetRequestStream()) st.Write(body, 0, body.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { resp.Close(); }
            AppendLog("[stop] 已请求温和收尾");
        }
        catch (Exception) { AppendLog("[stop] 温和收尾没走通，直接结束进程"); }
    }

    static void Shell(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show(ex.Message, AppName); }
    }

    static bool IsAutoStart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", false))
            { return k != null && k.GetValue(RunKey) != null; }
        }
        catch (Exception) { return false; }
    }

    static void ToggleAutoStart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true))
            {
                if (k == null) return;
                if (k.GetValue(RunKey) == null) k.SetValue(RunKey, Quote(Application.ExecutablePath));
                else k.DeleteValue(RunKey, false);
            }
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, AppName); }
        miAuto.Checked = IsAutoStart();
    }

    // 托盘以前只会显示「未运行」，子进程挂了一直要等用户手点才恢复。
    // 这里做有限自愈：必须是「本来活着、现在不在了」且不是手动停的，才自动拉起来。
    static void TickRecovery()
    {
        bool alive = AliveProc(child);
        if (alive) { botWasAlive = true; recoveryWarned = false; return; }
        if (!botWasAlive || manualStop) return;
        if (!autoLaunch) return;
        // 关键：只在真正起来了才清除「本来活着」的标记 —— 否则一次失败（端口残留等）就再也不重试了
        if ((DateTime.Now - lastRecoverTry).TotalSeconds < 10) return;
        lastRecoverTry = DateTime.Now;
        if ((DateTime.Now - autoRestartWindow).TotalMinutes > 30) { autoRestartWindow = DateTime.Now; autoRestarts = 0; recoveryWarned = false; }
        if (autoRestarts >= 3) {
            if (!recoveryWarned) { recoveryWarned = true; AppendLog("[recover] 半小时内已尝试 3 次仍未起来，暂停自愈（端口/Node/日志自查）"); }
            return;
        }
        autoRestarts++;
        AppendLog("[recover] 检测到小助手不在运行，尝试自动重启第 " + autoRestarts + " 次");
        StartAll();
    }

    static void Refresh()
    {
        TickRecovery();
        bool mine = AliveProc(child);
        bool alive = mine || PortOpenOn(ReadPort());      // 端口在听 = 有人在跑（哪怕不是本启动器拉起的）
        bool nc = NapCatAlive();
        miStart.Enabled = !alive;
        miStop.Enabled = mine;
        miNapcatStart.Enabled = !nc;
        miNapcatStop.Enabled = nc;
        miStatus.Text = mine ? ("● 小助手运行中  PID " + PidOf(child))
                             : (alive ? "● 小助手运行中（已有一个实例）" : "○ 小助手未运行");
        miNapcat.Text = nc
            ? ("NapCat: 运行中" + (hideWindow ? (napcatVisibleWindows > 0 ? "（还有 " + napcatVisibleWindows + " 个窗口）" : "（已隐藏）") : "（不隐藏）"))
            : (napcatExe == null ? "NapCat: 没找到启动程序" : "NapCat: 未运行");
        miPorts.Text = "端口: OneBot " + onebotPort + " " + PortMark(onebotPort) + "　控制台 " + webuiPort + " " + PortMark(webuiPort);
        if (miNapcatShow != null)
        {
            if (DateTime.Now < showWindowsUntil)
            {
                int left = (int)Math.Ceiling((showWindowsUntil - DateTime.Now).TotalMinutes);
                miNapcatShow.Text = "NapCat 窗口已显示（约 " + left + " 分钟后恢复自动隐藏）";
            }
            else miNapcatShow.Text = "显示 NapCat 窗口（登录 / 扫码，10 分钟不自动隐藏）";
        }
        tray.Text = AppName + (alive ? " · 运行中" : " · 已停止");
        // 每 3 秒收一次：不管 NapCat 是本次启动的还是之前就开着的，只要露头就藏。
        // （旧版只在"自己启动 NapCat"后跑 12 个 tick，所以早就开着的那些永远藏不住。）
        // 手动点了「显示 NapCat 窗口」之后的 10 分钟里不藏 —— 否则扫码/看令牌时窗口会自己消失。
        if (nc && hideWindow && DateTime.Now >= showWindowsUntil) HideNapCatWindows();
        if (hideWatchdogTicks > 0) hideWatchdogTicks--;
    }

    static Icon LoadIcon()
    {
        try
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSHQQTray.ico");
            if (File.Exists(p)) return new Icon(p);
        }
        catch (Exception) { }
        try
        {
            Icon ex = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (ex != null) return ex;
        }
        catch (Exception) { }
        return SystemIcons.Application;
    }

    // 非阻塞提示：托盘气泡而不是模态对话框（模态框会把重复启动的进程永远挂住）
    static void Notify(string title, string text)
    {
        try
        {
            if (tray == null) return;
            tray.BalloonTipTitle = title;
            tray.BalloonTipText = text;
            tray.ShowBalloonTip(4000);
        }
        catch (Exception) { }
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    // 没装 Node.js 是新机器最常见的坑（以前会直接抛 .NET 异常弹一个看不懂的窗）
    static bool NodeOk()
    {
        if (CanRunNode()) return true;
        AppendLog("[启动失败] 找不到可用的 Node.js（本程序需要 Node 22+）：" + nodeExe);
        childStartFailed = true;
        var r = MessageBox.Show(
            "没找到 Node.js —— 本程序需要 Node.js 22 或更高版本。\r\n\r\n" +
            "装完（安装时一路默认即可）再点托盘菜单的「启动」。\r\n" +
            "下载页：https://nodejs.org/zh-cn/download\r\n\r\n" +
            "要我现在打开下载页吗？", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (r == DialogResult.Yes) { try { Process.Start("https://nodejs.org/zh-cn/download"); } catch (Exception) { } }
        return false;
    }

    static bool CanRunNode()
    {
        if (nodeChecked && lastNodeOk) return true;
        nodeChecked = true; lastNodeOk = false;
        if (string.IsNullOrEmpty(nodeExe)) return false;
        try
        {
            var psi = new ProcessStartInfo(nodeExe, "--version");
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            var p = Process.Start(psi);
            if (p == null) return false;
            string v = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(5000);
            bool ok = v.StartsWith("v") && v.Length >= 2;
            if (ok)
            {
                AppendLog("[node] " + nodeExe + " → " + v);
                lastNodeOk = true;
            }
            try { p.Dispose(); } catch (Exception) { }
            return ok;
        }
        catch (Exception) { return false; }
    }

    static void ReportCrash(Exception ex)
    {
        string msg = ex == null ? "未知错误" : (ex.GetType().Name + "：" + ex.Message);
        try { AppendLog("[崩溃] " + msg + "\r\n" + (ex == null ? "" : ex.StackTrace)); } catch (Exception) { }
        try { MessageBox.Show("程序内部出错了（已记进日志）：\r\n" + msg + "\r\n\r\n日志：" + logFile, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error); } catch (Exception) { }
    }

    static void ShowDiag()
    {
        var sb = new StringBuilder();
        sb.AppendLine("安装目录：" + root);
        sb.AppendLine("入口文件：" + entry + (File.Exists(entry) ? "（存在）" : "（缺失）"));
        sb.AppendLine("Node：" + nodeExe + " → " + (CanRunNode() ? "可用" : "不可用"));
        sb.AppendLine("NapCat 启动器：" + (napcatExe == null ? "没配置/没找到" : napcatExe));
        sb.AppendLine("端口：OneBot " + onebotPort + " " + PortMark(onebotPort) + "　配置端 " + webuiPort + " " + PortMark(webuiPort));
        sb.AppendLine("小助手子进程：" + (child == null ? "未启动（本启动器）" : ("PID " + PidOf(child))));
        sb.AppendLine("日志：" + logFile);
        sb.AppendLine();
        sb.AppendLine("（把这段整段发给作者即可定位问题）");
        try { AppendLog("[诊断] " + sb.ToString().Replace("\r\n", " / ")); } catch (Exception) { }
        MessageBox.Show(sb.ToString(), AppName + " 诊断信息", MessageBoxButtons.OK, MessageBoxIcon.Information);
        try { Process.Start("explorer", "/select,\"" + logFile + "\""); } catch (Exception) { }
    }

    static void AppendLog(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try { Directory.CreateDirectory(logDir); File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8); }
            catch (Exception) { }
        }
    }

    // 只探测、不动手：给排查用（winexe 没控制台，所以写文件）
    static void WriteProbe()
    {
        var sb = new StringBuilder();
        sb.AppendLine("root       = " + root);
        sb.AppendLine("entry      = " + entry + "   存在=" + File.Exists(entry));
        sb.AppendLine("node       = " + nodeExe);
        sb.AppendLine("config     = " + configFile);
        sb.AppendLine("webui port = " + ReadPort());
        sb.AppendLine("napcat exe = " + (napcatExe ?? "（没找到）"));
        sb.AppendLine("napcat dir = " + (napcatDir ?? "（无）"));
        sb.AppendLine("onebot port= " + onebotPort);
        sb.AppendLine("autoLaunch = " + autoLaunch + "   autoClose = " + autoClose + "   hideWindow = " + hideWindow);
        sb.AppendLine("napcat 在跑 = " + NapCatAlive());
        sb.AppendLine("onebot 端口通 = " + PortOpen());
        sb.AppendLine("网页控制台端口 " + webuiPort + " 通 = " + PortOpenOn(webuiPort));
        sb.AppendLine("napcat webui.json = " + (FindNapCatWebuiJson() ?? "（没找到）"));
        sb.AppendLine("将会关闭的进程（只在这个目录下的）：");
        foreach (var p in NapCatProcesses())
        {
            try { sb.AppendLine("   - " + p.ProcessName + " PID " + p.Id + "  " + (p.MainModule == null ? "?" : p.MainModule.FileName)); }
            catch (Exception) { }
            finally { try { p.Dispose(); } catch (Exception) { } }
        }
        Directory.CreateDirectory(dataDir);
        string outFile = Path.Combine(dataDir, "_napcat-probe.txt");
        File.WriteAllText(outFile, sb.ToString(), Encoding.UTF8);
    }
}
