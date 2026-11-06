//! `peak-collector serve`: the protocol over stdin/stdout. Stdout carries only
//! protocol frames; diagnostics go to stderr.

use std::io::{self, BufReader};
use std::path::PathBuf;
use std::time::Duration;

use peak_core::{collector, protocol};

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
