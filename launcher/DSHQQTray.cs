using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
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
    static string root, entry, nodeExe, dataDir, logDir, logFile, configFile, napcatDir, napcatExe;
    static ToolStripMenuItem miStart, miStop, miWeb, miAuto, miStatus, miNapcat, miNapcatStart, miNapcatStop;
    static Timer timer;
    static readonly object logLock = new object();
    static Icon appIcon;
    static System.Threading.Mutex singleInstance;   // 必须静态持有！局部变量会被 GC 收掉，句柄一关命名互斥体就消失，单实例就失效了
    static bool autoLaunch = true, autoClose = true, hideWindow = true;
    static int onebotPort = 3001;
    static int hideWatchdogTicks = 0;

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    const int SW_HIDE = 0;

    [STAThread]
    static void Main(string[] args)
    {
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
        menu.Items.Add(new ToolStripSeparator());
        miStart = new ToolStripMenuItem("启动", null, delegate { StartAll(); });
        miStop = new ToolStripMenuItem("停止", null, delegate { StopAll(); });
        menu.Items.Add(miStart);
        menu.Items.Add(miStop);
        menu.Items.Add(new ToolStripMenuItem("重启", null, delegate { StopAll(); StartAll(); }));
        menu.Items.Add(new ToolStripSeparator());
        miNapcatStart = new ToolStripMenuItem("只启动 NapCat", null, delegate { StartNapCat(); NapCatWaitForPort(20000); Refresh(); });
        miNapcatStop = new ToolStripMenuItem("只关闭 NapCat", null, delegate { StopNapCat(); Refresh(); });
        menu.Items.Add(miNapcatStart);
        menu.Items.Add(miNapcatStop);
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
        string configured = JsonString(json, "launchPath", "");
        string wsUrl = JsonString(json, "wsUrl", "");
        var pm = Regex.Match(wsUrl ?? "", ":(\\d+)");
        if (pm.Success) { int p; if (int.TryParse(pm.Groups[1].Value, out p)) onebotPort = p; }

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

    // 只把 NapCat 目录下的进程藏起来，你自己的 QQ 窗口纹丝不动
    static void HideNapCatWindows()
    {
        if (!hideWindow) return;
        foreach (var p in NapCatProcesses())
        {
            try
            {
                p.Refresh();
                if (p.MainWindowHandle != IntPtr.Zero) ShowWindow(p.MainWindowHandle, SW_HIDE);
            }
            catch (Exception) { }
            finally { try { p.Dispose(); } catch (Exception) { } }
        }
    }

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
            psi.WorkingDirectory = napcatDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            var p = Process.Start(psi);
            if (p != null) { AppendLog("[napcat] 已拉起 PID " + p.Id); p.Dispose(); }
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
                AppendLog("[napcat] 关闭 " + p.ProcessName + " PID " + p.Id);
                var kill = new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F");
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
        if (autoLaunch && !NapCatAlive()) { StartNapCat(); NapCatWaitForPort(20000); }
        else if (NapCatAlive()) { /* 已经在了，不重复启动 */ }
        StartBot();
    }

    static void StopAll()
    {
        StopBot();
        if (autoClose) StopNapCat();
    }

    static void StartBot()
    {
        if (child != null && !child.HasExited) return;
        if (!File.Exists(entry)) { MessageBox.Show("找不到 " + entry, AppName); return; }
        // 配置端端口已经在听 = 已经有一个小助手在跑（可能是上一次启动器留下的），不要再起第二个
        int webPort = ReadPort();
        if (PortOpenOn(webPort))
        {
            AppendLog("[启动] 配置端端口 " + webPort + " 已在监听 → 认为小助手已经在跑，不重复启动");
            Notify("小助手已经在跑了", "配置端端口 " + webPort + " 已被占用。要重启的话先在托盘菜单点「停止」。");
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
        child = new Process();
        child.StartInfo = psi;
        child.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
        child.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog("[err] " + e.Data); };
        child.EnableRaisingEvents = true;
        child.Exited += delegate { AppendLog("=== 进程结束 ==="); };
        try
        {
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            AppendLog("[启动失败] " + ex.Message);
            MessageBox.Show("启动失败：" + ex.Message, AppName);
            child = null;
        }
        Refresh();
    }

    static void StopBot()
    {
        if (child == null || child.HasExited) { Refresh(); return; }
        try
        {
            var kill = new ProcessStartInfo("taskkill", "/PID " + child.Id + " /T /F");
            kill.UseShellExecute = false;
            kill.CreateNoWindow = true;
            Process.Start(kill).WaitForExit(4000);
        }
        catch (Exception) { try { child.Kill(); } catch (Exception) { } }
        child = null;
        Refresh();
    }

    static void OpenWeb()
    {
        if (child == null || child.HasExited) StartAll();
        Shell("http://127.0.0.1:" + ReadPort());
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

    static void Refresh()
    {
        bool mine = child != null && !child.HasExited;
        bool alive = mine || PortOpenOn(ReadPort());      // 端口在听 = 有人在跑（哪怕不是本启动器拉起的）
        bool nc = NapCatAlive();
        miStart.Enabled = !alive;
        miStop.Enabled = mine;
        miNapcatStart.Enabled = !nc;
        miNapcatStop.Enabled = nc;
        miStatus.Text = mine ? ("● 小助手运行中  PID " + child.Id)
                             : (alive ? "● 小助手运行中（已有一个实例）" : "○ 小助手未运行");
        miNapcat.Text = nc ? ("NapCat: 运行中" + (hideWindow ? "（已隐藏）" : "")) : (napcatExe == null ? "NapCat: 没找到启动程序" : "NapCat: 未运行");
        tray.Text = AppName + (alive ? " · 运行中" : " · 已停止");
        if (nc && hideWindow && hideWatchdogTicks > 0) { HideNapCatWindows(); }
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
