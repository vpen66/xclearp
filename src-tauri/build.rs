fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "windows" {
        let has_rc = std::process::Command::new("llvm-rc")
            .arg("--version")
            .output()
            .is_ok()
            || std::process::Command::new("rc.exe")
                .arg("/?")
                .output()
                .is_ok();

        if !has_rc {
            // Create a mock llvm-rc script to prevent tauri-winres from panicking
            let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
            let mock_dir = std::path::PathBuf::from(out_dir).join("mock_bin");
            std::fs::create_dir_all(&mock_dir).ok();

            let mock_rc_path = mock_dir.join("llvm-rc");
            let mock_script = r#"#!/bin/bash
# Mock llvm-rc to succeed during cross-compilation check
while [[ $# -gt 0 ]]; do
  case "$1" in
    /fo|-o|--output)
      shift
      touch "$1"
      ;;
    *)
      shift
      ;;
  esac
done
exit 0
"#;
            std::fs::write(&mock_rc_path, mock_script).ok();

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&mock_rc_path) {
                    let mut perms = metadata.permissions();
                    perms.set_mode(0o755);
                    std::fs::set_permissions(&mock_rc_path, perms).ok();
                }
            }

            // Prepend mock_dir to PATH
            if let Some(path) = std::env::var_os("PATH") {
                let mut paths = std::env::split_paths(&path).collect::<Vec<_>>();
                paths.insert(0, mock_dir);
                if let Ok(new_path) = std::env::join_paths(paths) {
                    std::env::set_var("PATH", new_path);
                }
            }
        }
    }

    tauri_build::build();
}
