# XClearp

[![CI](https://github.com/vpen66/xclearp/actions/workflows/ci.yml/badge.svg)](https://github.com/vpen66/xclearp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[中文](README.md) | English

XClearp is an **enterprise-grade cross-platform system cleaning and disk analysis tool**, built with **Tauri 2.0** and **Rust**, featuring a modern frontend powered by **React + TypeScript + Vite + TailwindCSS**.

Supports Windows (x86_64), macOS (Intel/Apple Silicon), and Linux (x86_64).

---

## 🚀 Core Features

- 🔍 **High-Performance Scanning & Cleaning**: Rust-powered file scanning and cleaning engine with multi-threaded safe operations and customizable cleaning rules.
- 📊 **Visual Disk Analysis**: Intuitive display of disk file usage distribution, streaming loading of large folders, easily find space-consuming files.
- ⚙️ **Flexible Rule Editor**: Support for built-in and custom rule group import/export, flexible control of cleaning scope.
- 🛡️ **Safe Whitelist Management**: Support for global, rule group, or specific rule file/directory exclusions to prevent accidental deletion.
- 🖥️ **Modern UI/UX**: Responsive layout, refined dark mode, smooth micro-animations, and excellent interaction experience.
- 🌐 **Multi-Language Support**: Built-in Chinese and English interface languages, easily switchable in settings.
- 🤖 **Industrial-Grade CI/CD**: Complete automated GitHub Actions workflow supporting automatic multi-platform builds, signing, notarization, and Release publishing.

---

## 🛠️ Tech Stack

| Layer | Technology/Framework | Notes |
|---|---|---|
| **Desktop Framework** | Tauri 2.0 | `@tauri-apps/api@^2.0.0` |
| **Frontend Core** | React 18 + TypeScript 5 | Strict mode compilation |
| **Build Tool** | Vite 5 | Lightning-fast hot reload |
| **Styling** | TailwindCSS 3 | PostCSS + Autoprefixer |
| **Backend Language** | Rust (Edition 2021) | Stable toolchain |
| **Package Manager** | pnpm 11.9+ | **Requires Node.js ≥ 22.13** |

---

## 📂 Project Structure

```
xclearp/
├── src/                          # Frontend React source code
│   ├── components/               # UI components (ScanView, DiskAnalysis, RuleEditor, etc.)
│   ├── hooks/                    # State and event stream hooks (IPC event stream subscriptions)
│   ├── lib/                      # Utility library (Tauri IPC wrapper, NDJSON parser, i18n)
│   ├── locales/                  # Translation files (zh.json, en.json)
│   └── types/                    # TypeScript type declarations
├── src-tauri/                    # Rust backend source code
│   ├── src/
│   │   ├── commands/             # Tauri IPC exposed commands
│   │   ├── core/                 # Core engine (scanner, cleaner, dedup, whitelist)
│   │   └── platform/             # Platform abstraction layer (Windows/macOS/Linux implementations)
│   ├── capabilities/             # Tauri 2.0 security permission configuration
│   └── rules/                    # Default built-in cleaning rule definitions (JSON)
└── .github/                      # CI/CD workflow definitions and Composite Actions
```

---

## 💻 Local Development Guide

### 1. Environment Setup

- **Node.js**: Recommend installing `v22.13.0` or higher.
- **Rust**: Ensure `rustup` and latest Stable toolchain are installed.
- **pnpm**: Install via `npm i -g pnpm`.

#### Platform-Specific System Dependencies (Required for Tauri compilation)

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
Install Xcode Command Line Tools:
```bash
xcode-select --install
```

**Windows**:
Ensure [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) are installed.

### 2. Start Development Mode

Install frontend dependencies:
```bash
pnpm install
```

Start Tauri live preview development server:
```bash
pnpm tauri dev
```

---

## 📦 Production Build

Generate production build (installer) for current operating system:

```bash
pnpm tauri build
```

Build artifacts will be located in `src-tauri/target/release/bundle/` directory.

---

## 📝 Development and Code Standards

To ensure smooth CI/CD process, strictly follow these quality and Clippy standards when writing Rust backend code:

- ⚠️ **Unused Code Handling**: In binary Crate, if defining uncommitted or reserved `pub` methods, structs, or traits, explicitly add `#[allow(dead_code)]`.
- ⚡ **Sorting Standards**: For descending sort, recommend using `entries.sort_by_key(|b| std::cmp::Reverse(b.size))` instead of `entries.sort_by(|a, b| b.size.cmp(&a.size))`.
- 🔢 **Divisibility Check**: Use `.is_multiple_of(10)` instead of `entries_count % 10 == 0` for divisibility checking.
- 📂 **Folder Flattening Iteration**: When iterating over `fs::read_dir` results, use `for entry in entries.flatten()` instead of nested `if let Ok` validation.
- ✂️ **Prefix Removal**: Use `.strip_prefix('~')` instead of manual slicing (e.g., `&pattern[1..]`) to safely remove string prefixes.
- 🚫 **Eliminate Unit Binding**: For methods returning `()` (unit type) (e.g., `walker.skip_current_dir()`), call directly without using `let _ = ...` to capture.

---

## 🤖 CI/CD and Automated Release

Project includes complete enterprise-grade GitHub Actions configuration:

- **CI Workflow** (`ci.yml`): Runs on push or PR to `master`/`develop` branches, executes Rust formatting, Clippy static checks, unit tests, TypeScript type checks, and frontend build verification.
- **Release Workflow** (`release.yml`): When pushing version Tag (e.g., `v1.0.0`) to GitHub, automatically creates a Draft Release, cross-platform parallel compilation of Windows, macOS (Intel + Silicon), Linux installers, generates Release Notes, and auto-publishes.
- **Nightly Workflow** (`nightly.yml`): Daily scheduled builds of latest multi-platform artifacts, uploaded as Artifacts for testing and early compatibility issue detection.
- **CodeQL Security Scan** (`codeql.yml`): Weekly automatic scan of frontend code for potential security vulnerabilities.

---

## 🌐 Multi-Language Support

XClearp supports Chinese and English interface languages:

1. **Language Selection**: In Settings → General → Interface Language, choose your preferred language
2. **Automatic Detection**: On first launch, automatically selects language based on system locale (English for English systems, Chinese for others)
3. **Adding New Languages**: Add new translation files in `src/locales/` (e.g., `ja.json`) and update `src/lib/i18n.tsx`

---

## 📄 License

This project is open-sourced under [MIT License](LICENSE).
