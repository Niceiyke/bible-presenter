use crate::state::AppState;
use crate::store::{BibleStore, Verse};
use quick_xml::events::Event;
use quick_xml::name::QName;
use quick_xml::Reader;
use regex::Regex;
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::State;

const MAX_DOCX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_VERSES_PER_PRAYER: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrayerGuideImport {
    pub source_name: String,
    pub days: Vec<PrayerDay>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrayerDay {
    pub title: String,
    pub prayers: Vec<PrayerPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrayerPoint {
    pub number: u32,
    pub text: String,
    pub reference: String,
    pub verses: Vec<Verse>,
}

#[derive(Debug)]
struct ParsedPrayer {
    number: u32,
    text: String,
    reference: String,
}

#[derive(Debug)]
struct ParsedDay {
    title: String,
    prayers: Vec<ParsedPrayer>,
}

#[tauri::command]
pub async fn import_prayer_docx(
    state: State<'_, AppState>,
    path: String,
    version: String,
) -> Result<PrayerGuideImport, String> {
    let path = validate_docx_path(&path)?;
    let source_name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Prayer Guide")
        .to_string();
    let paragraphs = extract_docx_paragraphs(&path)?;
    let parsed = parse_prayer_guide(&paragraphs)?;
    Ok(verify_prayer_guide(
        source_name,
        parsed,
        &state.store,
        &version,
    ))
}

fn validate_docx_path(raw: &str) -> Result<PathBuf, String> {
    if raw.contains('\0') {
        return Err("Invalid DOCX path.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Prayer DOCX path must be absolute.".into());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
    {
        return Err("Choose a .docx prayer document.".into());
    }
    let canonical = std::fs::canonicalize(&path)
        .map_err(|_| "The selected prayer document could not be opened.".to_string())?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DOCX_BYTES {
        return Err("The selected prayer document is invalid or too large.".into());
    }
    Ok(canonical)
}

fn extract_docx_paragraphs(path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("Could not open the prayer document: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("The selected file is not a readable DOCX document: {e}"))?;
    let mut entry = archive
        .by_name("word/document.xml")
        .map_err(|_| "The DOCX document does not contain Word document text.".to_string())?;
    if entry.size() > MAX_DOCUMENT_XML_BYTES {
        return Err("The prayer document text is too large to import.".into());
    }
    let mut xml = String::with_capacity(entry.size() as usize);
    entry
        .read_to_string(&mut xml)
        .map_err(|e| format!("Could not read the prayer document text: {e}"))?;
    parse_document_xml(&xml)
}

fn parse_document_xml(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs = Vec::new();
    let mut paragraph = String::new();
    let mut in_paragraph = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.name() == QName(b"w:p") => {
                in_paragraph = true;
                paragraph.clear();
            }
            Ok(Event::Text(event)) if in_paragraph => {
                let decoded = event
                    .decode()
                    .map_err(|e| format!("Could not decode DOCX text: {e}"))?;
                paragraph.push_str(&decoded);
            }
            Ok(Event::Empty(event)) if in_paragraph && event.name() == QName(b"w:tab") => {
                paragraph.push(' ');
            }
            Ok(Event::Empty(event)) if in_paragraph && event.name() == QName(b"w:br") => {
                paragraph.push(' ');
            }
            Ok(Event::End(event)) if event.name() == QName(b"w:p") => {
                in_paragraph = false;
                let clean = normalize_text(&paragraph);
                if !clean.is_empty() {
                    paragraphs.push(clean);
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("The DOCX document contains invalid XML: {error}")),
        }
    }
    Ok(paragraphs)
}

fn normalize_text(value: &str) -> String {
    value
        .replace('\u{fffd}', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn day_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b")
            .expect("valid day regex")
    })
}

fn weekday_any_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b")
            .expect("valid weekday regex")
    })
}

fn intercession_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^Intercession\s*(\d+)\s*:?\s*(.*)$").expect("valid intercession regex")
    })
}

fn reference_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:[1-3]\s*)?[A-Za-z]+(?:\s+[A-Za-z]+)?\s+\d+:\d+(?:-\d+)?$")
            .expect("valid Scripture reference regex")
    })
}

fn trailing_reference_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\s*-\s*(?:[1-3]\s*)?[A-Za-z.]+(?:\s+[A-Za-z.]+)?\s*\d+:\d+(?:-\d+)?\s*$")
            .expect("valid trailing reference regex")
    })
}

fn parse_prayer_guide(paragraphs: &[String]) -> Result<Vec<ParsedDay>, String> {
    let mut days = Vec::<ParsedDay>::new();
    let mut current_day: Option<usize> = None;
    let mut pending: Option<(usize, usize)> = None;

    for paragraph in paragraphs {
        if day_regex().is_match(paragraph) && !looks_like_date_range(paragraph) {
            days.push(ParsedDay {
                title: normalize_day_title(paragraph),
                prayers: Vec::new(),
            });
            current_day = Some(days.len() - 1);
            pending = None;
            continue;
        }

        if let Some(captures) = intercession_regex().captures(paragraph) {
            let Some(day_index) = current_day else {
                continue;
            };
            let number = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<u32>().ok())
                .unwrap_or((days[day_index].prayers.len() + 1) as u32);
            let text = captures
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or("")
                .trim();
            days[day_index].prayers.push(ParsedPrayer {
                number,
                text: trailing_reference_regex()
                    .replace(text, "")
                    .trim()
                    .to_string(),
                reference: String::new(),
            });
            pending = Some((day_index, days[day_index].prayers.len() - 1));
            continue;
        }

        if reference_regex().is_match(paragraph) {
            if let Some((day_index, prayer_index)) = pending.take() {
                days[day_index].prayers[prayer_index].reference = paragraph.clone();
            }
        }
    }

    days.retain(|day| !day.prayers.is_empty());
    if days.is_empty() {
        return Err("No daily intercession sections were found in the DOCX document.".into());
    }
    Ok(days)
}

fn looks_like_date_range(value: &str) -> bool {
    value.contains('-')
        && weekday_any_regex()
            .find_iter(value)
            .map(|matched| matched.as_str().to_lowercase())
            .collect::<std::collections::HashSet<_>>()
            .len()
            > 1
}

fn normalize_day_title(value: &str) -> String {
    let ordinal_month = Regex::new(r"(?i)(\d+(?:st|nd|rd|th))([A-Z][a-z]+)")
        .expect("valid date spacing regex")
        .replace_all(value, "$1 $2");
    let month_day = Regex::new(r"(?i)([A-Z][a-z]+)(\d+(?:st|nd|rd|th))")
        .expect("valid date spacing regex")
        .replace_all(&ordinal_month, "$1 $2");
    let year_spacing = Regex::new(r"([A-Za-z])(\d{4})")
        .expect("valid year spacing regex")
        .replace_all(&month_day, "$1 $2");
    normalize_text(&year_spacing)
}

fn verify_prayer_guide(
    source_name: String,
    parsed: Vec<ParsedDay>,
    bible: &BibleStore,
    version: &str,
) -> PrayerGuideImport {
    let mut warnings = Vec::new();
    let days = parsed
        .into_iter()
        .map(|day| PrayerDay {
            title: day.title.clone(),
            prayers: day
                .prayers
                .into_iter()
                .map(|prayer| {
                    let verses = bible
                        .detect_verses_by_ref(&prayer.reference, version)
                        .into_iter()
                        .take(MAX_VERSES_PER_PRAYER)
                        .collect::<Vec<_>>();
                    if verses.is_empty() {
                        warnings.push(format!(
                            "{} intercession {}: could not verify '{}'.",
                            day.title, prayer.number, prayer.reference
                        ));
                    }
                    PrayerPoint {
                        number: prayer.number,
                        text: prayer.text,
                        reference: prayer.reference,
                        verses,
                    }
                })
                .collect(),
        })
        .collect();
    PrayerGuideImport {
        source_name,
        days,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_daily_prayers_and_ignores_document_date_range() {
        let paragraphs = vec![
            "Monday, November 2nd - Friday, November 6th, 2026".into(),
            "Monday, 2ndNovember2026".into(),
            "Intercession 1: Father, thank You for Your Word - Psa. 118:23".into(),
            "Ps 118:23".into(),
            "23 This is the Lord's doing.".into(),
            "Tuesday, 3rdNovember2026".into(),
            "Intercession 2Father, establish every convert - 1 Kgs. 19:7-8".into(),
            "1 Kings 19:7-8".into(),
        ];
        let days = parse_prayer_guide(&paragraphs).expect("guide should parse");
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].title, "Monday, 2nd November 2026");
        assert_eq!(days[0].prayers[0].text, "Father, thank You for Your Word");
        assert_eq!(days[0].prayers[0].reference, "Ps 118:23");
        assert_eq!(days[1].prayers[0].text, "Father, establish every convert");
    }

    #[test]
    fn extracts_paragraph_text_from_wordprocessing_xml() {
        let xml = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Intercession </w:t></w:r><w:r><w:t>1</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(
            parse_document_xml(xml).expect("xml should parse"),
            vec!["Intercession 1"]
        );
    }

    #[test]
    #[ignore = "uses an operator-supplied DOCX fixture"]
    fn real_prayer_docx_probe() {
        let path = std::env::var("WORDLYTE_PRAYER_DOCX_TEST_PATH")
            .expect("set WORDLYTE_PRAYER_DOCX_TEST_PATH to a prayer .docx file");
        let path = validate_docx_path(&path).expect("fixture path should be valid");
        let paragraphs = extract_docx_paragraphs(&path).expect("fixture text should extract");
        let days = parse_prayer_guide(&paragraphs).expect("fixture guide should parse");
        assert_eq!(days.len(), 5);
        assert!(days.iter().all(|day| day.prayers.len() == 5));
        assert!(days
            .iter()
            .flat_map(|day| &day.prayers)
            .all(|prayer| !prayer.text.is_empty() && !prayer.reference.is_empty()));
    }
}
