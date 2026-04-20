use swarm_protocol::rpc::{DeviceInfo, PairingSessionInfo};

use crate::{daemon, model::AppError};

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn mobile_access_fetch_devices() -> Result<Vec<DeviceInfo>, AppError> {
    daemon::fetch_devices().await.map_err(AppError::Operation)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn mobile_access_create_pairing_session() -> Result<PairingSessionInfo, AppError> {
    daemon::create_pairing_session()
        .await
        .map_err(AppError::Operation)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn mobile_access_cancel_pairing_session(session_id: String) -> Result<(), AppError> {
    daemon::cancel_pairing_session(&session_id)
        .await
        .map_err(AppError::Operation)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn mobile_access_revoke_device(device_id: String) -> Result<(), AppError> {
    daemon::revoke_device(&device_id)
        .await
        .map_err(AppError::Operation)
}
