//! Besides the usual Tauri setup, this builds the headless collector for this
//! architecture and embeds it in the app, so every way of building Peak (`task dev`,
//! `cargo build`, `tauri build`, installers) can connect to a remote target. There is
//! no separate file to build or lose.
//!
//! It's a static musl build because it has to run in other people's containers,
//! whatever their libc. A debug build without one still works locally and warns;
//! a release build fails instead of shipping an app that can't connect.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Settings describing the build in progress, which mustn't leak into the nested one:
/// coverage's and clippy's wrappers and the link flags are all for the app.
fn is_outer_build_setting(name: &str) -> bool {
    (name.starts_with("CARGO") && name != "CARGO_HOME")
        || name.starts_with("__CARGO")
        || matches!(
            name,
            "RUSTC"
                | "RUSTDOC"
                | "RUSTFLAGS"
                | "RUSTC_WRAPPER"
                | "RUSTC_WORKSPACE_WRAPPER"
                | "TARGET"
                | "HOST"
                | "PROFILE"
                | "OPT_LEVEL"
                | "DEBUG"
                | "NUM_JOBS"
                | "OUT_DIR"
                | "LLVM_PROFILE_FILE"
        )
}

fn build_collector(cargo: &Path, manifest_dir: &Path, target: &str) -> std::io::Result<Output> {
    let mut cmd = Command::new(cargo);
    cmd.current_dir(manifest_dir)
        .args(["build", "--locked", "-p", "peak-collector", "--release", "--target", target, "--target-dir"])
        // Its own directory: the outer cargo holds a lock on the app's.
        .arg(manifest_dir.join("target/embedded-collector"));
    for (name, _) in env::vars_os() {
        if name.to_str().is_some_and(is_outer_build_setting) {
            cmd.env_remove(name);
        }
    }
    cmd.output()
}

fn target_is_missing(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr.contains("target may not be installed") || stderr.contains("can't find crate for `std`")
}

/// Build it, adding the rustup target on first use. Err says why it couldn't.
fn collector_binary(manifest_dir: &Path, target: &str) -> Result<PathBuf, String> {
    let cargo = PathBuf::from(env::var_os("CARGO").ok_or("CARGO isn't set")?);
    let mut output = build_collector(&cargo, manifest_dir, target).map_err(|e| e.to_string())?;
    if !output.status.success() && target_is_missing(&output) {
        let added = Command::new("rustup").args(["target", "add", target]).status();
        if !added.is_ok_and(|s| s.success()) {
            return Err(format!(
                "the Rust target {target} isn't installed, and `rustup target add {target}` didn't work"
            ));
        }
        output = build_collector(&cargo, manifest_dir, target).map_err(|e| e.to_string())?;
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(6).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join(" / "));
    }
    Ok(manifest_dir.join("target/embedded-collector").join(target).join("release/peak-collector"))
}

fn embed_collector() {
    println!("cargo::rustc-check-cfg=cfg(peak_embedded_collector)");
    for path in [
        "peak-core/src",
        "peak-core/Cargo.toml",
        "peak-collector/src",
        "peak-collector/Cargo.toml",
        "Cargo.lock",
        "agents/peak-agent.cjs",
        "agents/python/sitecustomize.py",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=PEAK_ALLOW_NO_COLLECTOR");
    println!("cargo:rerun-if-env-changed=PEAK_REQUIRE_COLLECTOR");

    let (os, arch) =
        (env::var("CARGO_CFG_TARGET_OS").unwrap_or_default(), env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default());
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("set by cargo"));
    let target = format!("{arch}-unknown-linux-musl");

    let built = if os == "linux" {
        collector_binary(&manifest_dir, &target)
    } else {
        Err(format!("collectors are Linux-only, and this build is for {os}"))
    };
    match built {
        Ok(binary) => {
            let copy = out_dir.join("peak-collector");
            fs::copy(&binary, &copy).expect("copy the built collector");
            println!("cargo:rustc-env=PEAK_EMBEDDED_COLLECTOR={}", copy.display());
            println!("cargo:rustc-env=PEAK_EMBEDDED_COLLECTOR_ARCH={arch}");
            println!("cargo:rustc-cfg=peak_embedded_collector");
        }
        Err(why) => {
            // CI sets PEAK_REQUIRE_COLLECTOR so a debug build can't quietly lose it either.
            let required =
                env::var("PROFILE").is_ok_and(|p| p == "release") || env::var_os("PEAK_REQUIRE_COLLECTOR").is_some();
            if required && env::var_os("PEAK_ALLOW_NO_COLLECTOR").is_none() {
                panic!(
                    "this build couldn't embed a collector, so it couldn't connect to remote targets: {why}\n\
                     Fix that, or set PEAK_ALLOW_NO_COLLECTOR=1 to build without remote support on purpose."
                );
            }
            println!("cargo:warning=no collector embedded, so this build can't connect to remote targets: {why}");
        }
    }
}

fn main() {
    embed_collector();
    tauri_build::build()
}
