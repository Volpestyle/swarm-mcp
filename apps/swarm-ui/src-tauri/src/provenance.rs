use std::{
    env, fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildProvenance {
    pub app_version: String,
    pub build_profile: String,
    pub run_kind: String,
    pub git_branch: String,
    pub git_commit: String,
    pub git_dirty: bool,
    pub build_unix: Option<u64>,
    pub executable_modified_unix: Option<u64>,
    pub executable_path: String,
    pub app_bundle_path: Option<String>,
    pub current_working_directory: String,
    pub source_root: String,
    pub manifest_dir: String,
}

#[tauri::command]
pub fn ui_build_provenance() -> BuildProvenance {
    let executable = env::current_exe().unwrap_or_else(|_| PathBuf::from("unknown"));
    let app_bundle = app_bundle_path(&executable);
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_root = canonical_or_self(&manifest_dir.join("../../.."));

    BuildProvenance {
        app_version: env!("CARGO_PKG_VERSION").into(),
        build_profile: build_profile().into(),
        run_kind: classify_run_kind(&executable, app_bundle.as_deref()).into(),
        git_branch: option_env!("SWARM_UI_GIT_BRANCH")
            .unwrap_or("unknown")
            .into(),
        git_commit: option_env!("SWARM_UI_GIT_COMMIT")
            .unwrap_or("unknown")
            .into(),
        git_dirty: option_env!("SWARM_UI_GIT_DIRTY")
            .map(|value| value == "true" || value == "1")
            .unwrap_or(false),
        build_unix: option_env!("SWARM_UI_BUILD_UNIX").and_then(|value| value.parse().ok()),
        executable_modified_unix: modified_unix(&executable),
        executable_path: path_string(&executable),
        app_bundle_path: app_bundle.as_deref().map(path_string),
        current_working_directory: env::current_dir()
            .map(|path| path_string(&path))
            .unwrap_or_else(|_| "unknown".into()),
        source_root: path_string(&source_root),
        manifest_dir: path_string(&manifest_dir),
    }
}

fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

fn classify_run_kind(executable: &Path, app_bundle: Option<&Path>) -> &'static str {
    if app_bundle.is_some() {
        return "app-bundle";
    }

    let path = executable.to_string_lossy();
    if cfg!(debug_assertions) && path.contains("/target/debug/") {
        return "tauri-dev";
    }

    if cfg!(debug_assertions) {
        "debug-binary"
    } else {
        "release-binary"
    }
}

fn app_bundle_path(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

fn modified_unix(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bundle_path_from_nested_executable() {
        let executable =
            Path::new("/Users/mj/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui");

        assert_eq!(
            app_bundle_path(executable),
            Some(PathBuf::from("/Users/mj/Applications/Swarm UI Lab.app"))
        );
    }

    #[test]
    fn classifies_bundle_before_debug_binary() {
        let executable =
            Path::new("/repo/target/debug/bundle/macos/swarm-ui.app/Contents/MacOS/swarm-ui");
        let bundle = app_bundle_path(executable);

        assert_eq!(
            classify_run_kind(executable, bundle.as_deref()),
            "app-bundle"
        );
    }
}
