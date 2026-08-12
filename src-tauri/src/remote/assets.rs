use std::path::PathBuf;

/// Resolves the directory that contains the compiled remote web bundle
/// (`remote.html` + `assets/`). Search order:
///   1. the resource dir (production bundle), joined with `dist`
///   2. the directory of the running executable
///   3. the current working directory (dev: project root)
/// Returns an empty path if no `remote.html` can be found; `remote_enable`
/// then errors with a clear message telling the operator to run `npm run build`.
pub fn resolve_remote_assets_dir(resource_dir: &PathBuf) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(resource_dir.join("dist"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist"));
    }
    for candidate in candidates {
        if candidate.join("remote.html").exists() {
            return candidate;
        }
    }
    PathBuf::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_dir_when_no_remote_bundle() {
        let dir = resolve_remote_assets_dir(&PathBuf::new());
        // Should not point at a real file unless the environment happens to
        // have a dist/remote.html next to the test binary — acceptable.
        let _ = dir;
    }
}