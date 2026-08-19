//! License hardening (asymmetric-signed token + DPAPI at rest).
//!
//! **Signed token:** the Cloudflare Worker signs the server-authoritative
//! license claims (license_key, expires_at, issued_at, church_name, email,
//! tier, max_machines) with ECDSA P-256 using its private key. The desktop app
//! embeds ONLY the public key here and verifies the signature locally — so a
//! user who edits `tier`/`expires_at` in the persisted record invalidates the
//! signature and the whole license is treated as tampered, never upgraded.
//! Because verification is local + asymmetric, it keeps working offline.
//!
//! **DPAPI at rest:** on Windows the persisted license record is encrypted with
//! the current user/machine DPAPI scope before it is written, so it cannot be
//! opened in a text editor and hand-edited.
//!
//! This is a "speed-bump" control (see `CLAUDE.md`): a determined user who
//! patches the compiled binary can still bypass it, but casual JSON editing and
//! copying a signed license to another machine are defeated.

/// ECDSA P-256 public key (uncompressed `04 || X || Y`) of the license server's
/// signing keypair. MUST match the private key the Worker signs with
/// (`LICENSE_SIGNING_KEY` secret). Regenerate both together if rotated.
const LICENSE_PUB_KEY_POINT_HEX: &str =
    "04ad6ff3debb18e3b5a9cdf06bc9bfd33e5a5dd1b661145909f2e9be3c32e298b5fc97a7c7e895cae7c3b7706ed1e96a0105e0a8c79442caf65b816b3bd4688c65";

/// Canonical string the Worker signs and the app re-derives for verification.
/// The field ORDER and separators MUST match `canonicalClaims` in
/// `workers/license/src/index.js`. `tier` is the lowercase string.
pub fn license_canonical(
    license_key: &str,
    expires_at: u64,
    issued_at: u64,
    church_name: &str,
    email: &str,
    tier: &str,
    max_machines: u32,
) -> String {
    format!(
        "{license_key}\n{expires_at}\n{issued_at}\n{church_name}\n{email}\n{tier}\n{max_machines}"
    )
}

/// Verify an ECDSA P-256 (SHA-256) signature over `canonical`. The signature is
/// the raw `r || s` (64 bytes) produced by WebCrypto, base64 (standard)
/// encoded. Returns false for any malformed input, never panics.
pub fn verify_license_signature(canonical: &[u8], signature_b64: &str) -> bool {
    use base64::Engine;
    use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
    use p256::elliptic_curve::PrimeField;
    use p256::EncodedPoint;

    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(signature_b64) else {
        return false;
    };
    if sig_bytes.len() != 64 {
        return false;
    }
    let Ok(point_hex) = hex_decode(LICENSE_PUB_KEY_POINT_HEX) else {
        return false;
    };
    let Ok(ep) = EncodedPoint::from_bytes(point_hex) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_encoded_point(&ep) else {
        return false;
    };
    let r = p256::Scalar::from_repr(p256::FieldBytes::clone_from_slice(&sig_bytes[..32])).into_option();
    let s = p256::Scalar::from_repr(p256::FieldBytes::clone_from_slice(&sig_bytes[32..])).into_option();
    let (Some(r), Some(s)) = (r, s) else {
        return false;
    };
    let Ok(sig) = Signature::from_scalars(r, s) else {
        return false;
    };
    vk.verify(canonical, &sig).is_ok()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
    if !s.len().is_multiple_of(2) {
        return Err(());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
        .collect()
}

// ─── DPAPI at rest ────────────────────────────────────────────────────────────

/// Encrypt `data` with the current user/machine DPAPI scope (Windows). On
/// non-Windows this is identity (the app ships only for Windows, but this keeps
/// the module testable on other platforms).
#[cfg(windows)]
pub fn protect_at_rest(data: &[u8]) -> Result<Vec<u8>, String> {
    use winapi::shared::minwindef::{BYTE, DWORD};
    use winapi::um::dpapi::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN};
    use winapi::um::winbase::LocalFree;
    use winapi::um::winnt::{LPCWSTR, PVOID};
    use winapi::um::wincrypt::DATA_BLOB;
    use std::ptr;

    unsafe {
        let mut in_blob = DATA_BLOB {
            cbData: data.len() as DWORD,
            pbData: data.as_ptr() as *mut BYTE,
        };
        let mut out_blob = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = CryptProtectData(
            &mut in_blob,
            ptr::null() as LPCWSTR,
            ptr::null_mut(),
            ptr::null_mut() as PVOID,
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("DPAPI protect failed.".into());
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut _);
        Ok(out)
    }
}

/// Decrypt a DPAPI-protected blob (Windows). Non-Windows: identity.
#[cfg(windows)]
pub fn unprotect_at_rest(data: &[u8]) -> Result<Vec<u8>, String> {
    use winapi::shared::minwindef::{BYTE, DWORD};
    use winapi::um::dpapi::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN};
    use winapi::um::winbase::LocalFree;
    use winapi::um::winnt::PVOID;
    use winapi::um::wincrypt::DATA_BLOB;
    use std::ptr;

    unsafe {
        let mut in_blob = DATA_BLOB {
            cbData: data.len() as DWORD,
            pbData: data.as_ptr() as *mut BYTE,
        };
        let mut out_blob = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = CryptUnprotectData(
            &mut in_blob,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut() as PVOID,
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("DPAPI unprotect failed.".into());
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut _);
        Ok(out)
    }
}

#[cfg(not(windows))]
pub fn protect_at_rest(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect_at_rest(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_matches_worker_ordering() {
        let c = license_canonical("WORDLYTE-XXXX", 1000, 500, "Winners", "a@b.com", "pro", 3);
        assert_eq!(c, "WORDLYTE-XXXX\n1000\n500\nWinners\na@b.com\npro\n3");
    }

    #[test]
    fn rejects_malformed_signatures_without_panicking() {
        use base64::Engine;
        assert!(!verify_license_signature(b"x", ""));
        assert!(!verify_license_signature(b"x", "!!!!not-base64!!!!"));
        // 64 bytes but wrong r/s (valid point, invalid signature) → false.
        let bogus = base64::engine::general_purpose::STANDARD.encode([7u8; 64]);
        assert!(!verify_license_signature(b"x", &bogus));
    }

    #[test]
    fn verifies_a_real_worker_signature_across_languages() {
        // Signed by the license server's private key (Node/WebCrypto ECDSA P-256
        // + SHA-256, raw r||s, standard base64) over this exact canonical string.
        // Regenerate the vector with `scripts/` tooling or Node if the key is
        // rotated; the public key must stay in sync on both sides.
        let canonical = "WORDLYTE-TEST-KEY\n1000\n500\nChurch\nemail@x.com\npro\n3";
        let sig = "KLzHJQkDjYFFktjFC16IDTo6430lSUYPzeJBoU5uzbwzMJsXLpKL/JNFr6qZ1IcH5CKwIXwBRsmFlhHJp7bKaQ==";
        assert!(verify_license_signature(canonical.as_bytes(), sig));
    }
}
