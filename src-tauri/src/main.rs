#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod core;
mod platform;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use commands::{clean, disk, rules, scan};
use core::engine::CleanEngine;
use core::event_bus::EventBus;
use platform::create_platform_provider;

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
        .setup(|app| {
            // Create EventBus and get the receiver for event forwarding
            let (event_bus, mut rx) = EventBus::new();
            let event_bus = Arc::new(event_bus);
            let whitelist = Arc::new(std::sync::RwLock::new(core::whitelist::load_whitelist()));
            let platform: Arc<dyn platform::PlatformProvider + Send + Sync> =
                Arc::from(create_platform_provider());

            // Create CleanEngine and register as managed state
            let engine = CleanEngine::new(
                Arc::clone(&event_bus),
                whitelist,
                platform,
            );
            app.manage(engine);
            app.manage(disk::DiskAnalysisState::default());

            // Spawn background task to forward events to the frontend via Tauri emit
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    app_handle.emit("clean-event", &event).ok();
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
            disk::list_directory,
            disk::get_disk_usage,
            disk::start_disk_analysis,
            disk::delete_path,
            disk::clear_disk_analysis_cache,
            disk::open_path,
            disk::get_platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
