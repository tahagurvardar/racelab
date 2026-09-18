use racelab_lib::fh6_validation::validate_capture;
use std::{collections::BTreeSet, fs::File, io::BufReader};

fn run() -> Result<bool, Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let path = args
        .next()
        .ok_or("Usage: validate_fh6 <file.rlcap> [--reset-at <1-based-packet-index>]...")?;
    let mut resets = BTreeSet::new();
    while let Some(flag) = args.next() {
        if flag != "--reset-at" {
            return Err("Unknown argument; expected --reset-at".into());
        }
        let index = args
            .next()
            .ok_or("Missing reset index")?
            .to_str()
            .ok_or("Invalid reset index")?
            .parse::<u64>()?;
        if index == 0 || !resets.insert(index) {
            return Err("Reset indices must be positive and unique".into());
        }
    }
    let report = validate_capture(BufReader::new(File::open(path)?), &resets)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(report.valid)
}
fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(2),
        Err(error) => {
            eprintln!("FH6 validation failed: {error}");
            std::process::exit(1);
        }
    }
}
