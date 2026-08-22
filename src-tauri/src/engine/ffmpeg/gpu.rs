//! GPU vendor detection via DXGI adapter enumeration.
//!
//! `find_by_name("h264_nvenc")` only proves the codec is compiled into
//! libavcodec — the hardware runtime (nvcuda.dll, QuickSync driver, AMF) may
//! be missing, and blindly opening it prints scary loader errors. Enumerating
//! DXGI adapters up front tells us which vendors are actually present so the
//! encoder only attempts matching HW candidates.

/// PCI vendor IDs relevant to HW h264 encoders.
pub const VENDOR_NVIDIA: u32 = 0x10DE;
pub const VENDOR_INTEL: u32 = 0x8086;
pub const VENDOR_AMD: u32 = 0x1002;

/// Vendor IDs present on this system, de-duplicated.
///
/// `Ok(set)` — detection ran (possibly empty: no GPU / headless session).
/// `Err(_)` — enumeration itself failed; callers should fall back to
/// try-opening every candidate as before.
#[cfg(windows)]
pub fn detected_gpu_vendors() -> Result<Vec<u32>, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let mut vendors = Vec::new();
        let mut i = 0u32;
        loop {
            let adapter = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(_) => break, // DXGI_ERROR_NOT_FOUND — end of the list.
            };
            if let Ok(desc) = adapter.GetDesc1() {
                let vendor = desc.VendorId;
                if vendor != 0 && !vendors.contains(&vendor) {
                    vendors.push(vendor);
                }
            }
            i += 1;
            if i > 16 {
                break; // paranoia cap; real systems have < 8 adapters.
            }
        }
        // A software (WARP/basic-render) adapter reports vendor 0 or Microsoft
        // (0x1414); neither can serve NVENC/QSV/AMF, so they stay excluded.
        Ok(vendors)
    }
}

#[cfg(not(windows))]
pub fn detected_gpu_vendors() -> Result<Vec<u32>, String> {
    Err("gpu vendor detection is Windows-only".into())
}
