# XClearp

[![CI](https://github.com/vpen66/xclearp/actions/workflows/ci.yml/badge.svg)](https://github.com/vpen66/xclearp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

XClearp 是一款**企业级跨平台系统清理与磁盘分析工具**，基于 **Tauri 2.0** 与 **Rust** 构建，前端使用 **React + TypeScript + Vite + TailwindCSS**。

支持 Windows (x86_64), macOS (Intel/Apple Silicon), 以及 Linux (x86_64) 三大主流平台。

---

## 🚀 核心特性

- 🔍 **高效扫描与清理**：基于 Rust 编写的高性能文件扫描与清理引擎，支持多线程安全操作与自定义清理规则。
- 📊 **可视化磁盘分析**：直观展示磁盘文件占用分布，流式载入大文件夹，轻松找出占用空间的大文件。
- ⚙️ **灵活的规则编辑器**：支持内置与自定义规则组导入导出，灵活控制清理范围。
- 🛡️ **安全白名单管理**：支持全局、规则组或特定规则的文件/目录排除，杜绝误删风险。
- 🖥️ **现代感极佳的 UI/UX**：响应式布局、精致的暗色模式、平滑的微动画和优秀的交互体验。
- 🤖 **工业级 CI/CD**：全套自动化 GitHub Actions 工作流，支持自动多平台构建、签名、公证及 Release 发布。

---

## 🛠️ 技术栈

| 层级 | 技术/框架 | 备注 |
|---|---|---|
| **桌面框架** | Tauri 2.0 | `@tauri-apps/api@^2.0.0` |
| **前端核心** | React 18 + TypeScript 5 | 严格模式编译 |
| **构建工具** | Vite 5 | 极速热更新 |
| **样式方案** | TailwindCSS 3 | PostCSS + Autoprefixer |
| **后端语言** | Rust (Edition 2021) | 稳定版工具链 |
| **包管理器** | pnpm 11.9+ | **要求 Node.js ≥ 22.13** |

---

## 📂 项目结构

```
xclearp/
├── src/                          # 前端 React 源码
│   ├── components/               # UI 组件 (扫描视图、磁盘分析、规则编辑等)
│   ├── hooks/                    # 状态与事件流监听 Hooks (IPC 事件流订阅)
│   ├── lib/                      # 工具库 (Tauri IPC 包装层、NDJSON 解析)
│   └── types/                    # TypeScript 类型声明
├── src-tauri/                    # Rust 后端源码
│   ├── src/
│   │   ├── commands/             # Tauri IPC 暴露的命令
│   │   ├── core/                 # 核心引擎 (扫描器、清理器、去重、白名单)
│   │   └── platform/             # 平台抽象层 (Windows/macOS/Linux 特有实现)
│   ├── capabilities/             # Tauri 2.0 安全权限配置
│   └── rules/                    # 默认内置清理规则定义 (JSON)
└── .github/                      # CI/CD 工作流定义与 Composite Actions
```

---

## 💻 本地开发指南

### 1. 环境准备

- **Node.js**：建议安装 `v22.13.0` 或更高版本。
- **Rust**：确保已安装 `rustup` 及最新 Stable 工具链。
- **pnpm**：通过 `npm i -g pnpm` 安装。

#### 平台特定系统依赖 (Tauri 编译所需)

**Linux (Ubuntu/Debian)**:
```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  libxdo-dev
```

**macOS**:
安装 Xcode Command Line Tools:
```bash
xcode-select --install
```

**Windows**:
确保已安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。

### 2. 启动开发模式

安装前端依赖：
```bash
pnpm install
```

启动 Tauri 实时预览开发服务器：
```bash
pnpm tauri dev
```

---

## 📦 生产环境打包

为当前操作系统生成生产环境打包产物（安装包）：

```bash
pnpm tauri build
```

打包产物将位于 `src-tauri/target/release/bundle/` 目录下。

---

## 🤖 CI/CD 与自动化发布

项目包含完整的企业级 GitHub Actions 配置：

- **CI 工作流** (`ci.yml`)：在推送或 PR 到 `master`/`develop` 分支时运行，执行 Rust 格式化、Clippy 静态检查、单元测试、TypeScript 类型检查和前端打包验证。
- **Release 工作流** (`release.yml`)：当向 GitHub 推送版本 Tag（如 `v1.0.0`）时，自动创建一个 Draft Release，并跨平台并行编译 Windows、macOS（Intel + Silicon）、Linux 的安装包，生成 Release Note，最后自动发布。
- **Nightly 工作流** (`nightly.yml`)：每日定时构建多平台最新工件，上传为 Artifact，便于测试与提前发现兼容问题。
- **CodeQL 安全扫描** (`codeql.yml`)：每周自动扫描前端代码的潜在安全漏洞。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。
