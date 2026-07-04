#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod core;
mod platform;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use commands::{clean, disk, orphan, rules, scan, startup, uninstall};
use core::engine::CleanEngine;
use core::event_bus::{EventBus, UninstallEventBus};
use core::uninstall::engine::UninstallEngine;
use platform::create_platform_provider;

#[tauri::command]
fn relaunch(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

fn main() {
    // Create a Tokio runtime and enter its context so that tokio-dependent APIs
    // (e.g. tokio::sync::mpsc channels) work inside the synchronous `setup` closure.
    let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = runtime.enter();

    // Tell tauri::async_runtime to use this runtime instead of creating its own.
    // This avoids a potential "no reactor running" panic if tauri's lazy init
    // hasn't completed when setup runs.
    tauri::async_runtime::set(runtime.handle().clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Create EventBus and get the receiver for event forwarding
            let (event_bus, mut rx) = EventBus::new();
            let event_bus = Arc::new(event_bus);
            let whitelist = Arc::new(std::sync::RwLock::new(core::whitelist::load_whitelist()));
            let platform: Arc<dyn platform::PlatformProvider + Send + Sync> =
                Arc::from(create_platform_provider());

            // Create CleanEngine and register as managed state
            let engine = CleanEngine::new(Arc::clone(&event_bus), whitelist, Arc::clone(&platform));
            app.manage(engine);
            app.manage(disk::DiskAnalysisState::default());

            // Create UninstallEventBus and UninstallEngine
            let (uninstall_event_bus, mut uninstall_rx) = UninstallEventBus::new();
            let uninstall_event_bus = Arc::new(uninstall_event_bus);
            let uninstall_engine =
                UninstallEngine::new(Arc::clone(&uninstall_event_bus), Arc::clone(&platform));
            app.manage(uninstall_engine);

            // Spawn background task to forward events to the frontend via Tauri emit
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    app_handle.emit("clean-event", &event).ok();
                }
            });

            // Spawn background task to forward uninstall events to the frontend
            let app_handle_uninstall = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = uninstall_rx.recv().await {
                    app_handle_uninstall.emit("uninstall-event", &event).ok();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan::start_scan,
            scan::cancel_operation,
            clean::start_clean,
            rules::get_groups,
            rules::get_rules,
            rules::update_rule,
            rules::add_custom_rule,
            rules::import_rules,
            rules::add_group,
            rules::delete_group,
            rules::get_whitelist,
            rules::update_whitelist,
            rules::delete_rule,
            disk::list_directory,
            disk::get_disk_usage,
            disk::start_disk_analysis,
            disk::delete_path,
            disk::clear_disk_analysis_cache,
            disk::open_path,
            disk::get_platform,
            disk::check_disk_permissions,
            disk::open_system_settings_pane,
            uninstall::list_apps,
            uninstall::scan_app,
            uninstall::uninstall_app,
            uninstall::cancel_uninstall,
            uninstall::retry_failed_items,
            uninstall::get_icon_data_urls,
            uninstall::batch_uninstall,
            uninstall::get_failed_uninstalls,
            uninstall::clear_failed_uninstalls,
            uninstall::get_uninstall_state,
            orphan::quick_scan_orphan_files,
            orphan::calculate_orphan_stats,
            orphan::scan_orphan_files,
            orphan::delete_orphan_files,
            startup::list_startup_items,
            startup::toggle_startup_item,
            startup::remove_startup_item,
            relaunch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
