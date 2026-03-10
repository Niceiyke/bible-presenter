fn main() {
    #[cfg(target_os = "windows")]
    {
        // Tell the linker to delay-load GStreamer and its core dependencies.
        // This allows the app to start and set the PATH before these are resolved.
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstreamer-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gobject-2.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:glib-2.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gio-2.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gmodule-2.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstvideo-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstapp-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstaudio-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstbase-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstpbutils-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gsttag-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstcontroller-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstnet-1.0-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:gstcheck-1.0-0.dll");
    }
    tauri_build::build()
}
