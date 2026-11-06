//! Everything peak needs beside the workload: reading /proc, sampling process
//! trees, running commands, talking to runtime agents, and the collector
//! protocol. It has no desktop dependencies, so the same code runs in the app
//! and in the headless `peak-collector` on remote targets.

pub mod cgroup;
pub mod collector;
pub mod hub;
pub mod model;
pub mod monitor;
pub mod procfs;
pub mod protocol;
pub mod runner;
pub mod sampler;
