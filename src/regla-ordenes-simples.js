// Regla común de los subagentes con shell: las órdenes que Claude Code no puede analizar (cd encadenado, `;`,
// paréntesis, subshells) hacen que pida permiso en cada llamada. Los agentes de plugins/niveles/agents/*.md
// llevan este mismo texto (lo comprueba test/regla-ordenes-simples.test.js); Codex lo recibe desde aquí.
export const REGLA_ORDENES_SIMPLES = 'Una orden por llamada al shell. Usa rutas absolutas en lugar de `cd`. No encadenes con `;`, `&&` ni `||`, y no uses paréntesis ni subshells `( … )`. Un `|` hacia `head`, `tail` o `grep` está permitido. Para leer y buscar, usa las herramientas de lectura y búsqueda en lugar de `cat`, `grep` o `ls` cuando existan. Las llamadas independientes se lanzan en paralelo, no encadenadas.';
