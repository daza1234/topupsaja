mod ipc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ipc::fs_read_file,
            ipc::fs_read_text,
            ipc::fs_write_file,
            ipc::fs_stat,
            ipc::fs_readdir,
            ipc::fs_mkdir,
            ipc::fs_exists,
            ipc::fs_unlink,
            ipc::fs_chmod,
            ipc::exec_spawn,
            ipc::exec_kill,
            ipc::exec_write,
            ipc::keyring_get,
            ipc::keyring_set,
            ipc::keyring_delete,
            ipc::oauth_start,
            ipc::os_homedir,
            ipc::os_cwd,
            ipc::os_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
