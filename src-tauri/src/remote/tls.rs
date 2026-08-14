//! Self-signed TLS for the Remote Control server.
//!
//! `navigator.mediaDevices.getUserMedia()` (which captures the phone's camera)
//! is only available in a *secure context*, and a plain-HTTP LAN origin is not
//! one. Serving the remote bundle over HTTPS makes the phone's page secure so
//! the phone camera can stream. The certificate is self-signed for the
//! operator's LAN IP, generated on first use and persisted so phones only need
//! to accept the certificate warning once, not on every app restart.

use axum_server::tls_rustls::RustlsConfig;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls_pemfile::Item;
use std::io::Cursor;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use time::{Duration, OffsetDateTime};

/// Validity window (~2 years) so the cert does not silently expire while a
/// church is mid-season and force everyone to re-accept it.
const VALIDITY_DAYS: i64 = 825;

/// Returns a ready-to-serve rustls `ServerConfig` for the given LAN IP,
/// reusing the persisted certificate when it is still valid for that address.
///
/// If the persisted cert is missing or was issued for a different IP (DHCP
/// reassigned the operator), a fresh cert is generated and persisted, so the
/// phone may need to accept the new certificate once.
pub fn load_or_create(path: &Path, ip: IpAddr) -> Result<RustlsConfig, String> {
    if let Some(config) = load(path, ip) {
        return Ok(config);
    }
    let (cert_pem, key_pem) = generate(ip)?;
    persist(path, ip, &cert_pem, &key_pem)?;
    build(&cert_pem, &key_pem)
}

/// Tries to load a persisted certificate that covers `ip`.
fn load(path: &Path, ip: IpAddr) -> Option<RustlsConfig> {
    let json = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let stored_ip = value.get("ip").and_then(|v| v.as_str());
    if stored_ip != Some(ip.to_string().as_str()) {
        // The LAN address moved — the old cert is no longer valid for it.
        return None;
    }
    let cert_pem = value.get("cert").and_then(|v| v.as_str())?;
    let key_pem = value.get("key").and_then(|v| v.as_str())?;
    build(cert_pem, key_pem).ok()
}

/// Generates a fresh self-signed certificate for `ip` (ECDSA P-256).
fn generate(ip: IpAddr) -> Result<(String, String), String> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Wordlyte Remote");
    dn.push(DnType::OrganizationName, "Wordlyte");
    params.distinguished_name = dn;
    params.subject_alt_names = vec![SanType::IpAddress(ip)];
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::days(1);
    params.not_after = now + Duration::days(VALIDITY_DAYS);

    let key_pair = KeyPair::generate().map_err(|e| format!("failed to generate TLS key: {}", e))?;
    let cert = params.self_signed(&key_pair).map_err(|e| format!("failed to sign TLS certificate: {}", e))?;
    Ok((cert.pem(), key_pair.serialize_pem()))
}

/// Persists the certificate + key alongside the IP it was issued for, written
/// atomically so a crash mid-write can never leave a corrupt store.
fn persist(path: &Path, ip: IpAddr, cert_pem: &str, key_pem: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("failed to create TLS dir: {}", e))?;
    }
    let json = serde_json::json!({ "ip": ip.to_string(), "cert": cert_pem, "key": key_pem }).to_string();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("failed to write TLS store: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("failed to finalize TLS store: {}", e))?;
    Ok(())
}

/// Ensures rustls has a process-level default `CryptoProvider`. Both `ring`
/// (pulled in by reqwest) and `aws-lc-rs` (by axum-server's `tls-rustls`
/// feature) can be compiled, which stops rustls from auto-selecting one, so we
/// pick `ring` explicitly. The first install wins; later calls are a no-op.
fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Builds an axum-server `RustlsConfig` from PEM certificate + private key.
fn build(cert_pem: &str, key_pem: &str) -> Result<RustlsConfig, String> {
    ensure_crypto_provider();
    let certs: Vec<rustls::pki_types::CertificateDer<'static>> = rustls_pemfile::read_all(&mut Cursor::new(cert_pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse TLS certificate: {}", e))?
        .into_iter()
        .filter_map(|item| match item {
            Item::X509Certificate(c) => Some(c),
            _ => None,
        })
        .collect();
    if certs.is_empty() {
        return Err("TLS store contains no certificate".to_string());
    }
    let key = rustls_pemfile::read_all(&mut Cursor::new(key_pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse TLS key: {}", e))?
        .into_iter()
        .find_map(|item| match item {
            Item::Pkcs1Key(k) => Some(k.into()),
            Item::Pkcs8Key(k) => Some(k.into()),
            Item::Sec1Key(k) => Some(k.into()),
            _ => None,
        })
        .ok_or_else(|| "TLS store contains no private key".to_string())?;

    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("failed to build TLS config: {}", e))?;
    Ok(RustlsConfig::from_config(Arc::new(server_config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_usable_self_signed_cert() {
        let (cert_pem, key_pem) = generate(IpAddr::V4("192.168.1.50".parse().unwrap())).unwrap();
        assert!(cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(key_pem.contains("BEGIN PRIVATE KEY"));
        // The PEM round-trips into a servable rustls config.
        assert!(build(&cert_pem, &key_pem).is_ok());
    }

    #[test]
    fn persists_and_reloads_for_the_same_ip() {
        let path = std::env::temp_dir().join(format!("wordlyte_tls_test_{}.json", uuid::Uuid::new_v4()));
        let ip = IpAddr::V4("10.0.0.7".parse().unwrap());

        assert!(load_or_create(&path, ip).is_ok());
        // Second load reuses the persisted cert (no regenerations to assert
        // directly, but it must still build).
        assert!(load_or_create(&path, ip).is_ok());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    }

    #[test]
    fn regenerates_when_the_ip_changes() {
        let path = std::env::temp_dir().join(format!("wordlyte_tls_test_{}.json", uuid::Uuid::new_v4()));
        let a = IpAddr::V4("10.0.0.7".parse().unwrap());
        let b = IpAddr::V4("10.0.0.9".parse().unwrap());
        assert!(load_or_create(&path, a).is_ok());
        // A moved IP forces a fresh cert for the new address.
        assert!(load_or_create(&path, b).is_ok());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    }
}