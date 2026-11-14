/** Entrecomilla un valor para un shell POSIX: comillas simples, con `'\''` para las comillas simples internas. */
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
