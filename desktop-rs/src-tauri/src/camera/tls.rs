//! Self-signed TLS certificate management.
//!
//! Generates a certificate on first run and persists it so the browser's
//! "trust once" dialog does not reappear every restart.

use std::path::PathBuf;
use std::sync::Arc;

/// A loaded/generated TLS identity (cert PEM + key PEM).
#[derive(Clone)]
pub struct AppCert {
    /// DER-encoded certificate (for fingerprint + rustls).
    pub cert_der: Vec<u8>,
    /// PEM-encoded certificate chain.
    pub cert_pem: String,
    /// PEM-encoded private key.
    pub key_pem: String,
    /// SHA-256 fingerprint as uppercase colon-hex, e.g. "AA:BB:CC:...".
    pub fingerprint: String,
}

impl AppCert {
    /// Load persisted cert/key from `cert_dir`, or generate a fresh one.
    ///
    /// Files: `{cert_dir}/cert.pem` and `{cert_dir}/key.pem`.
    pub fn load_or_generate(cert_dir: &PathBuf) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(cert_dir)?;
        let cert_path = cert_dir.join("cert.pem");
        let key_path  = cert_dir.join("key.pem");

        if cert_path.exists() && key_path.exists() {
            let cert_pem = std::fs::read_to_string(&cert_path)?;
            let key_pem  = std::fs::read_to_string(&key_path)?;
            if let Ok(cert) = Self::from_pems(cert_pem, key_pem) {
                return Ok(Arc::new(cert));
            }
            // Corrupt/expired — fall through to regenerate.
            eprintln!("[tls] Stored cert invalid, regenerating.");
        }

        let cert = Self::generate()?;
        std::fs::write(&cert_path, &cert.cert_pem)?;
        std::fs::write(&key_path,  &cert.key_pem)?;
        eprintln!("[tls] Generated new self-signed cert. Fingerprint: {}", cert.fingerprint);
        Ok(Arc::new(cert))
    }

    fn generate() -> anyhow::Result<Self> {
        use rcgen::{CertificateParams, DistinguishedName, KeyPair, SanType};

        let mut params = CertificateParams::default();
        params.distinguished_name = {
            let mut dn = DistinguishedName::new();
            dn.push(rcgen::DnType::OrganizationName, "Wordlyte");
            dn.push(rcgen::DnType::CommonName, "wordlyte-lan");
            dn
        };
        // Allow connections by any local IP/hostname
        params.subject_alt_names = vec![
            SanType::DnsName("localhost".try_into()?),
            SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)),
        ];
        // Valid for 10 years — no need to force re-pairing.
        let not_before = rcgen::date_time_ymd(2024, 1, 1);
        let not_after  = rcgen::date_time_ymd(2034, 1, 1);
        params.not_before = not_before;
        params.not_after  = not_after;

        let key_pair = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let cert     = params.self_signed(&key_pair)?;

        let cert_pem = cert.pem();
        let key_pem  = key_pair.serialize_pem();
        let cert_der = cert.der().to_vec();
        let fingerprint = sha256_fingerprint(&cert_der);

        Ok(Self { cert_der, cert_pem, key_pem, fingerprint })
    }

    fn from_pems(cert_pem: String, key_pem: String) -> anyhow::Result<Self> {
        // Parse DER from PEM to compute fingerprint.
        let mut cursor = std::io::Cursor::new(cert_pem.as_bytes());
        let certs = rustls_pemfile::certs(&mut cursor)
            .collect::<Result<Vec<_>, _>>()?;
        let cert_der = certs.into_iter().next()
            .ok_or_else(|| anyhow::anyhow!("No cert in PEM"))?
            .to_vec();
        let fingerprint = sha256_fingerprint(&cert_der);
        Ok(Self { cert_der, cert_pem, key_pem, fingerprint })
    }

    /// Returns (cert_pem_bytes, key_pem_bytes) for building RustlsConfig.
    pub fn pem_bytes(&self) -> (Vec<u8>, Vec<u8>) {
        (self.cert_pem.as_bytes().to_vec(), self.key_pem.as_bytes().to_vec())
    }
}

fn sha256_fingerprint(der: &[u8]) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(der);
    hash.iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":")
}
