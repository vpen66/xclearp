pub mod app_scanner;
pub mod engine;

use serde::{Deserialize, Serialize};

/// An installed application discovered on the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// Display name of the application.
    pub name: String,
    /// Bundle identifier (e.g. com.apple.Safari). Empty on non-macOS.
    pub bundle_id: String,
    /// Application version string.
    pub version: String,
    /// Path to the .app bundle or main executable.
    pub app_path: String,
    /// Application icon path (if available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_path: Option<String>,
    /// Approximate size of the app bundle in bytes.
    pub app_size: u64,
    /// Windows: UninstallString from registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uninstall_string: Option<String>,
    /// Windows: InstallLocation from registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_location: Option<String>,
    /// Windows: Publisher from registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// Linux: package manager type ("apt", "dnf", "pacman", "flatpak", "snap").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<String>,
    /// Linux: package name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
}

/// Category of residual files associated with an app.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppFileCategory {
    Cache,
    Preferences,
    ApplicationSupport,
    Logs,
    SavedState,
    Containers,
    WebKit,
    HttpStorages,
    LaunchAgents,
    LaunchDaemons,
    Registry,
    UserData,
    ProgramData,
    LocalAppData,
    StartMenu,
    Desktop,
    XdgData,
    XdgState,
    Other,
}

impl AppFileCategory {
    pub fn display_name(&self) -> &str {
        match self {
            AppFileCategory::Cache => "缓存",
            AppFileCategory::Preferences => "偏好设置",
            AppFileCategory::ApplicationSupport => "应用支持",
            AppFileCategory::Logs => "日志",
            AppFileCategory::SavedState => "保存状态",
            AppFileCategory::Containers => "容器",
            AppFileCategory::WebKit => "WebKit 数据",
            AppFileCategory::HttpStorages => "HTTP 存储",
            AppFileCategory::LaunchAgents => "启动代理",
            AppFileCategory::LaunchDaemons => "启动守护",
            AppFileCategory::Registry => "注册表",
            AppFileCategory::UserData => "用户数据",
            AppFileCategory::ProgramData => "程序数据",
            AppFileCategory::LocalAppData => "本地应用数据",
            AppFileCategory::StartMenu => "开始菜单",
            AppFileCategory::Desktop => "桌面快捷方式",
            AppFileCategory::XdgData => "XDG 数据",
            AppFileCategory::XdgState => "XDG 状态",
            AppFileCategory::Other => "其他",
        }
    }

    pub fn risk_hint(&self) -> &str {
        match self {
            AppFileCategory::Cache => "安全删除，应用会自动重建",
            AppFileCategory::Preferences => "删除后应用设置将丢失",
            AppFileCategory::ApplicationSupport => "可能包含重要用户数据",
            AppFileCategory::Logs => "安全删除",
            AppFileCategory::SavedState => "安全删除，窗口状态将丢失",
            AppFileCategory::Containers => "包含应用沙盒数据",
            AppFileCategory::WebKit => "包含浏览器引擎数据",
            AppFileCategory::HttpStorages => "包含网络请求缓存",
            AppFileCategory::LaunchAgents => "删除后自动启动将失效",
            AppFileCategory::LaunchDaemons => "删除后系统服务将失效",
            AppFileCategory::Registry => "删除注册表键可能影响系统稳定性",
            AppFileCategory::UserData => "包含用户配置和漫游数据",
            AppFileCategory::ProgramData => "包含共享程序数据",
            AppFileCategory::LocalAppData => "包含本地缓存和应用数据",
            AppFileCategory::StartMenu => "安全删除，快捷方式将消失",
            AppFileCategory::Desktop => "安全删除，桌面快捷方式将消失",
            AppFileCategory::XdgData => "包含应用共享数据文件",
            AppFileCategory::XdgState => "包含应用状态信息",
            AppFileCategory::Other => "请确认后再删除",
        }
    }
}

/// A single residual file entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFileEntry {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

/// A group of residual files belonging to one category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFileGroup {
    pub category: AppFileCategory,
    pub category_name: String,
    pub risk_hint: String,
    pub files: Vec<AppFileEntry>,
    pub total_size: u64,
    pub file_count: u64,
}

/// Uninstall mode selected by the user in the confirmation dialog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallMode {
    /// Move the app to trash only (macOS default).
    TrashOnly,
    /// Invoke the official uninstaller then scan residuals (Windows default).
    OfficialUninstaller,
    /// Only delete residual files, do not uninstall the app itself.
    ResidualOnly,
}
