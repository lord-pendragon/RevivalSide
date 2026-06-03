using System.Collections.Specialized;
using System.Diagnostics;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevivalSideOfficialProfileCapture;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new CaptureForm());
    }
}

internal sealed class CaptureForm : Form
{
    private static readonly HashSet<string> GamePorts = new(StringComparer.OrdinalIgnoreCase)
    {
        "20001",
        "20002",
        "20003",
        "20004",
        "22000",
    };

    private readonly Button startButton = new() { Text = "Start recording", Width = 142, Height = 36 };
    private readonly Button endButton = new() { Text = "Stop recording", Width = 142, Height = 36, Enabled = false };
    private readonly Button extractButton = new() { Text = "Extract and copy", Width = 158, Height = 36 };
    private readonly Button browseManagedButton = new() { Text = "Browse", Width = 92, Height = 32 };
    private readonly Button detectManagedButton = new() { Text = "Detect", Width = 92, Height = 32 };
    private readonly TextBox managedDirBox = new()
    {
        ReadOnly = true,
        Dock = DockStyle.Fill,
        BorderStyle = BorderStyle.FixedSingle,
        BackColor = Color.White,
    };
    private readonly TextBox logBox = new()
    {
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        Dock = DockStyle.Fill,
        BorderStyle = BorderStyle.FixedSingle,
        BackColor = Color.White,
        Font = new Font("Consolas", 9F),
    };
    private readonly Label statusLabel = new()
    {
        AutoSize = false,
        Text = "Idle",
        Height = 28,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
    };
    private readonly Label captureLabel = new()
    {
        AutoSize = false,
        Text = "No capture yet",
        Height = 24,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
    };
    private readonly Label exportLabel = new()
    {
        AutoSize = false,
        Text = "No export yet",
        Height = 24,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
    };
    private readonly string repoRoot;
    private readonly string captureDir;
    private readonly string extractRoot;
    private readonly string exportsDir;
    private readonly string settingsPath;
    private readonly string nodePath;
    private readonly string dumpcapPath;
    private readonly string tsharkPath;
    private readonly List<CaptureProcess> captures = new();
    private string managedDir = "";
    private string? currentStamp;

    public CaptureForm()
    {
        repoRoot = ResolveRepoRoot();
        captureDir = Path.Combine(repoRoot, "captures");
        extractRoot = Path.Combine(repoRoot, "server-data", "capture-extracts");
        exportsDir = Path.Combine(repoRoot, "exports");
        settingsPath = Path.Combine(repoRoot, "capture-settings.json");
        nodePath = ResolveToolPath("node.exe", Path.Combine("runtime", "node", "node.exe"));
        dumpcapPath = ResolveToolPath("dumpcap.exe", Path.Combine("runtime", "Wireshark", "dumpcap.exe"));
        tsharkPath = ResolveToolPath("tshark.exe", Path.Combine("runtime", "Wireshark", "tshark.exe"));
        managedDir = ResolveInitialManagedDir();

        Text = "RevivalSide Official Profile Capture";
        Width = 900;
        Height = 580;
        MinimumSize = new Size(760, 460);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.FromArgb(246, 248, 250);

        StyleButton(startButton, primary: true);
        StyleButton(endButton);
        StyleButton(extractButton, primary: true);
        StyleButton(browseManagedButton);
        StyleButton(detectManagedButton);
        managedDirBox.Text = string.IsNullOrWhiteSpace(managedDir) ? "CounterSide Assembly-CSharp.dll not selected" : managedDir;

        var title = new Label
        {
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 16F, FontStyle.Bold),
            Text = "Official Profile Capture",
        };
        var subtitle = new Label
        {
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            Text = "Capture JOIN_LOBBY_ACK, export users.json, then import it in User Manager.",
        };
        var buttonPanel = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Dock = DockStyle.Fill,
            Padding = new Padding(0),
            Margin = new Padding(0),
        };
        buttonPanel.Controls.Add(startButton);
        buttonPanel.Controls.Add(endButton);
        buttonPanel.Controls.Add(extractButton);

        var headerPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 12),
        };
        headerPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        headerPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var titlePanel = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Margin = new Padding(0),
        };
        titlePanel.Controls.Add(title, 0, 0);
        titlePanel.Controls.Add(subtitle, 0, 1);
        headerPanel.Controls.Add(titlePanel, 0, 0);
        headerPanel.Controls.Add(buttonPanel, 1, 0);

        var sessionGroup = new GroupBox
        {
            Text = "Session",
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(12),
            Margin = new Padding(0, 0, 0, 12),
        };
        var sessionGrid = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 3,
            Margin = new Padding(0),
        };
        sessionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92));
        sessionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        sessionGrid.Controls.Add(MakeFieldLabel("Status"), 0, 0);
        sessionGrid.Controls.Add(statusLabel, 1, 0);
        sessionGrid.Controls.Add(MakeFieldLabel("Capture"), 0, 1);
        sessionGrid.Controls.Add(captureLabel, 1, 1);
        sessionGrid.Controls.Add(MakeFieldLabel("Export"), 0, 2);
        sessionGrid.Controls.Add(exportLabel, 1, 2);
        sessionGroup.Controls.Add(sessionGrid);

        var setupGroup = new GroupBox
        {
            Text = "Setup",
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(12),
            Margin = new Padding(0, 0, 0, 12),
        };
        var setupGrid = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0),
        };
        setupGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92));
        setupGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        setupGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var setupButtons = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Dock = DockStyle.Fill,
            Margin = new Padding(8, 0, 0, 0),
        };
        setupButtons.Controls.Add(browseManagedButton);
        setupButtons.Controls.Add(detectManagedButton);
        setupGrid.Controls.Add(MakeFieldLabel("Game DLL"), 0, 0);
        setupGrid.Controls.Add(managedDirBox, 1, 0);
        setupGrid.Controls.Add(setupButtons, 2, 0);
        setupGroup.Controls.Add(setupGrid);

        var logGroup = new GroupBox
        {
            Text = "Activity",
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            Margin = new Padding(0),
        };
        logGroup.Controls.Add(logBox);

        var rootPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(16),
            BackColor = BackColor,
        };
        rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        rootPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        rootPanel.Controls.Add(headerPanel, 0, 0);
        rootPanel.Controls.Add(sessionGroup, 0, 1);
        rootPanel.Controls.Add(setupGroup, 0, 2);
        rootPanel.Controls.Add(logGroup, 0, 3);

        Controls.Add(rootPanel);

        startButton.Click += async (_, _) => await RunUiAction(StartCaptureAsync);
        endButton.Click += async (_, _) => await RunUiAction(EndCaptureAsync);
        extractButton.Click += async (_, _) => await RunUiAction(ExtractUsersJsonAsync);
        browseManagedButton.Click += (_, _) => BrowseManagedAssembly();
        detectManagedButton.Click += (_, _) => DetectManagedAssembly(showMessage: true);
        FormClosing += (_, _) => StopAllCaptures();

        AppendLog($"Repo: {repoRoot}");
        AppendLog($"App arch: {RuntimeInformation.ProcessArchitecture} on {RuntimeInformation.OSArchitecture}");
        AppendLog($"Captures: {captureDir}");
        AppendLog($"Exports: {exportsDir}");
        AppendLog($"node: {DescribeExecutable(nodePath)}");
        AppendLog($"dumpcap: {DescribeExecutable(dumpcapPath)}");
        AppendLog($"tshark: {DescribeExecutable(tsharkPath)}");
        AppendLog(string.IsNullOrWhiteSpace(managedDir) ? "CounterSide DLL: not selected" : $"CounterSide DLL: {Path.Combine(managedDir, "Assembly-CSharp.dll")}");
    }

    private static Label MakeFieldLabel(string text)
    {
        return new Label
        {
            AutoSize = false,
            Text = text,
            Dock = DockStyle.Fill,
            Height = 24,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = SystemColors.GrayText,
        };
    }

    private static void StyleButton(Button button, bool primary = false)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.UseVisualStyleBackColor = false;
        button.BackColor = primary ? Color.FromArgb(12, 102, 228) : Color.White;
        button.ForeColor = primary ? Color.White : Color.FromArgb(32, 36, 40);
        button.FlatAppearance.BorderColor = primary ? Color.FromArgb(12, 102, 228) : Color.FromArgb(203, 213, 225);
        button.FlatAppearance.BorderSize = 1;
        button.Margin = new Padding(0, 0, 8, 0);
    }

    private string ResolveInitialManagedDir()
    {
        var settings = LoadSettings();
        foreach (var candidate in new[]
        {
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_DIR"),
            settings.CounterSideManagedDir,
            FindCounterSideManagedDir(),
        })
        {
            var normalized = NormalizeManagedDir(candidate);
            if (IsManagedDir(normalized)) return normalized;
        }
        return "";
    }

    private CaptureSettings LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath)) return new CaptureSettings();
            return JsonSerializer.Deserialize<CaptureSettings>(File.ReadAllText(settingsPath)) ?? new CaptureSettings();
        }
        catch
        {
            return new CaptureSettings();
        }
    }

    private void SaveSettings()
    {
        try
        {
            var settings = new CaptureSettings { CounterSideManagedDir = managedDir };
            File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8);
        }
        catch (Exception ex)
        {
            AppendLog($"Could not save settings: {ex.Message}");
        }
    }

    private void BrowseManagedAssembly()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Select CounterSide Assembly-CSharp.dll",
            Filter = "Assembly-CSharp.dll|Assembly-CSharp.dll|DLL files (*.dll)|*.dll|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };
        var initial = IsManagedDir(managedDir) ? managedDir : FindCounterSideManagedDir();
        if (!string.IsNullOrWhiteSpace(initial) && Directory.Exists(initial)) dialog.InitialDirectory = initial;

        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var normalized = NormalizeManagedDir(dialog.FileName);
        if (!IsManagedDir(normalized))
        {
            MessageBox.Show(this, "That file is not CounterSide Data\\Managed\\Assembly-CSharp.dll.", "RevivalSide capture", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        SetManagedDir(normalized, "Selected CounterSide DLL");
    }

    private bool DetectManagedAssembly(bool showMessage)
    {
        var detected = FindCounterSideManagedDir();
        if (IsManagedDir(detected))
        {
            SetManagedDir(detected, "Detected CounterSide DLL");
            return true;
        }
        if (showMessage)
        {
            MessageBox.Show(this, "CounterSide Data\\Managed\\Assembly-CSharp.dll was not found automatically. Click Browse and select Assembly-CSharp.dll from the installed game folder.", "RevivalSide capture", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        return false;
    }

    private void SetManagedDir(string value, string logText)
    {
        managedDir = NormalizeManagedDir(value);
        managedDirBox.Text = IsManagedDir(managedDir) ? managedDir : "CounterSide Assembly-CSharp.dll not selected";
        SaveSettings();
        AppendLog($"{logText}: {managedDir}");
    }

    private bool EnsureManagedAssemblyReady()
    {
        managedDir = NormalizeManagedDir(managedDir);
        if (IsManagedDir(managedDir))
        {
            managedDirBox.Text = managedDir;
            return true;
        }
        if (DetectManagedAssembly(showMessage: false)) return true;
        BrowseManagedAssembly();
        return IsManagedDir(managedDir);
    }

    private static bool IsManagedDir(string? directory)
    {
        return !string.IsNullOrWhiteSpace(directory) &&
            File.Exists(Path.Combine(directory, "Assembly-CSharp.dll"));
    }

    private static string NormalizeManagedDir(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        try
        {
            var text = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
            text = text.Replace('/', Path.DirectorySeparatorChar);
            var full = Path.GetFullPath(text);
            if (File.Exists(full))
            {
                if (Path.GetFileName(full).Equals("Assembly-CSharp.dll", StringComparison.OrdinalIgnoreCase))
                {
                    return Path.GetDirectoryName(full) ?? "";
                }
                full = Path.GetDirectoryName(full) ?? full;
            }

            foreach (var candidate in BuildManagedDirCandidates(full))
            {
                if (IsManagedDir(candidate)) return candidate;
            }
            return full;
        }
        catch
        {
            return "";
        }
    }

    private static IEnumerable<string> BuildManagedDirCandidates(string root)
    {
        if (string.IsNullOrWhiteSpace(root)) yield break;
        yield return root;
        yield return Path.Combine(root, "Data", "Managed");
        yield return Path.Combine(root, "Managed");
        if (Path.GetFileName(root).Equals("Data", StringComparison.OrdinalIgnoreCase))
        {
            yield return Path.Combine(root, "Managed");
        }
        var parent = Directory.GetParent(root);
        if (Path.GetFileName(root).Equals("Managed", StringComparison.OrdinalIgnoreCase) && parent != null)
        {
            yield return root;
            yield return Path.Combine(parent.FullName, "Managed");
        }
    }

    private static string FindCounterSideManagedDir()
    {
        foreach (var candidate in FindCounterSideManagedDirCandidates())
        {
            var normalized = NormalizeManagedDir(candidate);
            if (IsManagedDir(normalized)) return normalized;
        }
        return "";
    }

    private static IEnumerable<string> FindCounterSideManagedDirCandidates()
    {
        foreach (var candidate in new[]
        {
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_DIR"),
            Path.Combine("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam", "steamapps", "common", "CounterSide"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam", "steamapps", "common", "CounterSide"),
        })
        {
            if (!string.IsNullOrWhiteSpace(candidate)) yield return candidate;
        }

        foreach (var library in FindSteamLibraryRoots())
        {
            var commonDir = Path.Combine(library, "steamapps", "common");
            foreach (var knownName in new[] { "CounterSide", "CounterSide Global", "COUNTER SIDE" })
            {
                yield return Path.Combine(commonDir, knownName);
            }
            if (!Directory.Exists(commonDir)) continue;
            IEnumerable<string> gameDirs;
            try
            {
                gameDirs = Directory.EnumerateDirectories(commonDir)
                    .Where(dir =>
                    {
                        var name = Path.GetFileName(dir).Replace(" ", "", StringComparison.OrdinalIgnoreCase);
                        return name.Contains("CounterSide", StringComparison.OrdinalIgnoreCase);
                    })
                    .ToList();
            }
            catch
            {
                gameDirs = Array.Empty<string>();
            }
            foreach (var gameDir in gameDirs) yield return gameDir;
        }
    }

    private static IEnumerable<string> FindSteamLibraryRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var steamRoot in FindSteamInstallRoots())
        {
            if (string.IsNullOrWhiteSpace(steamRoot)) continue;
            AddDirectory(roots, steamRoot);
            var libraryFile = Path.Combine(steamRoot, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(libraryFile)) continue;
            string text;
            try
            {
                text = File.ReadAllText(libraryFile);
            }
            catch
            {
                continue;
            }
            foreach (Match match in Regex.Matches(text, "\"path\"\\s+\"([^\"]+)\"", RegexOptions.IgnoreCase))
            {
                AddDirectory(roots, UnescapeSteamPath(match.Groups[1].Value));
            }
        }
        return roots;
    }

    private static IEnumerable<string> FindSteamInstallRoots()
    {
        foreach (var candidate in new[]
        {
            ReadRegistryString(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath"),
            ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
            ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam", "InstallPath"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam"),
            @"C:\Steam",
            @"D:\Steam",
            @"E:\Steam",
        })
        {
            if (!string.IsNullOrWhiteSpace(candidate)) yield return UnescapeSteamPath(candidate);
        }
    }

    private static string ReadRegistryString(string keyName, string valueName)
    {
        try
        {
            return Registry.GetValue(keyName, valueName, null) as string ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static void AddDirectory(HashSet<string> roots, string path)
    {
        try
        {
            var full = Path.GetFullPath(UnescapeSteamPath(path));
            if (Directory.Exists(full)) roots.Add(full);
        }
        catch
        {
            // Ignore malformed Steam library paths.
        }
    }

    private static string UnescapeSteamPath(string path)
    {
        return Environment.ExpandEnvironmentVariables(path.Trim().Trim('"')).Replace("\\\\", "\\").Replace('/', Path.DirectorySeparatorChar);
    }

    private async Task RunUiAction(Func<Task> action)
    {
        startButton.Enabled = false;
        endButton.Enabled = captures.Count > 0;
        extractButton.Enabled = false;
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            SetStatus("Failed");
            AppendLog($"ERROR: {ex.Message}");
            MessageBox.Show(this, ex.Message, "RevivalSide capture", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            startButton.Enabled = captures.Count == 0;
            endButton.Enabled = captures.Count > 0;
            extractButton.Enabled = captures.Count == 0;
        }
    }

    private Task StartCaptureAsync()
    {
        if (captures.Count > 0) throw new InvalidOperationException("Capture is already running.");
        if (!File.Exists(dumpcapPath)) throw new FileNotFoundException("dumpcap.exe was not found.", dumpcapPath);
        EnsureCompatibleExecutable("dumpcap.exe", dumpcapPath);
        Directory.CreateDirectory(captureDir);
        currentStamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var interfaces = ResolveInterfaces();
        if (interfaces.Count == 0) throw new InvalidOperationException("No dumpcap interfaces were found.");

        foreach (var iface in interfaces)
        {
            var safeName = SafeName(iface.Name);
            var pcapFile = Path.Combine(captureDir, $"counterside-all-{iface.Id}-{safeName}-{currentStamp}.pcapng");
            var logFile = Path.Combine(captureDir, $"dumpcap-{iface.Id}-{safeName}-{currentStamp}.log");
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = dumpcapPath,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardError = true,
                },
                EnableRaisingEvents = true,
            };
            process.StartInfo.ArgumentList.Add("-i");
            process.StartInfo.ArgumentList.Add(iface.Id);
            process.StartInfo.ArgumentList.Add("-s");
            process.StartInfo.ArgumentList.Add("0");
            process.StartInfo.ArgumentList.Add("-w");
            process.StartInfo.ArgumentList.Add(pcapFile);
            var writer = new StreamWriter(File.Open(logFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8)
            {
                AutoFlush = true,
            };
            process.ErrorDataReceived += (_, eventArgs) =>
            {
                if (eventArgs.Data != null) writer.WriteLine(eventArgs.Data);
            };
            if (!process.Start())
            {
                writer.Dispose();
                throw new InvalidOperationException($"Failed to start dumpcap for interface {iface.Id}.");
            }
            process.BeginErrorReadLine();
            captures.Add(new CaptureProcess(process, writer, pcapFile, logFile, iface));
        }

        SetStatus($"Recording all ports on {captures.Count} interface(s)");
        captureLabel.Text = $"{currentStamp} | {captures.Count} interface(s)";
        AppendLog($"Started capture stamp {currentStamp}");
        foreach (var capture in captures)
        {
            AppendLog($"  PID {capture.Process.Id}: {capture.Interface.Id} {capture.Interface.Name}");
        }
        return Task.CompletedTask;
    }

    private Task EndCaptureAsync()
    {
        if (captures.Count == 0)
        {
            SetStatus("No active recording");
            return Task.CompletedTask;
        }
        StopAllCaptures();
        SetStatus("Recording stopped");
        captureLabel.Text = $"Stopped | {GetCurrentCaptureFiles().Count} capture file(s)";
        AppendLog("Stopped capture.");
        foreach (var file in GetCurrentCaptureFiles())
        {
            AppendLog($"  {Path.GetFileName(file)} ({new FileInfo(file).Length:N0} bytes)");
        }
        return Task.CompletedTask;
    }

    private async Task ExtractUsersJsonAsync()
    {
        if (captures.Count > 0) throw new InvalidOperationException("End the recording before extracting.");
        if (!File.Exists(tsharkPath)) throw new FileNotFoundException("tshark.exe was not found.", tsharkPath);
        EnsureCompatibleExecutable("tshark.exe", tsharkPath);
        EnsureCompatibleExecutable("node.exe", nodePath);
        if (!EnsureManagedAssemblyReady())
        {
            throw new InvalidOperationException("CounterSide Data\\Managed\\Assembly-CSharp.dll is required to decode JOIN_LOBBY_ACK. Click Browse and select it from the installed game folder.");
        }

        var pcapFiles = GetCurrentCaptureFiles()
            .Where(File.Exists)
            .Select(path => new FileInfo(path))
            .Where(file => file.Length > 0)
            .OrderByDescending(file => file.Length)
            .ToList();
        if (pcapFiles.Count == 0) throw new InvalidOperationException("No capture files were found for extraction.");

        AppendLog("Scanning captures for JOIN_LOBBY_ACK...");
        Directory.CreateDirectory(extractRoot);
        foreach (var pcap in pcapFiles)
        {
            AppendLog($"Scanning {pcap.Name}...");
            var streams = await EnumerateCandidateStreamsAsync(pcap.FullName);
            AppendLog($"  {streams.Count} candidate TCP stream(s)");
            for (var index = 0; index < streams.Count; index++)
            {
                var stream = streams[index];
                var logStream = index < 25 || stream.HasGamePort;
                if (logStream) AppendLog($"  stream {stream.Stream}: {stream.TotalBytes:N0} bytes");
                var outputDir = Path.Combine(extractRoot, $"{Path.GetFileNameWithoutExtension(pcap.Name)}-stream-{stream.Stream}");
                var extracted = await TryExtractStreamAsync(pcap.FullName, outputDir, stream.Stream, logStream);
                if (!extracted) continue;
                if (!ManifestHasJoinLobbyAck(Path.Combine(outputDir, "manifest.json"))) continue;

                AppendLog($"Found JOIN_LOBBY_ACK in stream {stream.Stream}.");
                var copyPath = Path.Combine(exportsDir, $"users-{DateTime.Now:yyyyMMdd-HHmmss}.json");
                var importResult = await ImportProfileAsync(outputDir, copyPath);
                CopyUsersJsonToClipboard(copyPath);
                SetStatus($"Imported {importResult.UserUid}; copied users.json");
                exportLabel.Text = copyPath;
                AppendLog($"Imported local profile {importResult.UserUid} ({importResult.Nickname})");
                AppendLog($"Official UID: {importResult.OfficialUserUid}");
                AppendLog($"Copied users.json file and text: {copyPath}");
                return;
            }
            if (streams.Count > 25) AppendLog($"  scanned {streams.Count - 25} additional lower-priority stream(s)");
        }

        throw new InvalidOperationException("No JOIN_LOBBY_ACK packet was found in the latest capture files. Start recording before opening or logging into the official client, stop after the lobby is fully loaded, then extract again.");
    }

    private void StopAllCaptures()
    {
        foreach (var capture in captures.ToArray())
        {
            try
            {
                if (!capture.Process.HasExited)
                {
                    capture.Process.Kill(entireProcessTree: true);
                    capture.Process.WaitForExit(5000);
                }
            }
            catch
            {
                // Best effort on close/end.
            }
            finally
            {
                capture.Writer.Dispose();
                capture.Process.Dispose();
                captures.Remove(capture);
            }
        }
    }

    private List<string> GetCurrentCaptureFiles()
    {
        if (!Directory.Exists(captureDir)) return new List<string>();
        var stamp = currentStamp ?? FindLatestCaptureStamp();
        if (string.IsNullOrWhiteSpace(stamp)) return new List<string>();
        return Directory
            .EnumerateFiles(captureDir, $"counterside-all-*-{stamp}.pcapng")
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private string FindLatestCaptureStamp()
    {
        var regex = new Regex(@"counterside-all-\d+-.+-(\d{8}-\d{6})\.pcapng$", RegexOptions.IgnoreCase);
        return Directory
            .EnumerateFiles(captureDir, "counterside-all-*.pcapng")
            .Select(path => new { Path = path, Match = regex.Match(Path.GetFileName(path)), LastWrite = File.GetLastWriteTimeUtc(path) })
            .Where(item => item.Match.Success)
            .OrderByDescending(item => item.LastWrite)
            .Select(item => item.Match.Groups[1].Value)
            .FirstOrDefault() ?? "";
    }

    private List<CaptureInterface> ResolveInterfaces()
    {
        var result = RunProcess(dumpcapPath, ["-D"], repoRoot);
        if (result.ExitCode != 0) throw new InvalidOperationException(result.Error.Trim());
        var interfaces = new List<CaptureInterface>();
        var regex = new Regex(@"^(\d+)\.\s+(.+?)(?:\s+\((.+)\))?\s*$");
        foreach (var line in result.Output.SplitLines())
        {
            var match = regex.Match(line.Trim());
            if (!match.Success) continue;
            var name = match.Groups[3].Success ? match.Groups[3].Value : match.Groups[2].Value;
            interfaces.Add(new CaptureInterface(match.Groups[1].Value, name));
        }
        return interfaces;
    }

    private async Task<List<StreamInfo>> EnumerateCandidateStreamsAsync(string pcapFile)
    {
        var result = await RunProcessAsync(
            tsharkPath,
            [
                "-r",
                pcapFile,
                "-Y",
                "tcp.len > 0",
                "-T",
                "fields",
                "-E",
                "separator=\t",
                "-e",
                "tcp.stream",
                "-e",
                "tcp.srcport",
                "-e",
                "tcp.dstport",
                "-e",
                "tcp.len",
            ],
            repoRoot);
        if (result.ExitCode != 0) throw new InvalidOperationException(result.Error.Trim());

        var byStream = new Dictionary<int, StreamInfo>();
        foreach (var line in result.Output.SplitLines())
        {
            var parts = line.Split('\t');
            if (parts.Length < 4 || !int.TryParse(parts[0], out var streamId)) continue;
            if (!long.TryParse(parts[3], out var length)) length = 0;
            if (!byStream.TryGetValue(streamId, out var stream))
            {
                stream = new StreamInfo(streamId);
                byStream[streamId] = stream;
            }
            stream.TotalBytes += Math.Max(0, length);
            if (GamePorts.Contains(parts[1]) || GamePorts.Contains(parts[2])) stream.HasGamePort = true;
        }

        return byStream.Values
            .Where(stream => stream.TotalBytes >= 64)
            .OrderByDescending(stream => stream.HasGamePort)
            .ThenByDescending(stream => stream.TotalBytes)
            .Take(1000)
            .ToList();
    }

    private async Task<bool> TryExtractStreamAsync(string pcapFile, string outputDir, int stream, bool logFailures)
    {
        if (Directory.Exists(outputDir)) Directory.Delete(outputDir, recursive: true);
        Directory.CreateDirectory(outputDir);
        var result = await RunProcessAsync(
            nodePath,
            [
                Path.Combine(repoRoot, "tools", "extract-cs-pcap-fixtures.js"),
                pcapFile,
                outputDir,
                "game",
                stream.ToString(),
            ],
            repoRoot,
            BuildToolEnvironment());
        if (result.ExitCode == 0) return File.Exists(Path.Combine(outputDir, "manifest.json"));
        if (logFailures) AppendLog($"  stream {stream} skipped: {FirstLine(result.Error)}");
        return false;
    }

    private static bool ManifestHasJoinLobbyAck(string manifestPath)
    {
        if (!File.Exists(manifestPath)) return false;
        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        if (!doc.RootElement.TryGetProperty("server", out var server) || server.ValueKind != JsonValueKind.Array) return false;
        return server.EnumerateArray().Any(entry =>
            entry.TryGetProperty("packetId", out var packetId) &&
            packetId.TryGetInt32(out var value) &&
            value == 205);
    }

    private async Task<ImportResult> ImportProfileAsync(string captureExtractDir, string copyPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(copyPath)!);
        var args = new List<string>
        {
            Path.Combine(repoRoot, "tools", "import-official-join-lobby-profile.js"),
            "--capture-dir",
            captureExtractDir,
            "--copy-to",
            copyPath,
        };
        if (IsManagedDir(managedDir))
        {
            args.Add("--managed-dir");
            args.Add(managedDir);
        }
        var result = await RunProcessAsync(
            nodePath,
            args,
            repoRoot,
            BuildToolEnvironment());
        if (result.ExitCode != 0) throw new InvalidOperationException(result.Error.Trim());

        using var doc = JsonDocument.Parse(result.Output);
        var user = doc.RootElement.GetProperty("user");
        return new ImportResult(
            user.GetProperty("userUid").GetString() ?? "",
            user.GetProperty("officialUserUid").GetString() ?? "",
            user.GetProperty("nickname").GetString() ?? "");
    }

    private Dictionary<string, string> BuildToolEnvironment()
    {
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["CS_TSHARK_PATH"] = tsharkPath,
        };
        if (IsManagedDir(managedDir)) environment["CS_COUNTERSIDE_MANAGED_DIR"] = managedDir;
        var bundledCombatHost = Path.Combine(repoRoot, "combat-host", "CombatHost.exe");
        if (File.Exists(bundledCombatHost)) environment["CS_COMBAT_HOST_PATH"] = bundledCombatHost;
        return environment;
    }

    private static void CopyUsersJsonToClipboard(string filePath)
    {
        var files = new StringCollection { filePath };
        var data = new DataObject();
        data.SetFileDropList(files);
        data.SetText(File.ReadAllText(filePath, Encoding.UTF8), TextDataFormat.UnicodeText);
        Clipboard.SetDataObject(data, true);
    }

    private static ProcessResult RunProcess(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        using var process = BuildProcess(fileName, args, workingDirectory, environment);
        process.Start();
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return new ProcessResult(process.ExitCode, output, error);
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        using var process = BuildProcess(fileName, args, workingDirectory, environment);
        process.Start();
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await outputTask, await errorTask);
    }

    private static Process BuildProcess(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? environment)
    {
        EnsureCompatibleExecutable(Path.GetFileName(fileName), fileName);
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        if (environment != null)
        {
            foreach (var item in environment)
            {
                process.StartInfo.Environment[item.Key] = item.Value;
            }
        }
        return process;
    }

    private static string DescribeExecutable(string fileName)
    {
        var machine = ReadPortableExecutableMachine(fileName);
        return string.IsNullOrWhiteSpace(machine) ? fileName : $"{fileName} ({machine})";
    }

    private static void EnsureCompatibleExecutable(string toolName, string fileName)
    {
        var machine = ReadPortableExecutableMachine(fileName);
        if (string.IsNullOrWhiteSpace(machine)) return;
        var processArch = RuntimeInformation.ProcessArchitecture.ToString();
        if (!machine.Equals(processArch, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"{toolName} is {machine}, but this capture app is running as {processArch}. " +
                "Use the RevivalSide capture package that matches this PC architecture.");
        }
    }

    private static string ReadPortableExecutableMachine(string fileName)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(fileName) || !File.Exists(fileName)) return "";
            Span<byte> header = stackalloc byte[64];
            using var stream = File.OpenRead(fileName);
            if (stream.Read(header) < header.Length) return "";
            if (BitConverter.ToUInt16(header[..2]) != 0x5A4D) return "";
            var peOffset = BitConverter.ToInt32(header.Slice(0x3C, 4));
            if (peOffset < 0 || peOffset > stream.Length - 6) return "";
            stream.Position = peOffset + 4;
            Span<byte> machineBytes = stackalloc byte[2];
            if (stream.Read(machineBytes) < 2) return "";
            return BitConverter.ToUInt16(machineBytes) switch
            {
                0x014c => "X86",
                0x8664 => "X64",
                0xaa64 => "Arm64",
                0x01c4 => "Arm",
                var value => $"0x{value:x}",
            };
        }
        catch
        {
            return "";
        }
    }

    private static string ResolveRepoRoot()
    {
        foreach (var seed in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var appDirectory = Path.Combine(seed, "app");
            if (IsRepoRoot(appDirectory)) return appDirectory;

            var directory = new DirectoryInfo(seed);
            while (directory != null)
            {
                if (IsRepoRoot(directory.FullName)) return directory.FullName;
                directory = directory.Parent;
            }
        }
        return Environment.CurrentDirectory;
    }

    private static bool IsRepoRoot(string directory)
    {
        return Directory.Exists(directory) &&
            File.Exists(Path.Combine(directory, "package.json")) &&
            File.Exists(Path.Combine(directory, "tools", "extract-cs-pcap-fixtures.js"));
    }

    private static string ResolveToolPath(string toolName, params string[] bundledRelativePaths)
    {
        foreach (var relativePath in bundledRelativePaths)
        {
            var bundledPath = Path.Combine(AppContext.BaseDirectory, relativePath);
            if (File.Exists(bundledPath)) return bundledPath;
        }
        if (toolName.Equals("dumpcap.exe", StringComparison.OrdinalIgnoreCase) ||
            toolName.Equals("tshark.exe", StringComparison.OrdinalIgnoreCase))
        {
            var wiresharkPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Wireshark", toolName);
            if (File.Exists(wiresharkPath)) return wiresharkPath;
        }
        return toolName;
    }

    private static string SafeName(string value)
    {
        var safe = Regex.Replace(value, @"[^A-Za-z0-9._-]+", "_").Trim('_');
        return string.IsNullOrWhiteSpace(safe) ? "interface" : safe;
    }

    private static string FirstLine(string value)
    {
        return value.SplitLines().FirstOrDefault(line => !string.IsNullOrWhiteSpace(line)) ?? "no details";
    }

    private void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatus(text));
            return;
        }
        statusLabel.Text = text;
        if (text.Contains("Recording", StringComparison.OrdinalIgnoreCase))
        {
            statusLabel.ForeColor = Color.FromArgb(12, 102, 228);
        }
        else if (text.Contains("Failed", StringComparison.OrdinalIgnoreCase))
        {
            statusLabel.ForeColor = Color.FromArgb(185, 28, 28);
        }
        else
        {
            statusLabel.ForeColor = Color.FromArgb(22, 101, 52);
        }
    }

    private void AppendLog(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLog(text));
            return;
        }
        logBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
    }
}

internal static class StringExtensions
{
    public static IEnumerable<string> SplitLines(this string value)
    {
        return value.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
    }
}

internal sealed record CaptureInterface(string Id, string Name);

internal sealed record CaptureProcess(
    Process Process,
    StreamWriter Writer,
    string PcapFile,
    string LogFile,
    CaptureInterface Interface);

internal sealed class CaptureSettings
{
    public string CounterSideManagedDir { get; set; } = "";
}

internal sealed class StreamInfo(int stream)
{
    public int Stream { get; } = stream;
    public long TotalBytes { get; set; }
    public bool HasGamePort { get; set; }
}

internal sealed record ImportResult(string UserUid, string OfficialUserUid, string Nickname);

internal sealed record ProcessResult(int ExitCode, string Output, string Error);
