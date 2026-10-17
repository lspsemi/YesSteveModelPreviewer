use percent_encoding::percent_decode_str;

/// Writes the raw request body to the path chosen in the save dialog.
#[tauri::command]
async fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
    return Err("缺少文件内容".into());
  };
  let path = request
    .headers()
    .get("path")
    .and_then(|value| value.to_str().ok())
    .ok_or("缺少保存路径")?;
  let path = percent_decode_str(path).decode_utf8().map_err(|error| error.to_string())?;
  std::fs::write(path.as_ref(), data).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![save_file])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
