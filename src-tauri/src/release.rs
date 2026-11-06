//! What this build is and how it was installed, which decides how it can be updated.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;

/// What can replace itself: an AppImage, a macOS app and a Windows NSIS install. A Linux
/// system package would need a root prompt and belongs to the package manager, and a source
/// build has nothing to update from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    Appimage,
    App,
    Nsis,
    Msi,
    Deb,
    Rpm,
    Source,
}

impl InstallKind {
    /// The bundler stamps the format into each copy. `APPIMAGE` is checked too because a
    /// stamped binary copied out of the image isn't running from one. macOS isn't stamped
    /// (every build reads as an app), so there it's about being inside an app bundle.
    pub fn of(bundle: Option<BundleType>, appimage: Option<&OsStr>, exe: Option<&Path>) -> InstallKind {
        match bundle {
            Some(BundleType::AppImage) if appimage.is_some_and(|p| !p.is_empty()) => InstallKind::Appimage,
            Some(BundleType::App) if exe.is_some_and(|e| e.to_string_lossy().contains(".app/Contents/MacOS/")) => {
                InstallKind::App
            }
            Some(BundleType::Nsis) => InstallKind::Nsis,
            Some(BundleType::Msi) => InstallKind::Msi,
            Some(BundleType::Deb) => InstallKind::Deb,
            Some(BundleType::Rpm) => InstallKind::Rpm,
            _ => InstallKind::Source,
        }
    }

    pub fn updatable(self) -> bool {
        matches!(self, InstallKind::Appimage | InstallKind::App | InstallKind::Nsis)
    }

    fn label(self) -> &'static str {
        match self {
            InstallKind::Appimage => "AppImage",
            InstallKind::App => "macOS app",
            InstallKind::Nsis => "Windows installer",
            InstallKind::Msi => "Windows MSI",
            InstallKind::Deb => "deb package",
            InstallKind::Rpm => "rpm package",
            InstallKind::Source => "source build",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallInfo {
    pub version: String,
    pub commit: String,
    pub kind: InstallKind,
    pub updatable: bool,
}

impl InstallInfo {
    pub fn detect() -> InstallInfo {
        let exe = std::env::current_exe().ok();
        let kind = InstallKind::of(bundle_type(), std::env::var_os("APPIMAGE").as_deref(), exe.as_deref());
        InstallInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: env!("PEAK_BUILD_COMMIT").to_string(),
            kind,
            updatable: kind.updatable(),
        }
    }

    pub fn line(&self) -> String {
        format!("peak {} ({}, commit {})", self.version, self.kind.label(), self.commit)
    }
}

/// An AppImage's launcher changes directory into the mounted image, keeping the original in
/// `OWD`. Without going back, every `peak run` would run its command inside the image.
pub fn launch_dir(appdir: Option<&OsStr>, owd: Option<&OsStr>) -> Option<PathBuf> {
    appdir.filter(|a| !a.is_empty())?;
    owd.filter(|o| !o.is_empty()).map(PathBuf::from)
}

/// The first thing the command line does.
pub fn restore_launch_dir() {
    if let Some(dir) = launch_dir(std::env::var_os("APPDIR").as_deref(), std::env::var_os("OWD").as_deref()) {
        let _ = std::env::set_current_dir(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_how_it_was_installed() {
        let path = OsStr::new("/home/me/.local/bin/peak");
        let of = |b, a| InstallKind::of(b, a, None);
        assert_eq!(of(Some(BundleType::AppImage), Some(path)), InstallKind::Appimage);
        assert_eq!(of(Some(BundleType::AppImage), None), InstallKind::Source);
        assert_eq!(of(Some(BundleType::AppImage), Some(OsStr::new(""))), InstallKind::Source);
        assert_eq!(of(Some(BundleType::Deb), Some(path)), InstallKind::Deb);
        assert_eq!(of(Some(BundleType::Rpm), None), InstallKind::Rpm);
        assert_eq!(of(Some(BundleType::Nsis), None), InstallKind::Nsis);
        assert_eq!(of(Some(BundleType::Msi), None), InstallKind::Msi);
        assert_eq!(of(None, Some(path)), InstallKind::Source);
        let in_app = Path::new("/Applications/peak.app/Contents/MacOS/peak");
        let bare = Path::new("/Users/me/peak/src-tauri/target/debug/peak");
        assert_eq!(InstallKind::of(Some(BundleType::App), None, Some(in_app)), InstallKind::App);
        assert_eq!(InstallKind::of(Some(BundleType::App), None, Some(bare)), InstallKind::Source);
        assert_eq!(InstallKind::of(Some(BundleType::App), None, None), InstallKind::Source);
    }

    #[test]
    fn goes_back_to_where_an_appimage_was_launched() {
        let (app, owd) = (OsStr::new("/tmp/.mount_x"), OsStr::new("/work"));
        assert_eq!(launch_dir(Some(app), Some(owd)), Some(PathBuf::from("/work")));
        assert_eq!(launch_dir(None, Some(owd)), None);
        assert_eq!(launch_dir(Some(app), None), None);
        assert_eq!(launch_dir(Some(OsStr::new("")), Some(owd)), None);
        assert_eq!(launch_dir(Some(app), Some(OsStr::new(""))), None);
        restore_launch_dir();
    }

    #[test]
    fn says_which_can_update_themselves() {
        for k in [InstallKind::Appimage, InstallKind::App, InstallKind::Nsis] {
            assert!(k.updatable());
        }
        for k in [InstallKind::Msi, InstallKind::Deb, InstallKind::Rpm, InstallKind::Source] {
            assert!(!k.updatable());
        }
    }

    #[test]
    fn describes_itself() {
        let info = InstallInfo::detect();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(info.line().starts_with(&format!("peak {} (", info.version)));
        assert!(!info.commit.is_empty());
        for (kind, label) in [
            (InstallKind::Appimage, "AppImage"),
            (InstallKind::App, "macOS app"),
            (InstallKind::Nsis, "Windows installer"),
            (InstallKind::Msi, "Windows MSI"),
            (InstallKind::Deb, "deb package"),
            (InstallKind::Rpm, "rpm package"),
            (InstallKind::Source, "source build"),
        ] {
            let line =
                InstallInfo { version: "1".into(), commit: "c".into(), kind, updatable: kind.updatable() }.line();
            assert_eq!(line, format!("peak 1 ({label}, commit c)"));
        }
        assert_eq!(serde_json::to_string(&InstallKind::Appimage).unwrap(), "\"appimage\"");
    }
}
