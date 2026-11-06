//! `peak-collector serve`: the protocol over stdin/stdout. Stdout carries only
//! protocol frames; diagnostics go to stderr.

#[cfg(target_os = "linux")]
use std::io::{self, BufReader};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use peak_core::{collector, protocol};

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("the collector runs on Linux targets");
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => {
            let mut opts = collector::Options::default();
            let mut it = args[1..].iter();
            while let Some(a) = it.next() {
                match (a.as_str(), it.next()) {
                    ("--idle-timeout", Some(v)) => {
                        opts.idle_timeout = Duration::from_secs(v.parse().unwrap_or(30));
                    }
                    ("--data-dir", Some(v)) => opts.data_dir = Some(PathBuf::from(v)),
                    _ => usage(),
                }
            }
            collector::serve(BufReader::new(io::stdin()), io::stdout(), opts);
        }
        Some("probe") => println!("{}", serde_json::to_string_pretty(&collector::facts()).unwrap()),
        Some("version") => println!("{} protocol {}", env!("CARGO_PKG_VERSION"), protocol::VERSION),
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("usage: peak-collector serve [--idle-timeout SECS] [--data-dir DIR] | probe | version");
    std::process::exit(2);
}
