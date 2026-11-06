//! `peak` is a windowed program on Windows, which can't talk to a terminal, so the command
//! line lives in this console program there. It's the same CLI on every platform.

fn main() {
    peak_lib::release::restore_launch_dir();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = peak_lib::cli::parse_args(&args).unwrap_or(peak_lib::cli::Cli::Help);
    std::process::exit(peak_lib::cli::main(cli, &peak_lib::discovery::default_dirs()));
}
