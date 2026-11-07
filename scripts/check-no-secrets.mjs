import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !/(^|\\|\/)(node_modules|dist|target|\.git)(\\|\/)/.test(file));

const patterns = [
  { name: "OpenAI-style key", expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Google API key", expression: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "provider key assignment", expression: /(?:api[_-]?key|secret|access[_-]?token|authorization)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/gi },
  { name: "Bearer token literal", expression: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
];

const findings = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.expression)) {
      const line = text.slice(0, match.index).split("\n").length;
      const value = match[0];
      if (/YOUR_|CHANGE_ME|EXAMPLE|PLACEHOLDER|process\.env|secure_storage/i.test(value)) continue;
      findings.push(`${file}:${line}: ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential credentials found in tracked files:");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error("Remove the credential, revoke it with the provider, and use secure runtime configuration.");
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} tracked files checked).`);
