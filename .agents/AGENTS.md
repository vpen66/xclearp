# XClearp — AI Agent 项目指南

## 项目概述

XClearp 是一个**跨平台系统清理工具**，基于 **Tauri 2.0** 构建。前端使用 React + TypeScript + Vite + TailwindCSS，后端使用 Rust。支持 Windows、macOS、Linux 三大平台。

---

## 技术栈

| 层 | 技术 | 版本要求 |
|---|------|---------|
| 前端框架 | React 18 + TypeScript 5 | strict mode |
| 构建工具 | Vite 5 | ES2021 target |
| 样式 | TailwindCSS 3 | PostCSS + Autoprefixer |
| 桌面框架 | Tauri 2.0 | `@tauri-apps/api@^2.0.0` |
| 后端语言 | Rust (Edition 2021) | stable toolchain |
| 包管理器 | pnpm 11.9+ | **要求 Node.js ≥ 22.13** |
| CI/CD | GitHub Actions | 见 `.github/workflows/` |

---

## 项目结构

```
xclearp/
├── src/                          # 前端源码 (React + TypeScript)
│   ├── components/               # UI 组件
│   │   ├── ScanView.tsx          # 扫描主界面
│   │   ├── DiskAnalysis.tsx      # 磁盘分析
│   │   ├── SettingsView.tsx      # 设置页面
│   │   ├── RuleEditor.tsx        # 规则编辑器
│   │   ├── WhitelistManager.tsx  # 白名单管理
│   │   ├── CleanProgress.tsx     # 清理进度
│   │   ├── Sidebar.tsx           # 侧边栏导航
│   │   ├── Tooltip.tsx           # 提示组件
│   │   └── Icons.tsx             # 图标组件 (Lucide)
│   ├── hooks/                    # React Hooks
│   │   ├── useScanStream.ts      # 扫描事件流
│   │   ├── useCleanStream.ts     # 清理事件流
│   │   ├── useDiskAnalysis.ts    # 磁盘分析
│   │   └── useGroups.ts          # 规则组管理
│   ├── lib/                      # 工具库
│   │   ├── ipc.ts                # Tauri IPC 封装（所有后端通信）
│   │   └── ndjson.ts             # NDJSON 解析
│   ├── types/                    # TypeScript 类型定义
│   │   ├── index.ts              # 统一导出
│   │   ├── events.ts             # 事件类型
│   │   ├── rules.ts              # 规则类型
│   │   ├── groups.ts             # 分组类型
│   │   └── disk.ts               # 磁盘类型
│   ├── App.tsx                   # 应用根组件
│   ├── main.tsx                  # 入口点
│   └── index.css                 # 全局样式
├── src-tauri/                    # Rust 后端 (Tauri)
│   ├── src/
│   │   ├── main.rs               # 程序入口，Tauri Builder 配置
│   │   ├── config.rs             # 配置模块
│   │   ├── commands/             # Tauri 命令（IPC 端点）
│   │   │   ├── scan.rs           # 扫描命令
│   │   │   ├── clean.rs          # 清理命令
│   │   │   ├── rules.rs          # 规则管理命令
│   │   │   └── disk.rs           # 磁盘分析命令
│   │   ├── core/                 # 核心业务逻辑
│   │   │   ├── engine.rs         # 清理引擎（协调扫描和清理）
│   │   │   ├── scanner.rs        # 文件扫描器
│   │   │   ├── cleaner.rs        # 文件清理器
│   │   │   ├── rules.rs          # 规则系统
│   │   │   ├── events.rs         # 事件定义（CleanEvent, DiskEvent）
│   │   │   ├── event_bus.rs      # 事件总线（tokio mpsc）
│   │   │   ├── dedup.rs          # 去重逻辑
│   │   │   └── whitelist.rs      # 白名单管理
│   │   └── platform/             # 平台抽象层
│   │       ├── mod.rs            # PlatformProvider trait + 工厂函数
│   │       ├── common.rs         # 跨平台公共实现
│   │       ├── macos.rs          # macOS 特定实现
│   │       ├── linux.rs          # Linux 特定实现
│   │       └── windows.rs        # Windows 特定实现
│   ├── rules/                    # 清理规则定义（JSON）
│   ├── capabilities/             # Tauri 安全权限
│   ├── icons/                    # 应用图标
│   ├── Cargo.toml                # Rust 依赖
│   ├── Cargo.lock                # Rust 依赖锁定
│   ├── tauri.conf.json           # Tauri 配置
│   └── build.rs                  # Rust 构建脚本
├── .github/                      # CI/CD
│   ├── actions/setup-project/    # Composite Action
│   └── workflows/                # CI, Release, Nightly, CodeQL
├── package.json                  # 前端依赖
├── pnpm-lock.yaml                # pnpm 锁文件
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 配置
├── tailwind.config.js            # TailwindCSS 配置
└── postcss.config.js             # PostCSS 配置
```

---

## 架构要点

### 前后端通信

前端通过 `src/lib/ipc.ts` 与 Rust 后端通信，使用 Tauri 2.0 的 `invoke` API 调用 Rust 命令。后端通过 Tauri 的 `emit` API 向前端推送事件流（扫描进度、清理进度等）。

```
Frontend (React)  ←→  ipc.ts (invoke/listen)  ←→  Tauri IPC  ←→  commands/*.rs  ←→  core/*.rs
```

### 事件流

- 后端 `CleanEvent` 通过 `EventBus`（tokio mpsc）发送，由 `main.rs` 中的后台任务转发为 Tauri 事件 `"clean-event"`
- 后端 `DiskEvent` 通过 Tauri 事件 `"disk-event"` 发送
- 前端 `useScanStream` 和 `useCleanStream` hooks 监听这些事件

### 平台抽象

`platform/mod.rs` 定义了 `PlatformProvider` trait，各平台（macOS/Linux/Windows）各自实现。通过 `create_platform_provider()` 工厂函数在运行时选择正确的实现。

---

## 开发规范

### Rust 代码

1. **格式化**：提交前必须运行 `cargo fmt --all`（CI 会检查）
2. **Clippy**：代码必须通过 `cargo clippy --all-targets --all-features -- -D warnings`
3. **工作目录**：所有 cargo 命令在 `src-tauri/` 目录下执行
4. **平台特定代码**：放在 `src-tauri/src/platform/` 下对应文件中，通过 `PlatformProvider` trait 抽象
5. **新增 Tauri 命令**：
   - 在 `src-tauri/src/commands/` 下添加函数
   - 在 `main.rs` 的 `invoke_handler` 中注册
   - 在 `src-tauri/capabilities/default.json` 的 `permissions` 中添加 `allow-<command-name>`
   - 在 `src/lib/ipc.ts` 中添加对应的前端 IPC 函数
6. **错误处理**：平台操作使用 `PlatformError`，命令返回 `Result<T, String>`
7. **异步运行时**：项目使用自定义 Tokio runtime（在 `main.rs` 中创建），不要使用 `#[tokio::main]`
8. **代码质量与 Clippy 规范**：
   - **未使用的公共 API/特征方法**：在二进制 Crate 中，未被调用的 `pub` 函数/特征方法，或仅占位使用的 trait/enum 需显式标记 `#[allow(dead_code)]` 以防编译报错。
   - **排序优化**：优先使用 `entries.sort_by_key(|b| std::cmp::Reverse(b.size))` 进行降序排序，而非手写闭包 cmp。
   - **整除判断**：使用 `.is_multiple_of(N)` 替代 `count % N == 0`。
   - **文件迭代器**：对 `fs::read_dir` 等 Result 迭代器直接使用 `.flatten()` 消除嵌套的 `if let Ok(entry)`。
   - **路径与字符串处理**：移除前缀或后缀时，使用 `.strip_prefix('~')` 等标准 API 替代手动切片（如 `&pattern[1..]`）。
   - **消除无意义的 Unit 绑定**：对于返回 `()` 类型的函数（如 `skip_current_dir()`），不要使用 `let _ = ...;` 进行显式忽略绑定，直接调用即可。


### TypeScript 代码

1. **严格模式**：`tsconfig.json` 启用了 `strict: true`、`noUnusedLocals`、`noUnusedParameters`
2. **类型定义**：所有类型放在 `src/types/` 下，通过 `src/types/index.ts` 统一导出
3. **IPC 调用**：所有后端通信必须通过 `src/lib/ipc.ts`，不要直接调用 `invoke`
4. **状态管理**：使用 React hooks，不使用外部状态管理库
5. **图标**：使用 `lucide-react`，自定义图标放在 `Icons.tsx`

### 通用规范

1. **版本号一致**：修改版本时需同步更新三处：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
2. **不要修改 `pnpm-lock.yaml` 和 `Cargo.lock`**：这些由工具自动管理
3. **敏感信息**：不允许硬编码任何密钥、证书等。CI/CD 中使用 GitHub Secrets
4. **注释语言**：代码注释使用英文

---

## CI/CD 说明

项目使用 GitHub Actions，workflow 文件在 `.github/workflows/`：

| Workflow | 触发条件 | 职责 |
|----------|---------|------|
| `ci.yml` | Push/PR 到 `master`/`develop` | 代码质量检查（fmt, clippy, test, tsc, vite build） |
| `release.yml` | Push `v*` tag | 多平台构建 + GitHub Release 发布 |
| `nightly.yml` | 每天 UTC 02:00 + 手动 | 每日多平台构建（上传为 Artifact） |
| `codeql.yml` | Push/PR 到 `master` + 每周一 | JavaScript/TypeScript 安全扫描 |

### 发布流程

```bash
# 1. 确保在 master 分支
# 2. 同步更新三处版本号
# 3. git tag v<version> && git push origin v<version>
# Release workflow 自动构建 4 个平台并发布
```

### 修改 CI 注意事项

- **环境初始化**集中在 `.github/actions/setup-project/action.yml`，修改工具链版本只需改这一处
- **Node.js 版本必须 ≥ 22.13**（pnpm 11.9 要求）
- **主分支是 `master`**，不是 `main`
- **pnpm 版本**由 `package.json` 的 `packageManager` 字段控制，CI 自动读取

---

## 构建与运行

### 开发模式

```bash
pnpm install
pnpm tauri dev
```

### 生产构建

```bash
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 前端单独构建

```bash
pnpm build    # 等同于 tsc && vite build
```

---

## 常见陷阱

1. **Tauri 命令注册**：新增命令后忘记在 `capabilities/default.json` 中添加权限，会导致运行时报 "permission denied"
2. **平台条件编译**：`platform/` 下所有模块都会编译（非条件编译），但 `create_platform_provider()` 使用 `cfg!()` 宏选择运行时实现。如果某平台模块有仅限该平台的系统调用，需要用 `#[cfg(target_os = "...")]` 包裹
3. **macOS 特有依赖**：`objc2` 和 `objc2-foundation` 仅在 macOS 目标下编译（`Cargo.toml` 中用 `[target.'cfg(target_os = "macos")'.dependencies]` 控制）
4. **事件序列化**：`CleanEvent` 使用 `#[serde(tag = "type")]`，前端需要通过 `type` 字段区分事件类型
5. **JSON 规则文件**：清理规则定义在 `src-tauri/rules/*.json`，是应用内置规则的来源
