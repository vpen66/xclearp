#!/usr/bin/env bash
set -euo pipefail

echo "🔍 Running pre-build checks..."

# Navigate to project root
cd "$(dirname "$0")/.."

# Step 1: Cargo format check
echo "📐 Checking Rust formatting..."
cd src-tauri
cargo fmt --all -- --check
echo "✅ Formatting OK"

# Step 2: Clippy lint check
echo "🔧 Running clippy..."
cargo clippy --all-targets --all-features -- -D warnings
echo "✅ Clippy OK"

echo "🎉 All pre-build checks passed!"
