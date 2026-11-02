// La marca de nexakit en la terminal: el logo de píxeles, la paleta y el nivel de color que admite cada terminal.
// Sin color (NO_COLOR, salida que no es una terminal, TERM=dumb) no hay logo ni paleta: se usa texto plano.

// Fuente de píxeles de 5×7. Cada letra es una columna de 5 píxeles más 1 de separación.
const GLYPHS = {
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};
const WORD = 'NEXAKIT';
const HEIGHT = 7;
const FACE = [...Array(HEIGHT).keys()].map((row) =>
  [...[...WORD].map((letter) => GLYPHS[letter][row]).join('0')].map(Number),
);
const PIXEL_WIDTH = FACE[0].length;

// La sombra cae un píxel a la derecha y uno abajo, como en el logo original: 41 columnas de letras + 1 de sombra.
export const LOGO_WIDTH = PIXEL_WIDTH + 1;
export const LOGO_ROWS = Math.ceil((HEIGHT + 1) / 2);

const pixel = (row, column, shadow) => {
  if (FACE[row]?.[column]) return 'face';
  return shadow && FACE[row - 1]?.[column - 1] ? 'shadow' : null;
};

// Dos píxeles por celda con medios bloques: arriba ▀, abajo ▄, los dos █.
export function logoArt() {
  const lines = [];
  for (let row = 0; row < HEIGHT + 1; row += 2) {
    let line = '';
    for (let column = 0; column < PIXEL_WIDTH; column++) {
      const top = pixel(row, column, false);
      const bottom = pixel(row + 1, column, false);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// none: sin color · 16: colores básicos · 256: paleta de 256 · truecolor: 24 bits.
export function colorLevel(output, env = process.env) {
  if (!output?.isTTY || env.NO_COLOR || env.TERM === 'dumb') return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  if (/256color/u.test(env.TERM ?? '')) return '256';
  return '16';
}
// Quien llama con el antiguo true/false sigue funcionando.
export const levelOf = (color) => (color === true ? 'truecolor' : !color ? 'none' : color);

const PALETTE = {
  truecolor: {
    face: { fg: '38;2;236;232;244', bg: '48;2;236;232;244' },
    shadow: { fg: '38;2;62;48;110', bg: '48;2;62;48;110' },
    accent: '38;2;167;139;250',
    soft: '38;2;196;181;253',
    chip: '48;2;54;44;98;38;2;221;214;254',
  },
  256: {
    face: { fg: '38;5;255', bg: '48;5;255' },
    shadow: { fg: '38;5;60', bg: '48;5;60' },
    accent: '38;5;141',
    soft: '38;5;183',
    chip: '48;5;60;38;5;189',
  },
  16: {
    face: { fg: '97', bg: '107' },
    shadow: { fg: '35', bg: '45' },
    accent: '95',
    soft: '35',
    chip: '45;97',
  },
};

export function renderLogo(level) {
  const colors = PALETTE[level];
  if (!colors) return null;
  const lines = [];
  for (let row = 0; row < HEIGHT + 1; row += 2) {
    let line = '';
    for (let column = 0; column < LOGO_WIDTH; column++) {
      const top = pixel(row, column, true);
      const bottom = pixel(row + 1, column, true);
      if (!top && !bottom) line += ' ';
      else if (!top) line += `\x1b[${colors[bottom].fg}m▄\x1b[0m`;
      else if (!bottom) line += `\x1b[${colors[top].fg}m▀\x1b[0m`;
      else if (top === bottom) line += `\x1b[${colors[top].fg}m█\x1b[0m`;
      else line += `\x1b[${colors[top].fg};${colors[bottom].bg}m▀\x1b[0m`;
    }
    lines.push(line);
  }
  return lines;
}

// Los estilos de texto de las pantallas. Sin color, cada uno devuelve el texto tal cual.
export function paint(level) {
  const colors = PALETTE[level];
  if (!colors) {
    const same = (text) => String(text);
    return { accent: same, soft: same, chip: same, bold: same, dim: same, green: same, yellow: same, red: same };
  }
  const wrap = (open, close) => (text) => `\x1b[${open}m${text}\x1b[${close}m`;
  return {
    accent: (text) => `\x1b[1;${colors.accent}m${text}\x1b[22;39m`,
    soft: wrap(colors.soft, 39),
    chip: (text) => `\x1b[${colors.chip}m ${text} \x1b[0m`,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
  };
}
