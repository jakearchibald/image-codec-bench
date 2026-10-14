// Expose the resolved jixel version and git rev to `cjixel --version`, so
// bumping the pin changes the bench's cache key without editing the source.
fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    let block = lock.split("[[package]]").find(|b| b.contains("name = \"jixel\"")).unwrap_or("");
    let field = |key: &str| {
        block.lines().find_map(|l| l.strip_prefix(key)).map(|v| v.trim_matches(|c| c == '"' || c == ' ' || c == '=').to_string())
    };
    let version = field("version").unwrap_or_else(|| "unknown".into());
    let rev = field("source").and_then(|s| s.rsplit('#').next().map(|r| r[..r.len().min(7)].to_string())).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=JIXEL_VERSION={version}");
    println!("cargo:rustc-env=JIXEL_REV={rev}");
}
