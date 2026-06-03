using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Microsoft.Win32;

namespace RevivalSideLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<LauncherApp>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}

internal sealed class LauncherApp : Application
{
    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        RequestedThemeVariant = ThemeVariant.Dark;
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new LauncherWindow();
        }
        base.OnFrameworkInitializationCompleted();
    }
}

internal sealed class LauncherWindow : Window
{
    private readonly string appRoot;
    private readonly string settingsPath;
    private readonly string nodePath;
    private readonly string npmPath;
    private readonly object processLogLock = new();
    private readonly Bitmap? launcherBackground;
    private readonly string launcherBackgroundName;

    private LauncherSettings settings;
    private Process? listenerProcess;
    private ProcessJob? listenerJob;
    private Process? wikiProcess;
    private Border? dashboardView;
    private Border? settingsView;

    private readonly Button dashboardNavButton = new() { Content = "Home", MinWidth = 92, Height = 38 };
    private readonly Button settingsNavButton = new() { Content = "Settings", MinWidth = 116, Height = 38 };
    private readonly Button openLogsButton = new() { Content = "Logs", MinWidth = 92, Height = 38 };
    private readonly Button startListenerButton = new() { Content = "START", MinWidth = 244, Height = 58 };
    private readonly Button stopListenerButton = new() { Content = "Stop", MinWidth = 96, Height = 38, IsEnabled = false };
    private readonly Button openUserManagerButton = new() { Content = "User Manager", MinWidth = 158, Height = 38 };
    private readonly Button openWikiButton = new() { Content = "Wiki", MinWidth = 88, Height = 38 };
    private readonly Button patchHostsButton = new() { Content = "Patch Hosts", MinWidth = 124, Height = 38 };
    private readonly Button unpatchHostsButton = new() { Content = "Unpatch", MinWidth = 108, Height = 38 };
    private readonly Button browseManagedButton = new() { Content = "Browse", MinWidth = 104, Height = 38 };
    private readonly Button detectManagedButton = new() { Content = "Detect", MinWidth = 104, Height = 38 };
    private readonly Button saveSettingsButton = new() { Content = "Save Settings", MinWidth = 150, Height = 40 };
    private readonly Button verifyGameplayJsonsButton = new() { Content = "Verify Data", MinWidth = 130, Height = 40 };
    private readonly Button installGameplayJsonsButton = new() { Content = "Install JSONs", MinWidth = 144, Height = 40 };
    private readonly Button setTimeButton = new() { Content = "Set Time", MinWidth = 126, Height = 40 };
    private readonly Button clearTimeButton = new() { Content = "Clear", MinWidth = 94, Height = 40 };

    private readonly TextBlock listenerStatusText = new() { Text = "Stopped" };
    private readonly TextBlock gameplayDataStatusText = new() { Text = "Not checked" };
    private readonly TextBox managedDirBox = new() { IsReadOnly = true };
    private readonly NumericUpDown portInput = new() { Minimum = 1, Maximum = 65535, Value = 22000, Width = 110 };
    private readonly NumericUpDown httpPortInput = new() { Minimum = 1, Maximum = 65535, Value = 8088, Width = 110 };
    private readonly NumericUpDown wikiPortInput = new() { Minimum = 1, Maximum = 65535, Value = 5174, Width = 110 };
    private readonly TextBox eventDateInput = new() { Width = 150, PlaceholderText = "YYYY-MM-DD" };
    private readonly ComboBox joinLobbyModeInput = new() { Width = 132, ItemsSource = new[] { "auto", "on", "off" } };
    private readonly TextBox advancedEnvInput = new() { AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap };
    private readonly CheckBox userManagerRemoteInput = new() { Content = "Allow LAN User Manager access" };
    private readonly CheckBox verboseInput = new() { Content = "Verbose listener logs" };
    private readonly CheckBox replayGameFlowInput = new() { Content = "Replay captured game flow" };
    private readonly CheckBox skipTutorialInput = new() { Content = "Skip tutorial to win" };
    private readonly CheckBox resetTutorialInput = new() { Content = "Reset tutorial on login" };
    private readonly TextBox serverTimeInput = new() { Width = 210 };
    private readonly TextBox logBox = new()
    {
        AcceptsReturn = true,
        IsReadOnly = true,
        TextWrapping = TextWrapping.NoWrap,
    };

    public LauncherWindow()
    {
        appRoot = ResolveAppRoot();
        settingsPath = Path.Combine(appRoot, "launcher-settings.json");
        settings = LoadSettings();
        settings.CounterSideManagedDir = ResolveInitialManagedDir(settings.CounterSideManagedDir);
        nodePath = ResolveToolPath("node.exe", Path.Combine("runtime", "node", "node.exe"));
        npmPath = ResolveToolPath("npm.cmd", Path.Combine("runtime", "node", "npm.cmd"));
        (launcherBackground, launcherBackgroundName) = LoadRandomCutsceneBackground(appRoot);

        Title = "RevivalSide Launcher";
        Width = 1180;
        Height = 680;
        MinWidth = 960;
        MinHeight = 600;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brushes.Black;
        Content = BuildUi();

        LoadSettingsIntoUi();
        BindEvents();

        AppendLog($"App: {appRoot}");
        AppendLog($"Architecture: {RuntimeInformation.ProcessArchitecture} on {RuntimeInformation.OSArchitecture}");
        AppendLog($"Node: {DescribeExecutable(nodePath)}");
        AppendLog($"npm: {npmPath}");
        AppendLog(IsManagedDir(settings.CounterSideManagedDir) ? $"CounterSide DLL: {Path.Combine(settings.CounterSideManagedDir, "Assembly-CSharp.dll")}" : "CounterSide DLL: not selected");
        try
        {
            var gameplayJsons = ValidateGameplayJsonsDirectory(GameplayJsonsDir());
            gameplayDataStatusText.Text = $"{gameplayJsons.FileCount:N0} files";
            AppendLog($"Gameplay JSONs: {gameplayJsons.FileCount:N0} files at {gameplayJsons.Path}");
        }
        catch (Exception ex)
        {
            gameplayDataStatusText.Text = "Missing or incomplete";
            AppendLog($"Gameplay JSONs need install: {ex.Message}");
        }
    }

    private Control BuildUi()
    {
        StyleControls();
        var root = new Grid();
        if (launcherBackground != null)
        {
            root.Children.Add(new Image { Source = launcherBackground, Stretch = Stretch.UniformToFill });
        }
        else
        {
            root.Children.Add(new Border { Background = DiagonalGradient(Color.FromRgb(16, 24, 36), Color.FromRgb(50, 34, 52)) });
        }
        root.Children.Add(new Border { Background = HorizontalGradient(Color.FromArgb(230, 4, 7, 12), Color.FromArgb(88, 4, 7, 12)) });
        root.Children.Add(new Border { Background = VerticalGradient(Color.FromArgb(0, 4, 7, 12), Color.FromArgb(230, 4, 7, 12)), VerticalAlignment = VerticalAlignment.Bottom, Height = 280 });

        var shell = new Grid
        {
            Margin = new Thickness(30, 22, 30, 24),
            RowDefinitions = new RowDefinitions("Auto,*"),
        };
        shell.Children.Add(BuildHeader());
        var viewHost = new Grid { Margin = new Thickness(0, 16, 0, 0) };
        Grid.SetRow(viewHost, 1);
        dashboardView = BuildDashboardView();
        settingsView = BuildSettingsView();
        viewHost.Children.Add(dashboardView);
        viewHost.Children.Add(settingsView);
        shell.Children.Add(viewHost);
        root.Children.Add(shell);
        ShowView("dashboard");
        return root;
    }

    private Control BuildHeader()
    {
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,324") };
        var brand = new StackPanel { Spacing = 3 };
        brand.Children.Add(new TextBlock
        {
            Text = "RevivalSide",
            Foreground = Brushes.White,
            FontFamily = "Inter",
            FontSize = 48,
            FontWeight = FontWeight.SemiBold,
            LineHeight = 54,
        });
        brand.Children.Add(new TextBlock
        {
            Text = "Local listener, wiki, and client routing",
            Foreground = Brush(232, 238, 246),
            FontSize = 19,
        });
        brand.Children.Add(new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(launcherBackgroundName) ? "Cutscene background unavailable" : $"Story background: {launcherBackgroundName}",
            Foreground = Brush(184, 196, 214),
            FontSize = 13,
            Margin = new Thickness(0, 6, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        header.Children.Add(brand);

        var nav = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 8, 0, 0),
        };
        nav.Children.Add(dashboardNavButton);
        nav.Children.Add(settingsNavButton);
        nav.Children.Add(openLogsButton);
        Grid.SetColumn(nav, 1);
        header.Children.Add(nav);
        return header;
    }

    private Border BuildDashboardView()
    {
        var view = new Border { Background = Brushes.Transparent };
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("430,*") };

        var left = Glass(new Thickness(22), new Thickness(0, 0, 20, 0));
        var leftLayout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,Auto,Auto,Auto,Auto,Auto,*") };
        AddRow(leftLayout, Eyebrow("Listener"), 0);
        listenerStatusText.FontSize = 34;
        listenerStatusText.FontWeight = FontWeight.SemiBold;
        listenerStatusText.Foreground = Brushes.White;
        AddRow(leftLayout, listenerStatusText, 1);
        AddRow(leftLayout, Muted("Start server, open tools.", 32), 2);
        AddRow(leftLayout, Row(stopListenerButton, openUserManagerButton, openWikiButton), 3);
        AddRow(leftLayout, Divider(), 4);
        AddRow(leftLayout, Eyebrow("Client Routing"), 5);
        AddRow(leftLayout, Row(patchHostsButton, unpatchHostsButton), 6);
        var logs = Glass(new Thickness(12), new Thickness(0, 18, 0, 0), Color.FromArgb(168, 6, 9, 13));
        logs.Child = Scrollable(logBox);
        AddRow(leftLayout, logs, 7);
        left.Child = leftLayout;
        grid.Children.Add(left);

        var hero = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        var startRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 0, 26) };
        startRow.Children.Add(startListenerButton);
        AddRow(hero, startRow, 1);
        Grid.SetColumn(hero, 1);
        grid.Children.Add(hero);

        view.Child = grid;
        return view;
    }

    private Border BuildSettingsView()
    {
        var card = Glass(new Thickness(24), new Thickness(0), Color.FromArgb(218, 10, 14, 22));
        card.MaxWidth = 1080;
        card.HorizontalAlignment = HorizontalAlignment.Center;
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };

        var heading = new StackPanel { Spacing = 4, Margin = new Thickness(0, 0, 0, 16) };
        heading.Children.Add(Eyebrow("Settings"));
        heading.Children.Add(new TextBlock
        {
            Text = "Runtime, routing, profile capture, and server time.",
            Foreground = Brush(190, 202, 220),
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap,
        });
        AddRow(layout, heading, 0);

        var content = new StackPanel { Spacing = 14 };
        content.Children.Add(SettingsSection("Official Client", BuildClientSettings()));
        content.Children.Add(SettingsSection("Listener", BuildListenerSettings()));
        content.Children.Add(SettingsSection("Data & Time", BuildDataTimeSettings()));
        content.Children.Add(SettingsSection("Advanced Environment", BuildAdvancedSettings()));
        var scroll = new ScrollViewer
        {
            Content = content,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        };
        AddRow(layout, scroll, 1);

        var saveRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        saveRow.Children.Add(saveSettingsButton);
        AddRow(layout, saveRow, 2);
        card.Child = layout;
        return card;
    }

    private Control BuildClientSettings()
    {
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto"), ColumnSpacing = 10 };
        row.Children.Add(managedDirBox);
        Grid.SetColumn(browseManagedButton, 1);
        row.Children.Add(browseManagedButton);
        Grid.SetColumn(detectManagedButton, 2);
        row.Children.Add(detectManagedButton);
        return row;
    }

    private Control BuildListenerSettings()
    {
        var layout = new StackPanel { Spacing = 12 };
        var ports = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*,*"), ColumnSpacing = 12 };
        AddColumn(ports, Field("TCP", portInput), 0);
        AddColumn(ports, Field("HTTP", httpPortInput), 1);
        AddColumn(ports, Field("Wiki", wikiPortInput), 2);
        AddColumn(ports, Field("Event date", eventDateInput), 3);
        AddColumn(ports, Field("Lobby ACK", joinLobbyModeInput), 4);
        layout.Children.Add(ports);

        var toggles = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,*"),
            RowDefinitions = new RowDefinitions("Auto,Auto,Auto"),
            ColumnSpacing = 18,
            RowSpacing = 8,
            Margin = new Thickness(0, 4, 0, 0),
        };
        AddCell(toggles, userManagerRemoteInput, 0, 0);
        AddCell(toggles, verboseInput, 1, 0);
        AddCell(toggles, replayGameFlowInput, 0, 1);
        AddCell(toggles, skipTutorialInput, 1, 1);
        AddCell(toggles, resetTutorialInput, 0, 2);
        layout.Children.Add(toggles);
        return layout;
    }

    private Control BuildDataTimeSettings()
    {
        var layout = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*"), ColumnSpacing = 18 };
        var data = new StackPanel { Spacing = 10 };
        data.Children.Add(ValueRow("Gameplay Data", gameplayDataStatusText));
        data.Children.Add(Row(verifyGameplayJsonsButton, installGameplayJsonsButton));

        var time = new StackPanel { Spacing = 10 };
        time.Children.Add(Field("Server time", serverTimeInput));
        time.Children.Add(Row(setTimeButton, clearTimeButton));

        layout.Children.Add(data);
        Grid.SetColumn(time, 1);
        layout.Children.Add(time);
        return layout;
    }

    private Control BuildAdvancedSettings()
    {
        advancedEnvInput.Height = 88;
        return Scrollable(advancedEnvInput);
    }

    private void ShowView(string viewName)
    {
        if (dashboardView != null) dashboardView.IsVisible = viewName == "dashboard";
        if (settingsView != null) settingsView.IsVisible = viewName == "settings";
        StyleNavButton(dashboardNavButton, viewName == "dashboard");
        StyleNavButton(settingsNavButton, viewName == "settings");
    }

    private void StyleControls()
    {
        foreach (var button in new[]
        {
            dashboardNavButton,
            settingsNavButton,
            stopListenerButton,
            openUserManagerButton,
            openWikiButton,
            patchHostsButton,
            unpatchHostsButton,
            openLogsButton,
            browseManagedButton,
            detectManagedButton,
            verifyGameplayJsonsButton,
            clearTimeButton,
        })
        {
            StyleButton(button);
        }
        foreach (var button in new[] { startListenerButton, saveSettingsButton, installGameplayJsonsButton, setTimeButton })
        {
            StyleButton(button, primary: true);
        }
        startListenerButton.FontSize = 22;
        startListenerButton.FontWeight = FontWeight.Black;

        foreach (var input in new Control[] { managedDirBox, portInput, httpPortInput, wikiPortInput, eventDateInput, joinLobbyModeInput, advancedEnvInput, serverTimeInput })
        {
            StyleInput(input);
        }
        advancedEnvInput.FontFamily = "Cascadia Code, Consolas";
        logBox.Background = Brush(8, 11, 16);
        logBox.Foreground = Brush(217, 226, 238);
        logBox.FontFamily = "Cascadia Code, Consolas";
        logBox.FontSize = 13;
        logBox.BorderThickness = new Thickness(0);
        gameplayDataStatusText.Foreground = Brush(226, 232, 240);
        gameplayDataStatusText.VerticalAlignment = VerticalAlignment.Center;
    }

    private static void StyleButton(Button button, bool primary = false)
    {
        button.Background = primary ? Brush(255, 218, 76) : Brush(36, 44, 58);
        button.Foreground = primary ? Brush(18, 22, 28) : Brush(238, 243, 248);
        button.BorderBrush = primary ? Brush(255, 231, 132) : Brush(92, 106, 128);
        button.BorderThickness = new Thickness(1);
        button.CornerRadius = new CornerRadius(primary ? 12 : 4);
        button.Padding = primary ? new Thickness(26, 10) : new Thickness(16, 8);
        button.FontFamily = "Inter";
        button.FontSize = primary ? 16 : 14;
        button.FontWeight = FontWeight.SemiBold;
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        button.VerticalContentAlignment = VerticalAlignment.Center;
    }

    private static void StyleNavButton(Button button, bool active)
    {
        StyleButton(button);
        button.Background = active ? Brush(238, 244, 252) : new SolidColorBrush(Color.FromArgb(128, 12, 16, 23));
        button.Foreground = active ? Brush(18, 22, 28) : Brush(236, 242, 248);
        button.BorderBrush = active ? Brushes.White : new SolidColorBrush(Color.FromArgb(132, 162, 178, 198));
        button.FontSize = 14;
    }

    private static void StyleInput(Control input)
    {
        switch (input)
        {
            case TextBox textBox:
                textBox.Background = Brush(17, 22, 30);
                textBox.Foreground = Brush(236, 242, 248);
                textBox.FontSize = 14;
                break;
            case NumericUpDown numericUpDown:
                numericUpDown.Background = Brush(17, 22, 30);
                numericUpDown.Foreground = Brush(236, 242, 248);
                numericUpDown.FontSize = 14;
                break;
            case ComboBox comboBox:
                comboBox.Background = Brush(17, 22, 30);
                comboBox.Foreground = Brush(236, 242, 248);
                comboBox.FontSize = 14;
                break;
        }
    }

    private static ScrollViewer Scrollable(Control child) => new()
    {
        Content = child,
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
    };

    private static Border Glass(Thickness padding, Thickness margin, Color? fill = null)
    {
        return new Border
        {
            Padding = padding,
            Margin = margin,
            CornerRadius = new CornerRadius(18),
            Background = new SolidColorBrush(fill ?? Color.FromArgb(204, 12, 16, 23)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(96, 255, 255, 255)),
            BorderThickness = new Thickness(1),
        };
    }

    private static TextBlock Eyebrow(string text) => new()
    {
        Text = text.ToUpperInvariant(),
        Foreground = Brush(255, 218, 87),
        FontSize = 15,
        FontWeight = FontWeight.Bold,
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static TextBlock Muted(string text, double height) => new()
    {
        Text = text,
        Foreground = Brush(190, 202, 220),
        FontSize = 15,
        Height = height,
        TextWrapping = TextWrapping.Wrap,
    };

    private static Border Divider() => new()
    {
        Height = 1,
        Background = new SolidColorBrush(Color.FromArgb(82, 255, 255, 255)),
        Margin = new Thickness(0, 14, 0, 18),
    };

    private static Control SettingsSection(string title, Control content)
    {
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,Auto") };
        AddRow(layout, new TextBlock
        {
            Text = title.ToUpperInvariant(),
            Foreground = Brush(255, 218, 87),
            FontSize = 13,
            FontWeight = FontWeight.Bold,
            Margin = new Thickness(0, 0, 0, 8),
        }, 0);
        AddRow(layout, content, 1);
        AddRow(layout, new Border
        {
            Height = 1,
            Background = new SolidColorBrush(Color.FromArgb(66, 255, 255, 255)),
            Margin = new Thickness(0, 14, 0, 0),
        }, 2);
        return layout;
    }

    private static Control Field(string label, Control control)
    {
        var panel = new StackPanel { Spacing = 6 };
        panel.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 202),
            FontSize = 12,
            FontWeight = FontWeight.Bold,
        });
        panel.Children.Add(control);
        return panel;
    }

    private static Control ValueRow(string label, Control value)
    {
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), ColumnSpacing = 16 };
        row.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 202),
            FontSize = 13,
            FontWeight = FontWeight.Bold,
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(value, 1);
        row.Children.Add(value);
        return row;
    }

    private static Control SettingRow(string title, Control content, params Control[] actions)
    {
        var row = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("140,*,Auto"),
            Margin = new Thickness(0, 15, 0, 0),
            MinHeight = 44,
        };
        row.Children.Add(new TextBlock
        {
            Text = title,
            Foreground = Brush(176, 186, 202),
            FontSize = 15,
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(content, 1);
        row.Children.Add(content);
        var buttons = Row(actions);
        Grid.SetColumn(buttons, 2);
        row.Children.Add(buttons);
        return row;
    }

    private static Control Labeled(string label, Control control)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7, Margin = new Thickness(0, 0, 16, 10) };
        panel.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(176, 186, 202),
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center,
        });
        panel.Children.Add(control);
        return panel;
    }

    private static StackPanel Row(params Control[] controls)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 4) };
        foreach (var control in controls) row.Children.Add(control);
        return row;
    }

    private static void AddRow(Grid grid, Control control, int row)
    {
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private static void AddColumn(Grid grid, Control control, int column)
    {
        Grid.SetColumn(control, column);
        grid.Children.Add(control);
    }

    private static void AddCell(Grid grid, Control control, int column, int row)
    {
        Grid.SetColumn(control, column);
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private void BindEvents()
    {
        dashboardNavButton.Click += (_, _) => ShowView("dashboard");
        settingsNavButton.Click += (_, _) => ShowView("settings");
        openLogsButton.Click += (_, _) => OpenLogsDirectory();
        startListenerButton.Click += async (_, _) => await RunUiAction(StartListenerAsync);
        stopListenerButton.Click += (_, _) => StopListener();
        openUserManagerButton.Click += (_, _) =>
        {
            SaveSettingsFromUi();
            OpenUrl($"http://127.0.0.1:{settings.HttpPort}/user-manager");
        };
        openWikiButton.Click += async (_, _) => await RunUiAction(OpenWikiAsync);
        patchHostsButton.Click += (_, _) => RunHostsPatch(remove: false);
        unpatchHostsButton.Click += (_, _) => RunHostsPatch(remove: true);
        browseManagedButton.Click += async (_, _) => await RunUiAction(BrowseManagedAssemblyAsync);
        detectManagedButton.Click += async (_, _) => await RunUiAction(async () => { await DetectManagedAssemblyAsync(showMessage: true); });
        saveSettingsButton.Click += (_, _) => SaveSettingsFromUi();
        verifyGameplayJsonsButton.Click += async (_, _) => await RunUiAction(VerifyGameplayJsonsAsync);
        installGameplayJsonsButton.Click += async (_, _) => await RunUiAction(InstallGameplayJsonsAsync);
        setTimeButton.Click += async (_, _) => await RunUiAction(SetServerTimeAsync);
        clearTimeButton.Click += async (_, _) => await RunUiAction(ClearServerTimeAsync);
        Closing += (_, _) =>
        {
            StopListener();
            StopWiki();
        };
    }

    private async Task RunUiAction(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            AppendLog($"ERROR: {ex.Message}");
            await ShowMessageAsync("RevivalSide", ex.Message);
        }
        finally
        {
            UpdateButtons();
        }
    }

    private void LoadSettingsIntoUi()
    {
        managedDirBox.Text = IsManagedDir(settings.CounterSideManagedDir) ? settings.CounterSideManagedDir : "CounterSide Assembly-CSharp.dll not selected";
        portInput.Value = ClampPort(settings.GamePort, 22000);
        httpPortInput.Value = ClampPort(settings.HttpPort, 8088);
        wikiPortInput.Value = ClampPort(settings.WikiPort, 5174);
        eventDateInput.Text = settings.EventDate;
        joinLobbyModeInput.SelectedItem = NormalizeJoinLobbyMode(settings.JoinLobbyAckMode);
        userManagerRemoteInput.IsChecked = settings.UserManagerAllowRemote;
        verboseInput.IsChecked = settings.VerboseCapture;
        replayGameFlowInput.IsChecked = settings.ReplayCapturedGameFlow;
        skipTutorialInput.IsChecked = settings.SkipTutorialToWin;
        resetTutorialInput.IsChecked = settings.ResetTutorialOnLogin;
        advancedEnvInput.Text = settings.AdvancedEnvText;
        serverTimeInput.Text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        UpdateButtons();
    }

    private void SaveSettingsFromUi()
    {
        settings.SettingsVersion = LauncherSettings.CurrentVersion;
        settings.GamePort = Convert.ToInt32(portInput.Value ?? 22000);
        settings.HttpPort = Convert.ToInt32(httpPortInput.Value ?? 8088);
        settings.WikiPort = Convert.ToInt32(wikiPortInput.Value ?? 5174);
        settings.EventDate = (eventDateInput.Text ?? "").Trim();
        settings.JoinLobbyAckMode = NormalizeJoinLobbyMode(Convert.ToString(joinLobbyModeInput.SelectedItem) ?? joinLobbyModeInput.Text);
        settings.UserManagerAllowRemote = userManagerRemoteInput.IsChecked == true;
        settings.VerboseCapture = verboseInput.IsChecked == true;
        settings.ReplayCapturedGameFlow = replayGameFlowInput.IsChecked == true;
        settings.SkipTutorialToWin = skipTutorialInput.IsChecked == true;
        settings.ResetTutorialOnLogin = resetTutorialInput.IsChecked == true;
        settings.AdvancedEnvText = advancedEnvInput.Text ?? "";
        settings.CounterSideManagedDir = IsManagedDir(settings.CounterSideManagedDir) ? settings.CounterSideManagedDir : "";
        SaveSettings();
        AppendLog("Settings saved.");
    }

    private async Task StartListenerAsync()
    {
        if (listenerProcess is { HasExited: false }) return;
        SaveSettingsFromUi();
        EnsureRuntimeLayout();
        ValidateListenerRuntimeLayout();
        var gameplayJsons = VerifyGameplayJsonsReady();
        AppendLog($"Gameplay JSONs ready: {gameplayJsons.FileCount:N0} files at {gameplayJsons.Path}");
        var env = BuildListenerEnvironment();
        var logWriter = OpenProcessLog("listener", out var logPath);
        var listenCommand = CreateListenCommand();
        var job = ProcessJob.TryCreateKillOnClose();
        var process = new Process
        {
            StartInfo = listenCommand.StartInfo,
            EnableRaisingEvents = true,
        };
        foreach (var item in env) process.StartInfo.Environment[item.Key] = item.Value;
        process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
        process.Exited += (_, _) => Dispatcher.UIThread.Post(() =>
        {
            if (ReferenceEquals(listenerProcess, process))
            {
                listenerProcess = null;
                listenerJob?.Dispose();
                listenerJob = null;
                process.Dispose();
            }
            listenerStatusText.Text = "Stopped";
            UpdateButtons();
            AppendProcessLog(logWriter, "Listener stopped.");
            CloseProcessLog(logWriter);
        });
        if (!process.Start())
        {
            job?.Dispose();
            CloseProcessLog(logWriter);
            throw new InvalidOperationException("Could not start listener.");
        }
        try
        {
            job?.Assign(process);
        }
        catch (Exception ex)
        {
            job?.Dispose();
            job = null;
            AppendLog($"Listener process job unavailable; Stop will use process-tree fallback: {ex.Message}");
        }
        listenerProcess = process;
        listenerJob = job;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        listenerStatusText.Text = "Running";
        AppendLog($"Listener started: {listenCommand.Display}");
        AppendLog($"Listener log: {logPath}");
        UpdateButtons();
        await Task.CompletedTask;
    }

    private void StopListener()
    {
        if (listenerProcess == null && listenerJob == null) return;
        var process = listenerProcess;
        var job = listenerJob;
        listenerProcess = null;
        listenerJob = null;
        AppendLog("Stopping listener...");
        try
        {
            job?.Dispose();
            if (process is { HasExited: false } && !process.WaitForExit(1500))
            {
                KillProcessTree(process, "listener");
                process.WaitForExit(5000);
            }
            KillListeningProcessesOnPorts(settings.GamePort, settings.HttpPort);
            AppendLog("Listener stop requested.");
        }
        catch (Exception ex)
        {
            AppendLog($"Stop listener failed: {ex.Message}");
        }
        finally
        {
            process?.Dispose();
            listenerStatusText.Text = "Stopped";
            UpdateButtons();
        }
    }

    private void KillProcessTree(Process process, string name)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            return;
        }
        catch (Exception ex)
        {
            AppendLog($"{name} .NET process-tree stop failed: {ex.Message}");
        }
        if (OperatingSystem.IsWindows()) RunTaskKill(process.Id, name);
    }

    private void KillListeningProcessesOnPorts(params int[] ports)
    {
        if (!OperatingSystem.IsWindows()) return;
        var targetPorts = ports.Where(port => port > 0).Distinct().ToArray();
        if (targetPorts.Length == 0) return;
        foreach (var pid in FindListeningPids(targetPorts))
        {
            if (pid <= 0 || pid == Environment.ProcessId) continue;
            RunTaskKill(pid, "listener port");
        }
    }

    private IEnumerable<int> FindListeningPids(IReadOnlyCollection<int> ports)
    {
        var result = new HashSet<int>();
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano -p tcp",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            process.Start();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(3000);
            foreach (var line in output.SplitLines())
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (parts.Length < 5 || !parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                if (!TryParseEndpointPort(parts[1], out var port) || !ports.Contains(port)) continue;
                if (int.TryParse(parts[4], out var pid)) result.Add(pid);
            }
        }
        catch (Exception ex)
        {
            AppendLog($"Listener port cleanup scan failed: {ex.Message}");
        }
        return result;
    }

    private static bool TryParseEndpointPort(string endpoint, out int port)
    {
        port = 0;
        var text = endpoint.Trim();
        var marker = text.LastIndexOf(':');
        if (marker < 0 || marker == text.Length - 1) return false;
        return int.TryParse(text[(marker + 1)..].Trim(']'), out port);
    }

    private void RunTaskKill(int pid, string name)
    {
        try
        {
            using var taskkill = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = $"/PID {pid} /T /F",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            taskkill.Start();
            taskkill.WaitForExit(5000);
            AppendLog($"{name} taskkill PID {pid}: exit {taskkill.ExitCode}");
        }
        catch (Exception ex)
        {
            AppendLog($"{name} taskkill PID {pid} failed: {ex.Message}");
        }
    }

    private async Task OpenWikiAsync()
    {
        SaveSettingsFromUi();
        if (wikiProcess is not { HasExited: false })
        {
            var logWriter = OpenProcessLog("wiki", out var logPath);
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = nodePath,
                    WorkingDirectory = appRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
                EnableRaisingEvents = true,
            };
            process.StartInfo.ArgumentList.Add(Path.Combine(appRoot, "tools", "serve-revivalside-wiki.js"));
            process.StartInfo.ArgumentList.Add("--port");
            process.StartInfo.ArgumentList.Add(settings.WikiPort.ToString());
            process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
            process.Exited += (_, _) => Dispatcher.UIThread.Post(() =>
            {
                AppendProcessLog(logWriter, "Wiki server stopped.");
                CloseProcessLog(logWriter);
            });
            if (!process.Start())
            {
                CloseProcessLog(logWriter);
                throw new InvalidOperationException("Could not start wiki server.");
            }
            wikiProcess = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            AppendLog("Wiki server started.");
            AppendLog($"Wiki log: {logPath}");
            await Task.Delay(600);
        }
        OpenUrl($"http://127.0.0.1:{settings.WikiPort}/");
    }

    private void StopWiki()
    {
        try
        {
            if (wikiProcess is { HasExited: false }) wikiProcess.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best effort on close.
        }
        finally
        {
            wikiProcess?.Dispose();
            wikiProcess = null;
        }
    }

    private void RunHostsPatch(bool remove)
    {
        var script = Path.Combine(appRoot, "tools", "patch-hosts.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("hosts patch script was not found.", script);
        var args = new List<string> { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", Quote(script) };
        if (remove) args.Add("-Remove");
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = string.Join(" ", args),
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = appRoot,
            },
        };
        process.Start();
        AppendLog(remove ? "Hosts unpatch requested." : "Hosts patch requested.");
    }

    private async Task SetServerTimeAsync()
    {
        if (!DateTime.TryParse(serverTimeInput.Text, out var serverTime))
        {
            throw new InvalidOperationException("Server time must look like yyyy-MM-dd HH:mm:ss.");
        }
        WriteManualServerTime(serverTime);
        if (listenerProcess is { HasExited: false }) await PostServerTimeAsync(serverTime);
        AppendLog($"Server time set to {serverTime:yyyy-MM-dd HH:mm:ss}.");
    }

    private async Task ClearServerTimeAsync()
    {
        var statePath = ServerTimeStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
        File.WriteAllText(statePath, "{}\n", Encoding.UTF8);
        if (listenerProcess is { HasExited: false }) await PostClearServerTimeAsync();
        AppendLog("Manual server time cleared.");
    }

    private void WriteManualServerTime(DateTime serverTime)
    {
        var now = DateTime.Now;
        var serverUtc = serverTime.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(serverTime, DateTimeKind.Local).ToUniversalTime() : serverTime.ToUniversalTime();
        var localUtc = now.ToUniversalTime();
        var state = new Dictionary<string, object?>
        {
            ["version"] = 1,
            ["eventDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["anchorServerDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["anchorLocalDayKey"] = now.ToString("yyyy-MM-dd"),
            ["lastLocalDayKey"] = now.ToString("yyyy-MM-dd"),
            ["lastServerDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["manualServerIso"] = serverUtc.ToString("O"),
            ["manualLocalIso"] = localUtc.ToString("O"),
            ["manualSetAt"] = DateTime.UtcNow.ToString("O"),
            ["updatedAt"] = DateTime.UtcNow.ToString("O"),
        };
        var statePath = ServerTimeStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
        File.WriteAllText(statePath, JsonSerializer.Serialize(state, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine, Encoding.UTF8);
    }

    private async Task PostServerTimeAsync(DateTime serverTime)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var body = JsonSerializer.Serialize(new { iso = serverTime.ToUniversalTime().ToString("O") });
        await client.PostAsync($"http://127.0.0.1:{settings.HttpPort}/launcher/api/server-time", new StringContent(body, Encoding.UTF8, "application/json"));
    }

    private async Task PostClearServerTimeAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        await client.PostAsync($"http://127.0.0.1:{settings.HttpPort}/launcher/api/server-time/clear", new StringContent("{}", Encoding.UTF8, "application/json"));
    }

    private Dictionary<string, string> BuildListenerEnvironment()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        PrependPath(env, Path.GetDirectoryName(npmPath));
        PrependPath(env, Path.GetDirectoryName(nodePath));

        var packagedCombatHost = Path.Combine(appRoot, "combat-host", "CombatHost.exe");
        var sourceCombatProject = Path.Combine(appRoot, "combat-host", "CombatHost.csproj");
        if (File.Exists(packagedCombatHost) && !File.Exists(sourceCombatProject))
        {
            env["CS_CSHARP_COMBAT_HOST_DLL"] = packagedCombatHost;
            env["CS_COMBAT_HOST_PATH"] = packagedCombatHost;
        }
        if (IsManagedDir(settings.CounterSideManagedDir)) env["CS_COUNTERSIDE_MANAGED_DIR"] = settings.CounterSideManagedDir;
        ApplyAdvancedEnvironment(env, settings.AdvancedEnvText);
        return env;
    }

    private ListenCommand CreateListenCommand()
    {
        if (!File.Exists(npmPath))
        {
            throw new FileNotFoundException("npm.cmd was not found. The launcher must run the same command as the CLI listener: npm run listen.", npmPath);
        }
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/d /s /c \"\"{npmPath}\" run listen\"",
            WorkingDirectory = appRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        return new ListenCommand(startInfo, "npm run listen");
    }

    private static void PrependPath(Dictionary<string, string> env, string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
        var current = Environment.GetEnvironmentVariable("PATH") ?? "";
        var prefix = directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var alreadyPresent = current
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(item => item.Trim('"').TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Equals(prefix, StringComparison.OrdinalIgnoreCase));
        if (alreadyPresent) return;
        env["PATH"] = string.IsNullOrWhiteSpace(current) ? prefix : $"{prefix}{Path.PathSeparator}{current}";
    }

    private void EnsureRuntimeLayout()
    {
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-flows"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-tcp"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-game-flow"));
        Directory.CreateDirectory(LogsDir());
        var usersPath = Path.Combine(appRoot, "server-data", "users.json");
        if (!File.Exists(usersPath))
        {
            var starterPath = Path.Combine(appRoot, "server-data", "starter-users.json");
            if (File.Exists(starterPath))
            {
                File.Copy(starterPath, usersPath, overwrite: false);
                AppendLog("Starter profile seed installed.");
            }
            else
            {
                File.WriteAllText(usersPath, "{\n  \"schemaVersion\": 1,\n  \"nextUserUid\": \"1000000001\",\n  \"nextFriendCode\": \"10000001\",\n  \"activeUserUid\": \"\",\n  \"users\": {}\n}\n", Encoding.UTF8);
            }
        }
    }

    private void ValidateListenerRuntimeLayout()
    {
        RequireRuntimeFile("cs-listener.js", "listener entry");
        RequireRuntimeFile("package.json", "npm package manifest");
        RequireRuntimeFile("packet-schema.json", "packet schema");
        RequireRuntimeFile(Path.Combine("server-data", "captured-flows", "manifest.json"), "HTTP captured mirror manifest");
        RequireRuntimeDirectory("server", "listener server");
        RequireRuntimeDirectory("packet-handlers", "packet handlers");
        RequireRuntimeDirectory("modules", "listener modules");
        RequireRuntimeDirectory("combat-handler", "combat handler");
        if (!File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.exe")) && !File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.csproj")))
        {
            throw new DirectoryNotFoundException($"combat-host was not found under {Path.Combine(appRoot, "combat-host")}");
        }
        AppendLog("Runtime layout ready: mirror manifest, schema, handlers, modules, and combat host found.");
    }

    private void RequireRuntimeFile(string relativePath, string name)
    {
        var path = Path.Combine(appRoot, relativePath);
        if (!File.Exists(path)) throw new FileNotFoundException($"{name} was not found.", path);
    }

    private void RequireRuntimeDirectory(string relativePath, string name)
    {
        var path = Path.Combine(appRoot, relativePath);
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"{name} was not found: {path}");
    }

    private async Task VerifyGameplayJsonsAsync()
    {
        var status = await Task.Run(VerifyGameplayJsonsReady);
        AppendLog($"Gameplay JSONs verified: {status.FileCount:N0} files at {status.Path}");
    }

    private async Task InstallGameplayJsonsAsync()
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null) return;
        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Choose a complete gameplay-jsons folder to install into this launcher.",
            AllowMultiple = false,
        });
        var source = folders.FirstOrDefault()?.TryGetLocalPath();
        if (string.IsNullOrWhiteSpace(source)) return;

        var sourceStatus = ValidateGameplayJsonsDirectory(source);
        var destination = GameplayJsonsDir();
        if (SamePath(source, destination))
        {
            gameplayDataStatusText.Text = $"{sourceStatus.FileCount:N0} files";
            AppendLog($"Gameplay JSONs already installed: {sourceStatus.FileCount:N0} files at {sourceStatus.Path}");
            return;
        }
        AppendLog($"Installing gameplay JSONs from {sourceStatus.Path}");
        await Task.Run(() => CopyGameplayJsonsDirectory(sourceStatus.Path, destination));
        var installed = VerifyGameplayJsonsReady();
        AppendLog($"Gameplay JSONs installed: {installed.FileCount:N0} files at {installed.Path}");
    }

    private GameplayJsonStatus VerifyGameplayJsonsReady()
    {
        var status = ValidateGameplayJsonsDirectory(GameplayJsonsDir());
        Dispatcher.UIThread.Post(() => gameplayDataStatusText.Text = $"{status.FileCount:N0} files");
        return status;
    }

    private static GameplayJsonStatus ValidateGameplayJsonsDirectory(string directory)
    {
        var full = Path.GetFullPath(directory);
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException($"gameplay-jsons was not found: {full}");
        var assetbundles = Path.Combine(full, "Assetbundles");
        var streamingAssets = Path.Combine(full, "StreamingAssets");
        var defaults = Path.Combine(full, "new-account-defaults.json");
        if (!Directory.Exists(assetbundles)) throw new DirectoryNotFoundException($"gameplay-jsons is missing Assetbundles: {assetbundles}");
        if (!Directory.Exists(streamingAssets)) throw new DirectoryNotFoundException($"gameplay-jsons is missing StreamingAssets: {streamingAssets}");
        if (!File.Exists(defaults)) throw new FileNotFoundException("gameplay-jsons is missing new-account-defaults.json.", defaults);
        var fileCount = CountFiles(full);
        if (fileCount < 1000) throw new InvalidOperationException($"gameplay-jsons looks incomplete: only {fileCount:N0} files were found at {full}");
        return new GameplayJsonStatus(full, fileCount);
    }

    private void CopyGameplayJsonsDirectory(string source, string destination)
    {
        var fullSource = Path.GetFullPath(source);
        var fullDestination = Path.GetFullPath(destination);
        EnsurePathUnderAppRoot(fullDestination);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var temp = Path.Combine(appRoot, $".gameplay-jsons.install.{stamp}");
        var backup = Path.Combine(appRoot, $"gameplay-jsons.backup.{stamp}");
        try
        {
            CopyDirectoryRecursive(fullSource, temp);
            ValidateGameplayJsonsDirectory(temp);
            if (Directory.Exists(fullDestination)) Directory.Move(fullDestination, backup);
            Directory.Move(temp, fullDestination);
            ValidateGameplayJsonsDirectory(fullDestination);
            if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
        }
        catch
        {
            if (Directory.Exists(temp)) Directory.Delete(temp, recursive: true);
            if (!Directory.Exists(fullDestination) && Directory.Exists(backup)) Directory.Move(backup, fullDestination);
            throw;
        }
    }

    private void EnsurePathUnderAppRoot(string path)
    {
        var root = Path.GetFullPath(appRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Refusing to replace a folder outside the RevivalSide install directory: {path}");
        }
    }

    private static void CopyDirectoryRecursive(string source, string destination)
    {
        if (Directory.Exists(destination)) Directory.Delete(destination, recursive: true);
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private static int CountFiles(string directory)
    {
        var count = 0;
        foreach (var _ in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)) count++;
        return count;
    }

    private string GameplayJsonsDir() => Path.Combine(appRoot, "gameplay-jsons");

    private async Task BrowseManagedAssemblyAsync()
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null) return;
        var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select CounterSide Assembly-CSharp.dll",
            AllowMultiple = false,
            FileTypeFilter = new[]
            {
                new FilePickerFileType("Assembly-CSharp.dll") { Patterns = new[] { "Assembly-CSharp.dll" } },
                new FilePickerFileType("DLL files") { Patterns = new[] { "*.dll" } },
            },
        });
        var file = files.FirstOrDefault()?.TryGetLocalPath();
        if (string.IsNullOrWhiteSpace(file)) return;
        var normalized = NormalizeManagedDir(file);
        if (!IsManagedDir(normalized))
        {
            await ShowMessageAsync("RevivalSide", "That file is not CounterSide Data\\Managed\\Assembly-CSharp.dll.");
            return;
        }
        settings.CounterSideManagedDir = normalized;
        managedDirBox.Text = normalized;
        SaveSettings();
        AppendLog($"CounterSide DLL selected: {normalized}");
    }

    private async Task<bool> DetectManagedAssemblyAsync(bool showMessage)
    {
        var detected = FindCounterSideManagedDir();
        if (IsManagedDir(detected))
        {
            settings.CounterSideManagedDir = detected;
            managedDirBox.Text = detected;
            SaveSettings();
            AppendLog($"CounterSide DLL detected: {detected}");
            return true;
        }
        if (showMessage)
        {
            await ShowMessageAsync("RevivalSide", "CounterSide Data\\Managed\\Assembly-CSharp.dll was not found automatically. Click Browse and select it from the installed game folder.");
        }
        return false;
    }

    private LauncherSettings LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath))
            {
                var fresh = new LauncherSettings();
                ApplyDotEnvDefaults(fresh);
                return fresh;
            }
            var loaded = JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(settingsPath)) ?? new LauncherSettings();
            if (loaded.SettingsVersion < LauncherSettings.CurrentVersion) loaded.SettingsVersion = LauncherSettings.CurrentVersion;
            ApplyDotEnvDefaults(loaded);
            loaded.JoinLobbyAckMode = NormalizeJoinLobbyMode(loaded.JoinLobbyAckMode);
            return loaded;
        }
        catch
        {
            var fallback = new LauncherSettings();
            ApplyDotEnvDefaults(fallback);
            return fallback;
        }
    }

    private void ApplyDotEnvDefaults(LauncherSettings target)
    {
        var values = ReadDotEnvFile(Path.Combine(appRoot, ".env"));
        if (values.Count == 0) return;
        if (TryReadPort(values, "CS_PORT", out var gamePort)) target.GamePort = gamePort;
        if (TryReadPort(values, "CS_HTTP_MIRROR_PORT", out var httpPort)) target.HttpPort = httpPort;
        if (values.TryGetValue("CS_EVENT_DATE", out var eventDate)) target.EventDate = eventDate.Trim();
        if (values.TryGetValue("CS_USE_LOCAL_JOIN_LOBBY_ACK", out var joinLobbyMode)) target.JoinLobbyAckMode = NormalizeJoinLobbyMode(joinLobbyMode);
        target.UserManagerAllowRemote = ReadEnvBool(values, "CS_USER_MANAGER_ALLOW_REMOTE", target.UserManagerAllowRemote);
        target.VerboseCapture = ReadEnvBool(values, "CS_VERBOSE_CAPTURE", target.VerboseCapture);
        target.ReplayCapturedGameFlow = ReadEnvBool(values, "CS_REPLAY_CAPTURED_GAME_FLOW", target.ReplayCapturedGameFlow);
        target.SkipTutorialToWin = ReadEnvBool(values, "CS_SKIP_TUTORIAL_TO_WIN", target.SkipTutorialToWin);
        target.ResetTutorialOnLogin = ReadEnvBool(values, "CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN", target.ResetTutorialOnLogin);
    }

    private static Dictionary<string, string> ReadDotEnvFile(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return values;
        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.OrdinalIgnoreCase)) line = line[7..].TrimStart();
            var separator = line.IndexOf('=');
            if (separator <= 0) continue;
            var key = line[..separator].Trim();
            if (!Regex.IsMatch(key, "^[A-Za-z_][A-Za-z0-9_]*$")) continue;
            values[key] = UnquoteEnvValue(line[(separator + 1)..].Trim());
        }
        return values;
    }

    private static bool TryReadPort(IReadOnlyDictionary<string, string> values, string key, out int port)
    {
        port = 0;
        return values.TryGetValue(key, out var raw) && int.TryParse(raw, out port) && port >= 1 && port <= 65535;
    }

    private static bool ReadEnvBool(IReadOnlyDictionary<string, string> values, string key, bool fallback)
    {
        if (!values.TryGetValue(key, out var raw)) return fallback;
        return ParseEnvBool(raw, fallback);
    }

    private static bool ParseEnvBool(string raw, bool fallback)
    {
        var value = raw.Trim().ToLowerInvariant();
        return value switch
        {
            "1" or "true" or "on" or "yes" => true,
            "0" or "false" or "off" or "no" => false,
            _ => fallback,
        };
    }

    private static string NormalizeJoinLobbyMode(string? value)
    {
        var mode = (value ?? "auto").Trim().ToLowerInvariant();
        return mode switch
        {
            "1" or "true" or "on" or "local" => "on",
            "0" or "false" or "off" or "official" => "off",
            _ => "auto",
        };
    }

    private static void ApplyAdvancedEnvironment(Dictionary<string, string> env, string text)
    {
        foreach (var rawLine in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.OrdinalIgnoreCase)) line = line[7..].TrimStart();
            var separator = line.IndexOf('=');
            if (separator <= 0) throw new InvalidOperationException($"Invalid advanced env line: {rawLine}");
            var key = line[..separator].Trim();
            if (!Regex.IsMatch(key, "^[A-Za-z_][A-Za-z0-9_]*$")) throw new InvalidOperationException($"Invalid advanced env key: {key}");
            env[key] = UnquoteEnvValue(line[(separator + 1)..].Trim());
        }
    }

    private static string UnquoteEnvValue(string value)
    {
        if (value.Length >= 2 && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\''))) return value[1..^1];
        return value;
    }

    private void SaveSettings()
    {
        Directory.CreateDirectory(appRoot);
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine, Encoding.UTF8);
    }

    private string ResolveInitialManagedDir(string saved)
    {
        foreach (var candidate in new[]
        {
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_DIR"),
            saved,
            FindCounterSideManagedDir(),
        })
        {
            var normalized = NormalizeManagedDir(candidate);
            if (IsManagedDir(normalized)) return normalized;
        }
        return "";
    }

    private static bool IsManagedDir(string? directory) => !string.IsNullOrWhiteSpace(directory) && File.Exists(Path.Combine(directory, "Assembly-CSharp.dll"));

    private static string NormalizeManagedDir(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        try
        {
            var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim().Trim('"')).Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(full)) full = Path.GetFileName(full).Equals("Assembly-CSharp.dll", StringComparison.OrdinalIgnoreCase) ? Path.GetDirectoryName(full) ?? "" : Path.GetDirectoryName(full) ?? full;
            foreach (var candidate in new[] { full, Path.Combine(full, "Data", "Managed"), Path.Combine(full, "Managed") })
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
            var common = Path.Combine(library, "steamapps", "common");
            foreach (var known in new[] { "CounterSide", "CounterSide Global", "COUNTER SIDE" }) yield return Path.Combine(common, known);
            if (!Directory.Exists(common)) continue;
            IEnumerable<string> dirs;
            try
            {
                dirs = Directory.EnumerateDirectories(common).Where(dir => Path.GetFileName(dir).Replace(" ", "", StringComparison.OrdinalIgnoreCase).Contains("CounterSide", StringComparison.OrdinalIgnoreCase)).ToList();
            }
            catch
            {
                dirs = Array.Empty<string>();
            }
            foreach (var dir in dirs) yield return dir;
        }
    }

    private static IEnumerable<string> FindSteamLibraryRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var steamRoot in FindSteamInstallRoots())
        {
            AddDirectory(roots, steamRoot);
            var libraryFile = Path.Combine(steamRoot, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(libraryFile)) continue;
            string text;
            try { text = File.ReadAllText(libraryFile); } catch { continue; }
            foreach (Match match in Regex.Matches(text, "\"path\"\\s+\"([^\"]+)\"", RegexOptions.IgnoreCase)) AddDirectory(roots, UnescapeSteamPath(match.Groups[1].Value));
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
            @"C:\Steam", @"D:\Steam", @"E:\Steam",
        })
        {
            if (!string.IsNullOrWhiteSpace(candidate)) yield return UnescapeSteamPath(candidate);
        }
    }

    private static string ReadRegistryString(string keyName, string valueName)
    {
        if (!OperatingSystem.IsWindows()) return "";
        try { return Registry.GetValue(keyName, valueName, null) as string ?? ""; } catch { return ""; }
    }

    private static void AddDirectory(HashSet<string> roots, string value)
    {
        try
        {
            var full = Path.GetFullPath(UnescapeSteamPath(value));
            if (Directory.Exists(full)) roots.Add(full);
        }
        catch { }
    }

    private static string UnescapeSteamPath(string value) => Environment.ExpandEnvironmentVariables(StringValue(value).Trim().Trim('"')).Replace("\\\\", "\\").Replace('/', Path.DirectorySeparatorChar);

    private void UpdateButtons()
    {
        var listenerRunning = listenerProcess is { HasExited: false };
        startListenerButton.IsEnabled = !listenerRunning;
        stopListenerButton.IsEnabled = listenerRunning;
    }

    private string ServerTimeStatePath() => Path.Combine(appRoot, "server-data", "server-time.json");

    private static decimal ClampPort(int value, int fallback) => Math.Clamp(value <= 0 ? fallback : value, 1, 65535);

    private static bool SamePath(string left, string right)
    {
        var fullLeft = Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullRight = Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return fullLeft.Equals(fullRight, StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    private static (Bitmap? Image, string Name) LoadRandomCutsceneBackground(string appRoot)
    {
        var zipPath = Path.Combine(appRoot, "extracted-assets", "cutscene-bg-16x9.zip");
        if (File.Exists(zipPath))
        {
            try
            {
                using var zip = ZipFile.OpenRead(zipPath);
                var entries = zip.Entries.Where(entry => entry.Length > 100_000 && entry.FullName.EndsWith(".png", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (entries.Length > 0)
                {
                    var entry = entries[Random.Shared.Next(entries.Length)];
                    using var stream = entry.Open();
                    using var memory = new MemoryStream();
                    stream.CopyTo(memory);
                    memory.Position = 0;
                    return (new Bitmap(memory), Path.GetFileNameWithoutExtension(entry.FullName));
                }
            }
            catch
            {
                // Fall through to extracted folder lookup.
            }
        }

        foreach (var root in new[]
        {
            Path.Combine(appRoot, "extracted-assets", "cutscene-bg-16x9"),
            Path.Combine(appRoot, "extracted-assets", "all"),
            Path.Combine(appRoot, "decrypted-assets", "CounterSide"),
        })
        {
            try
            {
                if (!Directory.Exists(root)) continue;
                var files = Directory.EnumerateFiles(root, "*.png", SearchOption.AllDirectories).Where(IsCutsceneBackgroundPath).Take(2000).ToArray();
                if (files.Length == 0) continue;
                var file = files[Random.Shared.Next(files.Length)];
                using var stream = File.OpenRead(file);
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                memory.Position = 0;
                return (new Bitmap(memory), Path.GetFileNameWithoutExtension(file));
            }
            catch
            {
                // Keep the launcher usable even if an asset is unreadable.
            }
        }
        return (null, "");
    }

    private static bool IsCutsceneBackgroundPath(string path)
    {
        var normalized = path.Replace('\\', '/');
        return normalized.Contains("CutsceneBG16x9/", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("cutscen_bg", StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveAppRoot()
    {
        foreach (var seed in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var packagedRoot = ResolvePackagedPayloadAppRoot(seed);
            if (!string.IsNullOrWhiteSpace(packagedRoot)) return packagedRoot;

            var directory = new DirectoryInfo(seed);
            while (directory != null)
            {
                if (IsAppRoot(directory.FullName)) return directory.FullName;
                directory = directory.Parent;
            }
        }
        return AppContext.BaseDirectory;
    }

    private static string ResolvePackagedPayloadAppRoot(string seed)
    {
        var directory = new DirectoryInfo(seed);
        while (directory != null)
        {
            DirectoryInfo? payloadDirectory = null;
            if (directory.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase))
            {
                payloadDirectory = directory.Parent;
            }
            else if (directory.Parent?.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase) == true)
            {
                payloadDirectory = directory.Parent.Parent;
            }
            if (payloadDirectory != null)
            {
                var appRoot = Path.Combine(payloadDirectory.FullName, "app");
                if (IsAppRoot(appRoot)) return appRoot;
            }
            directory = directory.Parent;
        }
        return "";
    }

    private static bool IsAppRoot(string directory)
    {
        return File.Exists(Path.Combine(directory, "cs-listener.js")) && File.Exists(Path.Combine(directory, "package.json"));
    }

    private static string ResolveToolPath(string toolName, params string[] bundledRelativePaths)
    {
        foreach (var relativePath in bundledRelativePaths)
        {
            var bundledPath = Path.Combine(AppContext.BaseDirectory, relativePath);
            if (File.Exists(bundledPath)) return bundledPath;
            var rootPath = Path.Combine(ResolveAppRoot(), relativePath);
            if (File.Exists(rootPath)) return rootPath;
        }
        var pathTool = ResolveToolFromPath(toolName);
        if (!string.IsNullOrWhiteSpace(pathTool)) return pathTool;
        return toolName;
    }

    private static string ResolveToolFromPath(string toolName)
    {
        if (Path.IsPathFullyQualified(toolName) && File.Exists(toolName)) return toolName;
        var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
        var extensions = Path.HasExtension(toolName)
            ? new[] { "" }
            : (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            foreach (var extension in extensions)
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim('"'), toolName + extension);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // Ignore malformed PATH entries.
                }
            }
        }
        return "";
    }

    private static string DescribeExecutable(string fileName)
    {
        try { return File.Exists(fileName) ? $"{fileName} ({ReadPortableExecutableMachine(fileName)})" : fileName; }
        catch { return fileName; }
    }

    private static void EnsureCompatibleExecutable(string toolName, string fileName)
    {
        if (!OperatingSystem.IsWindows() || !toolName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return;
        if (!File.Exists(fileName) || !Path.IsPathFullyQualified(fileName)) return;
        var machine = ReadPortableExecutableMachine(fileName);
        var arch = RuntimeInformation.ProcessArchitecture;
        var compatible = machine switch
        {
            "x64" => arch is Architecture.X64 or Architecture.Arm64,
            "x86" => true,
            "arm64" => arch == Architecture.Arm64,
            _ => true,
        };
        if (!compatible) throw new InvalidOperationException($"{Path.GetFileName(fileName)} is {machine}, but this launcher is running as {arch}: {fileName}");
    }

    private static string ReadPortableExecutableMachine(string fileName)
    {
        using var stream = File.OpenRead(fileName);
        Span<byte> header = stackalloc byte[64];
        if (stream.Read(header) < 64 || header[0] != 'M' || header[1] != 'Z') return "unknown";
        stream.Position = BitConverter.ToInt32(header.Slice(0x3C, 4));
        Span<byte> pe = stackalloc byte[6];
        if (stream.Read(pe) < 6) return "unknown";
        var machine = BitConverter.ToUInt16(pe.Slice(4, 2));
        return machine switch
        {
            0x014c => "x86",
            0x8664 => "x64",
            0xaa64 => "arm64",
            _ => $"0x{machine:x}",
        };
    }

    private StreamWriter OpenProcessLog(string prefix, out string logPath)
    {
        Directory.CreateDirectory(LogsDir());
        logPath = Path.Combine(LogsDir(), $"{prefix}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        var writer = new StreamWriter(File.Open(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8)
        {
            AutoFlush = true,
        };
        writer.WriteLine($"# Started {DateTime.Now:O}");
        return writer;
    }

    private void AppendProcessLog(StreamWriter writer, string text)
    {
        lock (processLogLock)
        {
            try { writer.WriteLine($"[{DateTime.Now:O}] {text}"); } catch { }
        }
        AppendLog(text);
    }

    private void CloseProcessLog(StreamWriter writer)
    {
        lock (processLogLock)
        {
            try { writer.Dispose(); } catch { }
        }
    }

    private void OpenLogsDirectory()
    {
        Directory.CreateDirectory(LogsDir());
        Process.Start(new ProcessStartInfo { FileName = LogsDir(), UseShellExecute = true });
    }

    private string LogsDir() => Path.Combine(appRoot, "logs");

    private void AppendLog(string text)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var next = $"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}";
            logBox.Text = (logBox.Text ?? "") + next;
            logBox.CaretIndex = logBox.Text.Length;
        });
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        var ok = new Button { Content = "OK", MinWidth = 96, Height = 38, HorizontalAlignment = HorizontalAlignment.Right };
        StyleButton(ok, primary: true);
        var window = new Window
        {
            Title = title,
            Width = 460,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(17, 22, 30),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new StackPanel
                {
                    Spacing = 16,
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        ok,
                    },
                },
            },
        };
        ok.Click += (_, _) => window.Close();
        await window.ShowDialog(this);
    }

    private static IBrush Brush(byte r, byte g, byte b) => new SolidColorBrush(Color.FromRgb(r, g, b));
    private static IBrush HorizontalGradient(Color left, Color right) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 0, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(left, 0), new(right, 1) },
    };
    private static IBrush DiagonalGradient(Color start, Color end) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(start, 0), new(end, 1) },
    };
    private static IBrush VerticalGradient(Color top, Color bottom) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(top, 0), new(bottom, 1) },
    };
    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
    private static string StringValue(object? value) => value == null ? "" : Convert.ToString(value) ?? "";
}

internal sealed class LauncherSettings
{
    public const int CurrentVersion = 2;
    public int SettingsVersion { get; set; } = CurrentVersion;
    public int GamePort { get; set; } = 22000;
    public int HttpPort { get; set; } = 8088;
    public int WikiPort { get; set; } = 5174;
    public string CounterSideManagedDir { get; set; } = "";
    public string EventDate { get; set; } = "";
    public string JoinLobbyAckMode { get; set; } = "auto";
    public bool UserManagerAllowRemote { get; set; }
    public bool VerboseCapture { get; set; }
    public bool ReplayCapturedGameFlow { get; set; } = true;
    public bool SkipTutorialToWin { get; set; }
    public bool ResetTutorialOnLogin { get; set; }
    public string AdvancedEnvText { get; set; } = "";
}

internal sealed class ProcessJob : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private IntPtr handle;

    private ProcessJob(IntPtr handle) => this.handle = handle;

    public static ProcessJob? TryCreateKillOnClose()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return null;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
        };
        var length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, pointer, fDeleteOld: false);
            if (!SetInformationJobObject(handle, JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation, pointer, (uint)length))
            {
                CloseHandle(handle);
                return null;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return new ProcessJob(handle);
    }

    public void Assign(Process process)
    {
        if (handle == IntPtr.Zero) return;
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            throw new InvalidOperationException($"AssignProcessToJobObject failed with Win32 error {Marshal.GetLastWin32Error()}.");
        }
    }

    public void Dispose()
    {
        var current = Interlocked.Exchange(ref handle, IntPtr.Zero);
        if (current != IntPtr.Zero) CloseHandle(current);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, JOBOBJECTINFOCLASS jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private enum JOBOBJECTINFOCLASS
    {
        JobObjectExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}

internal static class StringExtensions
{
    public static IEnumerable<string> SplitLines(this string value) => value.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
}

internal sealed record ListenCommand(ProcessStartInfo StartInfo, string Display);
internal sealed record GameplayJsonStatus(string Path, int FileCount);
