// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match peak_lib::cli::parse_args(&args) {
        Some(cli) => std::process::exit(peak_lib::cli::main(cli, &peak_lib::discovery::default_dirs())),
        None => peak_lib::run(),
    }
}
