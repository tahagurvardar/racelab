fn main() {
    tauri_build::build();
    // Tauri links its Windows resources only into bins by default. The real
    // WebView2 example needs the same Common Controls v6 + DPI manifest; without
    // it Windows resolves the older comctl32 without TaskDialogIndirect.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let resources =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        if resources.exists() {
            println!("cargo:rustc-link-arg-examples={}", resources.display());
        }
    }
}
