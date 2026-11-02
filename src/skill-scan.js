import path from 'node:path';
import { readSkillFiles } from './skill-catalog-audit.js';
import { SECRET_PATTERNS } from './sensitive-data.js';

// Offline content review of a skill. Reads bytes only: nothing here executes, imports or fetches the skill.

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.ps1']);
const SEVERITY = {
  'unicode-oculto': 'bloqueo', credencial: 'bloqueo', 'descarga-y-ejecuta': 'bloqueo', exfiltracion: 'bloqueo',
  'instruccion-oculta': 'aviso', inyeccion: 'aviso', 'comando-peligroso': 'aviso', ofuscacion: 'aviso',
  red: 'info'
};

// Zero width, bidirectional controls and tag characters. U+200D and U+FEFF have their own rules below.
const HIDDEN = /[​‌‎‏⁠-⁤‪-‮⁦-⁩\u{E0000}-\u{E007F}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const INTERPRETER = String.raw`(?:(?:sudo\s+)?(?:ba|z|da)?sh\b|python3?\b|node\b|perl\b|ruby\b|iex\b|Invoke-Expression\b)`;
// Only concrete secret formats: the generic "password: ..." assignment fires on every code example in a skill.
const CREDENTIAL_PATTERNS = SECRET_PATTERNS.filter(({ name }) => name !== 'asignación sensible').map(({ pattern }) => pattern);
const URL_WITH_PASSWORD = /https?:\/\/[^\s/:@]+:[^\s/@]+@/i;
const hasCredential = line => CREDENTIAL_PATTERNS.some(re => re.test(line)) || URL_WITH_PASSWORD.test(line);
const DOWNLOAD_EXEC = [
  new RegExp(String.raw`\b(?:curl|wget|iwr|Invoke-WebRequest|irm)\b[^\n|]*\|\s*${INTERPRETER}`, 'i'),
  new RegExp(String.raw`\bbase64\s+(?:-d|--decode|-D)\b[^\n|]*\|\s*${INTERPRETER}`, 'i')
];
const SENSITIVE_READ = /~\/\.ssh\b|\$HOME\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|~\/\.aws\b|\.aws\/credentials|(?:^|[\s"'/])\.env\b|\bKeychain\b|security\s+find-generic-password|process\.env\b|os\.environ\b|\bprintenv\b/i;
const NETWORK_SEND = /\bcurl\b[^\n]*(?:\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file)|\bwget\b[^\n]*--post-(?:data|file)|\bfetch\s*\([^\n]*method\s*:\s*['"]POST|\brequests\.(?:post|put)\s*\(|\b(?:nc|ncat|netcat)\s+[\w.-]+\s+\d+|\baxios\.post\s*\(/i;
const NETWORK = /\bcurl\b|\bwget\b|\bfetch\s*\(|\brequests\.\w+\s*\(|\burllib\b|\bhttps?\.request\s*\(|\baxios\b|\bInvoke-WebRequest\b|\b(?:nc|ncat|netcat)\s+\S+\s+\d+/i;
const INJECTION = /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions\b|\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\b|\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b|\bsystem\s+prompt\b|\bignora\s+(?:todas\s+)?las\s+instrucciones\s+(?:anteriores|previas)\b|\bno\s+se\s+lo\s+(?:digas|cuentes|menciones)\s+al\s+usuario\b|\bsin\s+que\s+el\s+usuario\s+lo\s+sepa\b/i;
const DANGEROUS = /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\s|$|\*)|~(?:\/?\s|\/?$)|"?\$HOME"?\/?(?:\s|$))|\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+(?:\/(?:\s|$|\*)|~(?:\/?\s|\/?$)|"?\$HOME"?\/?(?:\s|$))|\bsudo\s+\S|\bchmod\s+(?:-R\s+)?777\b|>>?\s*~\/\.(?:bashrc|zshrc|bash_profile|profile|zprofile)\b|~\/\.ssh\/authorized_keys|\bcrontab\s+(?:-\s|-e|\S+\.(?:txt|cron))|\blaunchctl\s+(?:load|bootstrap|submit)\b/i;
const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/;
const EVAL_DECODED = /\b(?:eval|exec|Function)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|bytes\.fromhex|unescape|decodeURIComponent)\b/;
const PROCESS = /\bchild_process\b|\bexecSync\s*\(|\bspawn\s*\(|\bsubprocess\b|\bos\.system\s*\(/;
const FILE_WRITE = /\bwriteFile(?:Sync)?\s*\(|\bfs\.(?:rm|unlink|rename|mkdir)\w*\s*\(|\bopen\s*\([^)]*['"][wa]\+?['"]|\brm\s+-|>\s*[~/\w.]/;

const codepoint = ch => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
const visible = text => text.replace(/[​-‏⁠-⁤‪-‮⁦-⁩﻿\u{E0000}-\u{E007F}]/gu, codepoint);
const excerptOf = line => {
  const shown = visible(line.trim());
  return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
};

function hiddenUnicodeIn(line, isFirstLine) {
  if (HIDDEN.test(line)) return true;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '﻿' && !(isFirstLine && i === 0)) return true;
    if (chars[i] === '‍' && !(PICTO.test(chars[i - 1] ?? '') && PICTO.test(chars[i + 1] ?? ''))) return true;
  }
  return false;
}

function scanText(filePath, text, push, capabilities) {
  const isScript = SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const isMarkdown = /\.(?:md|markdown|mdx)$/i.test(filePath);
  const lines = text.split(/\r?\n/);
  let sensitiveLine = 0;
  let sendLine = 0;
  let networkSeen = false;
  let commentStart = 0;
  let commentText = '';
  lines.forEach((line, index) => {
    const n = index + 1;
    const hit = rule => push(rule, filePath, n, line);
    if (hiddenUnicodeIn(line, index === 0)) hit('unicode-oculto');
    if (hasCredential(line)) hit('credencial');
    if (DOWNLOAD_EXEC.some(re => re.test(line))) hit('descarga-y-ejecuta');
    if (INJECTION.test(line)) hit('inyeccion');
    if (DANGEROUS.test(line)) hit('comando-peligroso');
    if (BASE64_BLOB.test(line) || EVAL_DECODED.test(line) || (isScript && line.length > 1000)) hit('ofuscacion');
    if (SENSITIVE_READ.test(line) && !sensitiveLine) sensitiveLine = n;
    if (NETWORK_SEND.test(line) && !sendLine) sendLine = n;
    if (NETWORK.test(line)) {
      capabilities.network = true;
      if (isScript) capabilities.processes = true;
      if (!networkSeen) { networkSeen = true; hit('red'); }
    }
    if (isScript && (PROCESS.test(line))) capabilities.processes = true;
    if (isScript && FILE_WRITE.test(line)) capabilities.filesystem = true;
    if (isMarkdown) {
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
  if (commentStart && commentText.trim()) push('instruccion-oculta', filePath, commentStart, lines[commentStart - 1]);
  if (isScript && networkSeen) capabilities.processes = true;
  if (sensitiveLine && sendLine) push('exfiltracion', filePath, sendLine, lines[sendLine - 1]);
}

export function scanSkillFiles(files) {
  const findings = [];
  const capabilities = { filesystem: false, processes: false, network: false };
  const push = (rule, file, line, text) => findings.push({ rule, severity: SEVERITY[rule], file, line, excerpt: excerptOf(text) });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let text;
    try {
      text = decoder.decode(file.bytes);
    } catch {
      findings.push({ rule: 'ofuscacion', severity: 'aviso', file: file.path, line: 1, excerpt: 'archivo binario o no UTF-8' });
      continue;
    }
    if (SCRIPT_EXTENSIONS.has(path.extname(file.path).toLowerCase())) capabilities.processes = true;
    scanText(file.path, text, push, capabilities);
  }
  return { blocked: findings.some(f => f.severity === 'bloqueo'), findings, capabilities };
}

export async function scanSkillDirectory(dir) {
  return scanSkillFiles(await readSkillFiles(path.resolve(dir), dir));
}
