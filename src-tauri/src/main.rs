// A packaged RaceLab is a windowed product, not a console tool. Without this,
// a release build opens a console window behind the app on Windows. Debug
// builds keep the console so `pnpm tauri dev` can still print.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    racelab_lib::run();
}
