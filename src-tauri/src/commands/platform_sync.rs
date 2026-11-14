use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::State;

const MAX_PRESENTATION_DETAILS: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthResponse {
    token: String,
    expires_at: u64,
    organization: SyncOrganization,
    device: SyncDevice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOrganization {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevice {
    pub machine_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServicePlanList {
    service_plans: Vec<Value>,
    cursor: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationList {
    presentations: Vec<Value>,
    cursor: u64,
}

#[derive(Debug, Deserialize)]
struct PresentationDetail {
    presentation: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSyncResult {
    pub organization: SyncOrganization,
    pub device: SyncDevice,
    pub expires_at: u64,
    pub service_plans: Vec<Value>,
    pub plan_cursor: u64,
    pub presentations: Vec<Value>,
    pub presentation_cursor: u64,
    pub presentation_details: HashMap<String, Value>,
}

#[tauri::command]
pub async fn platform_sync_pull(
    state: State<'_, AppState>,
    api_url: String,
) -> Result<PlatformSyncResult, String> {
    let base = normalize_api_url(&api_url)?;
    let identity = state.license.platform_identity().ok_or_else(|| {
        "Activate this computer with an active Wordlyte license before syncing from the Dashboard."
            .to_owned()
    })?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Cloud sync client could not start: {error}"))?;

    let auth_response = client
        .post(format!("{base}/v1/device-auth/token"))
        .json(&serde_json::json!({
            "licenseOrganizationId": identity.organization_id,
            "machineId": identity.machine_id,
            "deviceToken": identity.device_token,
        }))
        .send()
        .await
        .map_err(|error| format!("Could not exchange the device credential: {error}"))?;
    let auth = decode_response::<DeviceAuthResponse>(auth_response, "device credential exchange").await?;

    let plans_response = client
        .get(format!("{base}/v1/device/service-plans"))
        .bearer_auth(&auth.token)
        .send()
        .await
        .map_err(|error| format!("Could not pull service plans: {error}"))?;
    let plans = decode_response::<ServicePlanList>(plans_response, "service-plan pull").await?;

    let presentations_response = client
        .get(format!("{base}/v1/device/presentations"))
        .bearer_auth(&auth.token)
        .send()
        .await
        .map_err(|error| format!("Could not pull presentation metadata: {error}"))?;
    let presentations =
        decode_response::<PresentationList>(presentations_response, "presentation pull").await?;

    let referenced = referenced_presentation_ids(&plans.service_plans);
    let mut presentation_details = HashMap::new();
    for presentation_id in referenced.into_iter().take(MAX_PRESENTATION_DETAILS) {
        let response = client
            .get(format!(
                "{base}/v1/device/presentations/{}",
                presentation_id
            ))
            .bearer_auth(&auth.token)
            .send()
            .await
            .map_err(|error| format!("Could not pull presentation {presentation_id}: {error}"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let detail = decode_response::<PresentationDetail>(
            response,
            &format!("presentation {presentation_id} pull"),
        )
        .await?;
        presentation_details.insert(presentation_id, detail.presentation);
    }

    Ok(PlatformSyncResult {
        organization: auth.organization,
        device: auth.device,
        expires_at: auth.expires_at,
        service_plans: plans.service_plans,
        plan_cursor: plans.cursor,
        presentations: presentations.presentations,
        presentation_cursor: presentations.cursor,
        presentation_details,
    })
}

async fn decode_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = body.trim();
        return Err(if body.is_empty() {
            format!("{context} failed with HTTP {status}.")
        } else {
            format!("{context} failed with HTTP {status}: {body}")
        });
    }
    response
        .json::<T>()
        .await
        .map_err(|error| format!("{context} returned an invalid response: {error}"))
}

fn normalize_api_url(value: &str) -> Result<String, String> {
    let base = value.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("The platform API URL must start with http:// or https://.".to_owned());
    }
    Ok(base.to_owned())
}

fn referenced_presentation_ids(plans: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for plan in plans {
        let Some(items) = plan.get("items").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if item.get("type").and_then(Value::as_str) != Some("presentation") {
                continue;
            }
            let Some(source_id) = item.get("sourceId").and_then(Value::as_str) else {
                continue;
            };
            if !source_id.trim().is_empty() && seen.insert(source_id.to_owned()) {
                result.push(source_id.to_owned());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_platform_urls() {
        assert_eq!(
            normalize_api_url(" http://localhost:8787/ ").unwrap(),
            "http://localhost:8787"
        );
        assert!(normalize_api_url("localhost:8787").is_err());
        assert!(normalize_api_url("").is_err());
    }

    #[test]
    fn deduplicates_referenced_presentations() {
        let plans = vec![
            serde_json::json!({
                "items": [
                    { "type": "presentation", "sourceId": "pres-1" },
                    { "type": "scripture", "reference": "John 3:16" },
                ],
            }),
            serde_json::json!({
                "items": [
                    { "type": "presentation", "sourceId": "pres-1" },
                    { "type": "presentation", "sourceId": "pres-2" },
                ],
            }),
        ];
        assert_eq!(
            referenced_presentation_ids(&plans),
            vec!["pres-1".to_owned(), "pres-2".to_owned()]
        );
    }
}
