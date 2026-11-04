fn main() {
    println!("cargo:rerun-if-env-changed=NDI_SDK_DIR");
    println!("cargo:rerun-if-changed=binaries/ndi/Processing.NDI.Lib.x64.dll");
    if std::env::var_os("CARGO_FEATURE_NDI").is_some() {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
            panic!("The `ndi` feature is currently supported only for Windows builds.");
        }
        let sdk = std::env::var_os("NDI_SDK_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Program Files\NDI\NDI 6 SDK"));
        if !sdk.is_dir() {
            panic!(
                "NDI SDK not found at '{}'. Install the NDI 6 SDK or set NDI_SDK_DIR.",
                sdk.display()
            );
        }
        let staged = std::path::Path::new("binaries/ndi/Processing.NDI.Lib.x64.dll");
        if !staged.is_file() {
            panic!("NDI runtime is not staged. Run ../scripts/prepare-ndi.ps1 before building with --features ndi.");
        }
        println!("cargo:rustc-env=WORDLYTE_NDI_SDK_DIR={}", sdk.display());
    }
    tauri_build::build()
}
