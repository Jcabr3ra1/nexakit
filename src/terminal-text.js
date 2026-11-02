// Text helpers shared by nexakit's terminal screens: color that honours NO_COLOR, the width a character really
// takes in a terminal cell, wrapping, and cutting a line to fit.
export function style(colorEnabled) {
  if (!colorEnabled) {
    const plain = text => String(text);
    return { bold: plain, cyan: plain, green: plain, yellow: plain, dim: plain, red: plain, magenta: plain };
  }
  const wrap = (open, close) => text => `\x1b[${open}m${text}\x1b[${close}m`;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39)
  };
}

export function cellWidth(text) {
  return [...text].reduce((width, char) => {
    const cp = char.codePointAt(0);
    if (/\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f) return width;
    const wide = /\p{Extended_Pictographic}/u.test(char)
      || (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
        || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
        || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19)
        || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
        || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000));
    return width + (wide ? 2 : 1);
  }, 0);
}

export function wrapText(text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s*\S+/gu) ?? []) {
      const word = token.trimStart();
      let gap = token.slice(0, token.length - word.length);
      if (line && cellWidth(line + gap + word) > width) {
        lines.push(line.trimEnd());
        line = '';
        gap = '';
      }
      for (const char of gap + word) {
        if (cellWidth(line + char) > width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Cuts a line to `width` cells, ending in "…" when something was cut.
export function fitLine(text, width) {
  if (cellWidth(text) <= width) return text;
  let line = '';
  for (const char of text) {
    if (cellWidth(line + char) > width - 1) break;
    line += char;
  }
  return `${line}…`;
}
