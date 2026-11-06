//! Container capacity from cgroups. `/proc/meminfo` shows the host even inside a
//! limited container, so limits are read and labelled separately.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Limits on the collector's own cgroup. `None` means unlimited or unknown; the
/// `version` says whether cgroups could be read at all.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CgroupLimits {
    pub version: Option<u8>,
    pub memory_max: Option<f64>,
    pub memory_current: Option<f64>,
    /// CPU bandwidth limit in cores (quota / period). Peak's CPU % stays 100% per core.
    pub cpu_quota_cores: Option<f64>,
}

/// Values at or above this are how cgroup v1 spells "unlimited".
const UNLIMITED: f64 = 1e18;

fn read_number(path: &Path) -> Option<f64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn tighter(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

/// `cpu.max` is "<quota> <period>" or "max <period>".
fn parse_cpu_max(s: &str) -> Option<f64> {
    let mut it = s.split_whitespace();
    let quota: f64 = it.next()?.parse().ok()?;
    let period: f64 = it.next()?.parse().ok()?;
    (period > 0.0).then_some(quota / period)
}

/// Read limits from a cgroup mount, given the text of `/proc/self/cgroup`. Walks
/// every ancestor, because a parent's limit binds its children too.
pub fn read_limits(mount: &Path, self_cgroup: &str) -> CgroupLimits {
    let unified = self_cgroup.lines().find_map(|l| l.strip_prefix("0::"));
    if mount.join("cgroup.controllers").exists() {
        let path = unified.unwrap_or("/").trim_start_matches('/');
        let mut dirs = vec![mount.to_path_buf()];
        let mut cur = mount.to_path_buf();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            cur = cur.join(part);
            dirs.push(cur.clone());
        }
        let mut limits = CgroupLimits { version: Some(2), ..Default::default() };
        for d in &dirs {
            limits.memory_max = tighter(limits.memory_max, read_number(&d.join("memory.max")));
            let cpu = fs::read_to_string(d.join("cpu.max")).ok().and_then(|s| parse_cpu_max(&s));
            limits.cpu_quota_cores = tighter(limits.cpu_quota_cores, cpu);
        }
        limits.memory_current = dirs.iter().rev().find_map(|d| read_number(&d.join("memory.current")));
        return limits;
    }
    let mem = mount.join("memory");
    if mem.is_dir() {
        let quota = read_number(&mount.join("cpu/cpu.cfs_quota_us")).filter(|q| *q > 0.0);
        let period = read_number(&mount.join("cpu/cpu.cfs_period_us")).filter(|p| *p > 0.0);
        return CgroupLimits {
            version: Some(1),
            memory_max: read_number(&mem.join("memory.limit_in_bytes")).filter(|m| *m < UNLIMITED),
            memory_current: read_number(&mem.join("memory.usage_in_bytes")),
            cpu_quota_cores: quota.zip(period).map(|(q, p)| q / p),
        };
    }
    CgroupLimits::default()
}

/// Limits as seen by this process.
pub fn own_limits() -> CgroupLimits {
    read_limits(Path::new("/sys/fs/cgroup"), &fs::read_to_string("/proc/self/cgroup").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn v2_takes_the_tightest_ancestor_and_understands_max() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "cgroup.controllers", "memory cpu");
        write(d.path(), "memory.max", "max\n");
        write(d.path(), "a/memory.max", "1000\n");
        write(d.path(), "a/cpu.max", "200000 100000\n");
        write(d.path(), "a/b/memory.max", "max\n");
        write(d.path(), "a/b/memory.current", "400\n");
        write(d.path(), "a/b/cpu.max", "max 100000\n");
        assert_eq!(
            read_limits(d.path(), "0::/a/b\n"),
            CgroupLimits {
                version: Some(2),
                memory_max: Some(1000.0),
                memory_current: Some(400.0),
                cpu_quota_cores: Some(2.0)
            }
        );
    }

    #[test]
    fn v2_unlimited_stays_unknown_and_tightest_wins_either_way() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "cgroup.controllers", "");
        write(d.path(), "memory.max", "max\n");
        write(d.path(), "cpu.max", "max 100000\n");
        let l = read_limits(d.path(), "");
        assert_eq!((l.version, l.memory_max, l.cpu_quota_cores, l.memory_current), (Some(2), None, None, None));
        write(d.path(), "memory.max", "500\n");
        write(d.path(), "x/memory.max", "900\n");
        assert_eq!(read_limits(d.path(), "0::/x").memory_max, Some(500.0));
        write(d.path(), "cpu.max", "garbage\n");
        assert_eq!(read_limits(d.path(), "0::/x").cpu_quota_cores, None);
        write(d.path(), "cpu.max", "100 0\n");
        assert_eq!(read_limits(d.path(), "0::/x").cpu_quota_cores, None);
    }

    #[test]
    fn v1_reads_its_own_layout_and_treats_huge_as_unlimited() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "memory/memory.limit_in_bytes", "2048\n");
        write(d.path(), "memory/memory.usage_in_bytes", "1024\n");
        write(d.path(), "cpu/cpu.cfs_quota_us", "50000\n");
        write(d.path(), "cpu/cpu.cfs_period_us", "100000\n");
        assert_eq!(
            read_limits(d.path(), ""),
            CgroupLimits {
                version: Some(1),
                memory_max: Some(2048.0),
                memory_current: Some(1024.0),
                cpu_quota_cores: Some(0.5)
            }
        );
        write(d.path(), "memory/memory.limit_in_bytes", "9223372036854771712\n");
        write(d.path(), "cpu/cpu.cfs_quota_us", "-1\n");
        let l = read_limits(d.path(), "");
        assert_eq!((l.memory_max, l.cpu_quota_cores), (None, None));
    }

    #[test]
    fn no_cgroups_reads_as_unknown() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_limits(d.path(), ""), CgroupLimits::default());
        let _ = own_limits();
    }
}
