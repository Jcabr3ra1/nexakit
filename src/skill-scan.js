import path from 'node:path';
import { readSkillFiles } from './skill-files.js';
import { SECRET_PATTERNS } from './sensitive-data.js';

// Offline content review of a skill. Reads bytes only: nothing here executes, imports or fetches the skill.

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.ps1']);
const SEVERITY = {
  'unicode-oculto': 'bloqueo', credencial: 'bloqueo', 'descarga-y-ejecuta': 'bloqueo', exfiltracion: 'bloqueo',
  'instruccion-oculta': 'aviso', inyeccion: 'aviso', 'comando-peligroso': 'aviso', ofuscacion: 'aviso',
  red: 'info'
};
// Lines longer than this skip the rules with open-ended wildcards: a crafted 512 KiB line must not hang the scan.
const MAX_RULE_LINE = 4096;

// Zero width, bidirectional controls, tag characters, Arabic letter mark, Mongolian vowel separator,
// Hangul fillers and variation selectors supplement. U+200D and U+FEFF have their own rules below.
const HIDDEN_CLASS = String.raw`​‌‎‏⁠-⁤‪-‮⁦-⁩؜᠎ᅟᅠㅤﾠ\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}`;
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, 'u');
const SHOWN_AS_CODEPOINT = new RegExp(`[${HIDDEN_CLASS}\\u200D\\uFEFF]`, 'gu');
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI_TAIL = /[️\u{1F3FB}-\u{1F3FF}]/u;

// Only concrete secret formats: the generic "password: ..." assignment fires on every code example in a skill.
const CREDENTIAL_PATTERNS = SECRET_PATTERNS.filter(({ name }) => name !== 'asignación sensible').map(({ pattern }) => pattern);
const URL_WITH_PASSWORD = /https?:\/\/[^\s/:@]{1,200}:[^\s/@]{1,200}@/i;

const FETCHER = String.raw`(?:curl|wget|iwr|irm|Invoke-WebRequest)`;
const INTERPRETER = String.raw`(?:(?:sudo(?:\s+-\S+){0,5}\s+)?(?:env\s+)?(?:(?:ba|z|da)?sh|python3?|node|perl|ruby|iex|Invoke-Expression)\b)`;
const DOWNLOAD_EXEC = [
  new RegExp(String.raw`\b${FETCHER}\b[^\n]{0,400}\|\s*${INTERPRETER}`, 'i'),
  new RegExp(String.raw`\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,400}\|\s*${INTERPRETER}`, 'i'),
  new RegExp(String.raw`\b(?:(?:ba|z|da)?sh|python3?|node|perl|ruby|eval|source|iex)\b[^\n]{0,200}(?:\$\(|<\(|\x60)\s*${FETCHER}\b`, 'i')
];
// Linear fallback for long lines: a fetcher plus a pipe into a shell or a fetch inside a substitution.
const LONG_FETCHER = new RegExp(String.raw`\b${FETCHER}\b`, 'i');
const LONG_EXEC = new RegExp(String.raw`\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|(?:\$\(|<\()\s*${FETCHER}\b`, 'i');

const SENSITIVE_READ = /~\/\.ssh\b|\$HOME\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|~\/\.aws\b|\.aws\/credentials|(?:^|[\s"'/])\.env(?!\.(?:example|sample|template|dist)\b)\b|\bKeychain\b|security\s+find-generic-password|process\.env\b|os\.environ\b|\bprintenv\b/i;
const NETWORK_SEND = /\bcurl\b[^\n]{0,400}(?:\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file)|\bwget\b[^\n]{0,400}--post-(?:data|file)|\bfetch\s*\([^\n]{0,400}method\s*:\s*['"]POST|\brequests\.(?:post|put)\s*\(|\b(?:nc|ncat|netcat)\s+[\w.-]{1,200}\s+\d+|\baxios\.post\s*\(/i;
const NETWORK = /\bcurl\b|\bwget\b|\bfetch\s*\(|\brequests\.\w+\s*\(|\burllib\b|\bhttps?\.request\s*\(|\baxios\b|\bInvoke-WebRequest\b|\b(?:nc|ncat|netcat)\s+\S{1,200}\s+\d+/i;
const INJECTION = /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions\b|\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\b|\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b|\bsystem\s+prompt\b|\bignora\s+(?:todas\s+)?las\s+instrucciones\s+(?:anteriores|previas)\b|\bno\s+se\s+lo\s+(?:digas|cuentes|menciones)\s+al\s+usuario\b|\bsin\s+que\s+el\s+usuario\s+lo\s+sepa\b/i;
const DANGEROUS = /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\s|$|\*)|~(?:\/?\s|\/?$)|"?\$HOME"?\/?(?:\s|$))|\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+(?:\/(?:\s|$|\*)|~(?:\/?\s|\/?$)|"?\$HOME"?\/?(?:\s|$))|\bsudo\s+\S|\bchmod\s+(?:-R\s+)?777\b|>>?\s*~\/\.(?:bashrc|zshrc|bash_profile|profile|zprofile)\b|~\/\.ssh\/authorized_keys|\bcrontab\s+(?:-\s|-e|\S+\.(?:txt|cron))|\blaunchctl\s+(?:load|bootstrap|submit)\b/i;
const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/;
const EVAL_DECODED = /\b(?:eval|exec|Function)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|bytes\.fromhex|unescape|decodeURIComponent)\b/;
const PROCESS = /\bchild_process\b|\bexecSync\s*\(|\bspawn\s*\(|\bsubprocess\b|\bos\.system\s*\(/;
const FILE_WRITE = /\bwriteFile(?:Sync)?\s*\(|\bfs\.(?:rm|unlink|rename|mkdir)\w*\s*\(|\bopen\s*\([^)\n]{0,200}['"][wa]\+?['"]|\brm\s+-|>\s*[~/\w.]/;
const FENCE = /^\s{0,3}(?:```|~~~)/;
// Files a skill copies for the user (templates, examples) are material, not code the skill runs.
const MATERIAL_DIR = /^(?:assets|templates|examples?)\//;
const runsCode = filePath => SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !MATERIAL_DIR.test(filePath);

const codepoint = ch => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
const excerptOf = line => {
  const trimmed = line.trim();
  const shown = (trimmed.length > 2000 ? trimmed.slice(0, 2000) : trimmed).replace(SHOWN_AS_CODEPOINT, codepoint);
  return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
};

function hiddenUnicodeIn(line, isFirstLine) {
  if (HIDDEN.test(line)) return true;
  if (!line.includes('‍') && !line.includes('﻿')) return false;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '﻿' && !(isFirstLine && i === 0)) return true;
    if (chars[i] === '‍') {
      // A ZWJ joins two emoji; skin tones and the emoji presentation selector may sit before it.
      let before = i - 1;
      while (before >= 0 && EMOJI_TAIL.test(chars[before])) before--;
      if (!(PICTO.test(chars[before] ?? '') && PICTO.test(chars[i + 1] ?? ''))) return true;
    }
  }
  return false;
}

// Joins shell continuation lines ("\" at the end) so a pipe on the next line is seen with its command.
function logicalLines(lines) {
  const result = [];
  let current = null;
  lines.forEach((line, index) => {
    const text = current ? `${current.text} ${line.trim()}` : line;
    const start = current ? current.start : index + 1;
    if (/\\\s*$/.test(line) && text.length < MAX_RULE_LINE) current = { start, text: text.replace(/\\\s*$/, '') };
    else { result.push({ start, text }); current = null; }
  });
  if (current) result.push(current);
  return result;
}

function scanText(filePath, text, push, capabilities) {
  const isScript = SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const runs = runsCode(filePath);
  const isMarkdown = /\.(?:md|markdown|mdx)$/i.test(filePath);
  const lines = text.split(/\r?\n/);
  // Exfiltration needs a sensitive read and a network send in the same unit: the file for scripts,
  // a fenced code block for Markdown, and a single line for prose and data rows (CSV, JSON), so
  // unrelated documentation does not block.
  const sensitiveUnits = new Set();
  const sendUnits = new Map();
  let fence = 0;
  let inFence = false;
  let networkSeen = false;
  let commentStart = 0;
  let commentText = '';
  lines.forEach((line, index) => {
    const n = index + 1;
    const hit = rule => push(rule, filePath, n, line);
    const long = line.length > MAX_RULE_LINE;
    const fenceLine = isMarkdown && FENCE.test(line);
    if (fenceLine) { inFence = !inFence; if (inFence) fence++; }
    const unit = isScript ? 'file' : isMarkdown && inFence ? `fence-${fence}` : `line-${n}`;
    if (hiddenUnicodeIn(line, index === 0)) hit('unicode-oculto');
    if (CREDENTIAL_PATTERNS.some(re => re.test(line)) || (!long && URL_WITH_PASSWORD.test(line))) hit('credencial');
    if (long && LONG_FETCHER.test(line) && LONG_EXEC.test(line)) hit('descarga-y-ejecuta');
    if (INJECTION.test(line)) hit('inyeccion');
    if (DANGEROUS.test(line)) hit('comando-peligroso');
    if (long || BASE64_BLOB.test(line) || EVAL_DECODED.test(line) || (isScript && line.length > 1000)) hit('ofuscacion');
    if (SENSITIVE_READ.test(line)) sensitiveUnits.add(unit);
    if (!long && NETWORK_SEND.test(line) && !sendUnits.has(unit)) sendUnits.set(unit, n);
    // Capabilities come only from code the skill runs; examples in documentation are reported as `red` info.
    if (NETWORK.test(line)) {
      if (runs) capabilities.network = true;
      if (!networkSeen) { networkSeen = true; hit('red'); }
    }
    if (runs && PROCESS.test(line)) capabilities.processes = true;
    if (runs && !long && FILE_WRITE.test(line)) capabilities.filesystem = true;
    // An HTML comment inside a fenced code block is shown to the reader, so it is not hidden.
    if (isMarkdown && (!inFence || commentStart) && !fenceLine) {
      let rest = line;
      while (rest.length) {
        if (!commentStart) {
          const open = rest.indexOf('<!--');
          if (open < 0) break;
          commentStart = n;
          commentText = '';
          rest = rest.slice(open + 4);
        }
        const close = rest.indexOf('-->');
        if (close < 0) { commentText += rest; break; }
        commentText += rest.slice(0, close);
        if (commentText.trim()) push('instruccion-oculta', filePath, commentStart, lines[commentStart - 1]);
        commentStart = 0;
        rest = rest.slice(close + 3);
      }
      if (commentStart && n !== commentStart) commentText += ' ';
    }
  });
  for (const { start, text: logical } of logicalLines(lines)) {
    if (logical.length <= MAX_RULE_LINE && DOWNLOAD_EXEC.some(re => re.test(logical))) push('descarga-y-ejecuta', filePath, start, lines[start - 1]);
  }
  if (commentStart && commentText.trim()) push('instruccion-oculta', filePath, commentStart, lines[commentStart - 1]);
  const exfil = [...sendUnits].find(([unit]) => sensitiveUnits.has(unit));
  if (exfil) push('exfiltracion', filePath, exfil[1], lines[exfil[1] - 1]);
}

export function scanSkillFiles(files) {
  const findings = [];
  const capabilities = { filesystem: false, processes: false, network: false };
  const push = (rule, file, line, text) => findings.push({ rule, severity: SEVERITY[rule], file, line, excerpt: excerptOf(text) });
  // ignoreBOM keeps a leading U+FEFF in the text, so a second one right after it is still caught.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let text;
    try {
      text = decoder.decode(file.bytes);
    } catch {
      findings.push({ rule: 'ofuscacion', severity: 'aviso', file: file.path, line: 1, excerpt: 'archivo binario o no UTF-8' });
      continue;
    }
    if (runsCode(file.path)) capabilities.processes = true;
    scanText(file.path, text, push, capabilities);
  }
  return { blocked: findings.some(f => f.severity === 'bloqueo'), findings, capabilities };
}

export async function scanSkillDirectory(dir) {
  return scanSkillFiles(await readSkillFiles(path.resolve(dir), dir));
}
