//! The collector built into this app (see `build.rs`). Transports copy a file, so it's
//! unpacked once to the data directory, under a name tied to its contents.

use std::fs;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Collectors in this build, by the Linux architecture they run on.
const EMBEDDED: &[(&str, &[u8])] = &[
    #[cfg(peak_collector_x86_64)]
    ("x86_64", include_bytes!(env!("PEAK_COLLECTOR_X86_64"))),
    #[cfg(peak_collector_aarch64)]
    ("aarch64", include_bytes!(env!("PEAK_COLLECTOR_AARCH64"))),
];

/// The architecture this build has a collector for, if any.
pub fn embedded_arch() -> Option<&'static str> {
    EMBEDDED.first().map(|(arch, _)| *arch)
}

/// The embedded collector as a file, if this build has one for `arch`.
pub fn embedded_collector(arch: &str, data_dir: &Path) -> Option<io::Result<PathBuf>> {
    EMBEDDED.iter().find(|(a, _)| *a == arch).map(|(a, bytes)| unpack(a, bytes, data_dir))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Write `bytes` to a path that depends on them. Written aside and renamed in, so a crash
/// or a second copy of Peak never leaves a partial file that looks like the real one.
pub fn unpack(arch: &str, bytes: &[u8], data_dir: &Path) -> io::Result<PathBuf> {
    let dir = data_dir.join("collectors").join(format!("{arch}-{:016x}", fnv1a(bytes)));
    let path = dir.join("peak-collector");
    if fs::read(&path).is_ok_and(|existing| existing == bytes) {
        return Ok(path);
    }
    fs::create_dir_all(&dir)?;
    let partial = dir.join(format!("peak-collector.{}.tmp", std::process::id()));
    let mut file = fs::File::create(&partial)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o755))?;
    drop(file);
    fs::rename(&partial, &path)?;
    Ok(path)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn unpacks_once_and_repairs_a_damaged_copy() {
        let d = tempfile::tempdir().unwrap();
        let path = unpack("x86_64", b"binary", d.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"binary");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);

        let written = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(unpack("x86_64", b"binary", d.path()).unwrap(), path);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), written, "not rewritten");

        fs::write(&path, b"truncat").unwrap();
        assert_eq!(unpack("x86_64", b"binary", d.path()).unwrap(), path);
        assert_eq!(fs::read(&path).unwrap(), b"binary", "repaired");

        assert_ne!(unpack("x86_64", b"newer", d.path()).unwrap(), path, "another build gets its own file");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "nothing left behind");
    }

    #[test]
    fn a_data_directory_it_cannot_write_is_an_error() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("a-file");
        fs::write(&file, "").unwrap();
        assert!(unpack("x86_64", b"binary", &file).is_err());
    }

    /// Other architectures aren't answered with this one's binary.
    #[test]
    fn only_serves_its_own_architecture() {
        let d = tempfile::tempdir().unwrap();
        assert!(embedded_collector("not-an-arch", d.path()).is_none());
    }

    /// The regression this module exists for: an ordinary build carries a collector, and
    /// it's static, so it runs in containers regardless of their libc.
    #[cfg(any(peak_collector_x86_64, peak_collector_aarch64))]
    #[test]
    fn the_embedded_collector_is_static_and_runs() {
        let d = tempfile::tempdir().unwrap();
        let arch = embedded_arch().unwrap();
        assert_eq!(arch, std::env::consts::ARCH);
        let path = embedded_collector(arch, d.path()).unwrap().unwrap();
        // Another test forking while this was being written can hold it open for a moment.
        let run = || std::process::Command::new(&path).arg("version").output();
        let out = (0..50)
            .find_map(|_| match run() {
                Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    None
                }
                other => Some(other.unwrap()),
            })
            .unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).ends_with(&format!("protocol {}\n", peak_core::protocol::VERSION))
        );

        // ELF64: no PT_INTERP (type 3) program header means no dynamic loader is needed.
        let elf = fs::read(&path).unwrap();
        let u64_at = |o: usize| u64::from_le_bytes(elf[o..o + 8].try_into().unwrap()) as usize;
        let u16_at = |o: usize| u16::from_le_bytes(elf[o..o + 2].try_into().unwrap()) as usize;
        let (table, entry, count) = (u64_at(32), u16_at(54), u16_at(56));
        assert!(
            (0..count)
                .all(|i| u32::from_le_bytes(elf[table + i * entry..table + i * entry + 4].try_into().unwrap()) != 3)
        );
    }
}
