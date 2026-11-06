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

fn build_collector(cargo: &Path, manifest_dir: &Path, target: &str, cross: bool) -> std::io::Result<Output> {
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
    if cross {
        // No Linux C toolchain on this machine. Rust's own linker and musl runtime are enough,
        // since the collector has no C dependencies.
        cmd.args(["--config", &format!("target.{target}.linker=\"rust-lld\"")]);
        cmd.env(
            format!("CARGO_TARGET_{}_RUSTFLAGS", target.to_uppercase().replace('-', "_")),
            "-C link-self-contained=yes -C target-feature=+crt-static",
        );
    }
    cmd.output()
}

fn target_is_missing(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr.contains("target may not be installed") || stderr.contains("can't find crate for `std`")
}

/// Build it, adding the rustup target on first use. Err says why it couldn't.
fn collector_binary(manifest_dir: &Path, target: &str, cross: bool) -> Result<PathBuf, String> {
    let cargo = PathBuf::from(env::var_os("CARGO").ok_or("CARGO isn't set")?);
    let mut output = build_collector(&cargo, manifest_dir, target, cross).map_err(|e| e.to_string())?;
    if !output.status.success() && target_is_missing(&output) {
        let added = Command::new("rustup").args(["target", "add", target]).status();
        if !added.is_ok_and(|s| s.success()) {
            return Err(format!(
                "the Rust target {target} isn't installed, and `rustup target add {target}` didn't work"
            ));
        }
        output = build_collector(&cargo, manifest_dir, target, cross).map_err(|e| e.to_string())?;
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(6).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join(" / "));
    }
    Ok(manifest_dir.join("target/embedded-collector").join(target).join("release/peak-collector"))
}

fn embed_collector() {
    println!("cargo::rustc-check-cfg=cfg(peak_collector_x86_64)");
    println!("cargo::rustc-check-cfg=cfg(peak_collector_aarch64)");
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

    // A collector runs on the Linux target, not here. A Linux app embeds its own
    // architecture, as most of its targets match it. A macOS or Windows app can't assume,
    // so it carries the two Linux architectures its targets are likely to be.
    let arches: Vec<&str> = if os == "linux" { vec![arch.as_str()] } else { vec!["x86_64", "aarch64"] };
    let mut problems = vec![];
    for a in arches {
        match collector_binary(&manifest_dir, &format!("{a}-unknown-linux-musl"), os != "linux") {
            Ok(binary) => {
                let copy = out_dir.join(format!("peak-collector-{a}"));
                fs::copy(&binary, &copy).expect("copy the built collector");
                println!("cargo:rustc-env=PEAK_COLLECTOR_{}={}", a.to_uppercase(), copy.display());
                println!("cargo:rustc-cfg=peak_collector_{a}");
            }
            Err(why) => problems.push(format!("{a}: {why}")),
        }
    }
    if !problems.is_empty() {
        let why = problems.join("; ");
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

/// Which commit this build came from: named by CI, else asked of git.
fn embed_commit() {
    println!("cargo:rerun-if-env-changed=PEAK_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    for head in ["../.git/HEAD", "../.git/refs/heads/master"] {
        if Path::new(head).exists() {
            println!("cargo:rerun-if-changed={head}");
        }
    }
    let named = env::var("PEAK_BUILD_COMMIT").or_else(|_| env::var("GITHUB_SHA")).ok();
    let asked = || {
        let out = Command::new("git").args(["rev-parse", "HEAD"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let commit = named.or_else(asked).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=PEAK_BUILD_COMMIT={commit}");
}

fn main() {
    embed_collector();
    embed_commit();
    tauri_build::build()
}
