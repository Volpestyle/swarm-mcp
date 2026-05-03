use std::{
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn main() {
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let commit = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--short"])
        .map(|status| (!status.trim().is_empty()).to_string())
        .unwrap_or_else(|| "false".into());
    let build_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into());

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../../.git/index");
    if branch != "HEAD" && branch != "unknown" {
        println!("cargo:rerun-if-changed=../../../.git/refs/heads/{branch}");
    }

    println!("cargo:rustc-env=SWARM_UI_GIT_BRANCH={branch}");
    println!("cargo:rustc-env=SWARM_UI_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=SWARM_UI_GIT_DIRTY={dirty}");
    println!("cargo:rustc-env=SWARM_UI_BUILD_UNIX={build_unix}");

    tauri_build::build();
}
