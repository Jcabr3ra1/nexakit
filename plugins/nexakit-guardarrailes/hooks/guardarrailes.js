const PELIGRO = 'NEXAKIT_PELIGRO';
const SECRETO = 'NEXAKIT_SECRETO';
const COMMIT = 'NEXAKIT_COMMIT';

const ASIGNACION = /^[a-zA-Z_][a-zA-Z_0-9]*=/u;
const REDIRECCION = /(?:[0-9]*(?:<<<|<<-|<<|>>|>\||>&|<&|<>|>|<)|&>>?)/uy;
const OPERADOR = /(?:&&|\|\||\|&|[;|&\n])/uy;
const FIN_DE_PALABRA = /[\s;|&<>]/u;
const HEREDOC = new Set(['<<', '<<-']);
const ESCRITURA = new Set(['>', '>>', '>|', '&>', '&>>']);
const TUBERIA = new Set(['|', '|&']);

function nombre(ruta) {
  return ruta.split('/').at(-1);
}

// Programas que solo anteponen algo a otro comando: se saltan para analizar el comando real.
// Las opciones de cada uno que consumen la palabra siguiente se listan para no confundirla con el comando.
const ENVOLTORIOS = new Map([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['nice', new Set(['-n'])],
  ['nohup', new Set()],
  ['time', new Set()],
  ['command', new Set()],
  ['exec', new Set()],
]);

function guardarAsignacion(variables, valor) {
  const igual = valor.indexOf('=');
  variables.set(valor.slice(0, igual), valor.slice(igual + 1));
}

function prepararSegmento(palabras, redirecciones, salida) {
  const variables = new Map();
  let inicio = 0;
  while (inicio < palabras.length && ASIGNACION.test(palabras[inicio].literal)) {
    guardarAsignacion(variables, palabras[inicio].valor);
    inicio += 1;
  }

  while (inicio < palabras.length && ENVOLTORIOS.has(nombre(palabras[inicio].valor))) {
    const conValor = ENVOLTORIOS.get(nombre(palabras[inicio].valor));
    inicio += 1;
    while (inicio < palabras.length) {
      const { valor, literal } = palabras[inicio];
      if (ASIGNACION.test(literal)) {
        guardarAsignacion(variables, valor);
        inicio += 1;
      } else if (valor.startsWith('-') && valor !== '-') {
        inicio += conValor.has(valor) ? 2 : 1;
      } else {
        break;
      }
    }
  }

  return { palabras: palabras.slice(inicio), variables, redirecciones, salida };
}

// Lee palabras, operadores y redirecciones de comandos simples. Conserva los datos
// literales de los heredocs y trata las expansiones como texto sin resolver.
function leerBash(comando) {
  let posicion = 0;
  const redireccion = new RegExp(REDIRECCION);
  const operador = new RegExp(OPERADOR);

  function leerCuerpo({ destino, tipo }) {
    const lineas = [];
    while (posicion < comando.length) {
      const salto = comando.indexOf('\n', posicion);
      const fin = salto === -1 ? comando.length : salto;
      let linea = comando.slice(posicion, fin);
      posicion = salto === -1 ? fin : fin + 1;
      if (tipo === '<<-') linea = linea.replace(/^\t+/u, '');
      if (linea === destino.valor) break;
      lineas.push(linea);
    }
    return lineas.join('\n');
  }

  function leerPalabra(cierre, esDelimitador = false) {
    const inicio = posicion;
    let valor = '';
    let comilla = '';
    let dinamica = false;
    while (posicion < comando.length) {
      const caracter = comando[posicion];
      const siguiente = comando[posicion + 1];
      if (!comilla && (caracter === cierre || FIN_DE_PALABRA.test(caracter))) break;

      if (caracter === comilla) {
        comilla = '';
      } else if (!comilla && (caracter === "'" || caracter === '"')) {
        comilla = caracter;
      } else if (caracter === '\\' && siguiente && comilla !== "'" &&
                 (!comilla || ['$', '`', '"', '\\', '\n'].includes(siguiente))) {
        if (siguiente !== '\n') valor += siguiente;
        posicion += 1;
      } else if (!esDelimitador && comilla !== "'" && caracter === '$' && siguiente === '(') {
        const inicioSustitucion = posicion;
        posicion += 2;
        const segmentos = leerSegmentos(')');
        const contenido = leerCatConHeredoc(segmentos);
        if (contenido === null) {
          dinamica = true;
          valor += comando.slice(inicioSustitucion, posicion);
        } else {
          valor += contenido.replace(/\n+$/u, '');
        }
        continue;
      } else if (!esDelimitador && comilla !== "'" && caracter === '`') {
        const inicioSustitucion = posicion;
        posicion += 1;
        while (posicion < comando.length && comando[posicion] !== '`') {
          posicion += comando[posicion] === '\\' && comando[posicion + 1] ? 2 : 1;
        }
        if (comando[posicion] === '`') posicion += 1;
        dinamica = true;
        valor += comando.slice(inicioSustitucion, posicion);
        continue;
      } else {
        if (!esDelimitador && comilla !== "'" && caracter === '$' && /[\w{?*@!#$-]/u.test(siguiente ?? '')) {
          dinamica = true;
        }
        valor += caracter;
      }
      posicion += 1;
    }
    return { valor, literal: comando.slice(inicio, posicion), dinamica };
  }

  function leerSegmentos(cierre) {
    const segmentos = [];
    const pendientes = [];
    let palabras = [];
    let redirecciones = [];

    while (posicion < comando.length) {
      const caracter = comando[posicion];
      if (caracter === cierre) {
        posicion += 1;
        break;
      }
      if (comando.startsWith('\\\n', posicion)) {
        posicion += 2;
        continue;
      }
      if (caracter === '#') {
        const salto = comando.indexOf('\n', posicion);
        posicion = salto === -1 ? comando.length : salto;
        continue;
      }

      redireccion.lastIndex = posicion;
      const signo = redireccion.exec(comando)?.[0];
      if (signo) {
        posicion += signo.length;
        while (comando[posicion] === ' ' || comando[posicion] === '\t') posicion += 1;
        const tipo = signo.replace(/^[0-9]+/u, '');
        const destino = leerPalabra(cierre, HEREDOC.has(tipo));
        if (destino.literal) {
          const descriptor = Number(signo.slice(0, -tipo.length) || (tipo.startsWith('<') ? 0 : 1));
          const entrada = { tipo, destino, descriptor };
          redirecciones.push(entrada);
          if (HEREDOC.has(tipo)) pendientes.push(entrada);
        }
        continue;
      }

      operador.lastIndex = posicion;
      const salida = operador.exec(comando)?.[0];
      if (salida) {
        if (palabras.length || redirecciones.length) {
          segmentos.push(prepararSegmento(palabras, redirecciones, salida));
          palabras = [];
          redirecciones = [];
        }
        posicion += salida.length;
        if (salida === '\n') {
          for (const entrada of pendientes) entrada.cuerpo = leerCuerpo(entrada);
          pendientes.length = 0;
        }
        continue;
      }

      if (/\s/u.test(caracter)) {
        posicion += 1;
        continue;
      }
      palabras.push(leerPalabra(cierre));
    }

    if (palabras.length || redirecciones.length) {
      segmentos.push(prepararSegmento(palabras, redirecciones, ''));
    }
    return segmentos;
  }

  return leerSegmentos();
}

function cuerpoHeredoc(entrada) {
  if (entrada?.cuerpo === undefined) return null;
  const { destino, cuerpo } = entrada;
  const expande = destino.valor === destino.literal;
  return expande && /[\x60$]/u.test(cuerpo) ? null : cuerpo;
}

function leerCatConHeredoc(segmentos) {
  if (segmentos.length !== 1) return null;
  const [{ palabras, redirecciones }] = segmentos;
  if (palabras.length !== 1 || nombre(palabras[0].valor) !== 'cat' || redirecciones.length !== 1) {
    return null;
  }
  return cuerpoHeredoc(ultimaEntrada(redirecciones));
}

function ultimaEntrada(redirecciones) {
  return redirecciones.findLast(({ descriptor }) => descriptor === 0);
}

// Una opción corta con valor consume lo que le sigue en el mismo grupo o la
// palabra siguiente. Las palabras después de -- siempre son argumentos.
function leerOpciones(palabras, cortasConValor = '', largasConValor = [], equivalentes = {}) {
  const opciones = new Map();
  const argumentos = [];
  let finDeOpciones = false;

  function agregar(opcion, valor) {
    const clave = equivalentes[opcion] ?? opcion;
    if (!opciones.has(clave)) opciones.set(clave, []);
    opciones.get(clave).push(valor);
  }

  for (let i = 0; i < palabras.length; i += 1) {
    const palabra = palabras[i];
    const { valor } = palabra;
    if (finDeOpciones || !valor.startsWith('-') || valor === '-') {
      argumentos.push(valor);
    } else if (valor === '--') {
      finDeOpciones = true;
    } else if (valor.startsWith('--')) {
      const igual = valor.indexOf('=');
      const opcion = igual === -1 ? valor : valor.slice(0, igual);
      const valorOpcion = igual === -1
        ? (largasConValor.includes(opcion) ? palabras[++i] : undefined)
        : { valor: valor.slice(igual + 1), dinamica: palabra.dinamica };
      agregar(opcion, valorOpcion);
    } else {
      for (let j = 1; j < valor.length; j += 1) {
        const letra = valor[j];
        if (cortasConValor.includes(letra)) {
          const pegado = valor.slice(j + 1);
          agregar(`-${letra}`, pegado ? { valor: pegado, dinamica: palabra.dinamica } : palabras[++i]);
          break;
        }
        agregar(`-${letra}`, undefined);
      }
    }
  }

  return { opciones, argumentos };
}

const GIT_GLOBALES_CON_VALOR = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env',
]);

function inicioSubcomandoGit(palabras) {
  let i = 1;
  while (i < palabras.length && palabras[i].valor.startsWith('-')) {
    if (GIT_GLOBALES_CON_VALOR.has(palabras[i].valor)) i += 1;
    i += 1;
  }
  return i;
}

const OBJETIVOS_RM = new Set(['', '~', '$HOME', '${HOME}', '.', '..', '*']);

function peligroGit(subcomando, palabras) {
  switch (subcomando) {
    case 'push': {
      const { opciones } = leerOpciones(palabras, 'o', ['--push-option', '--receive-pack', '--repo', '--exec']);
      return opciones.has('-f') || opciones.has('--force') ? 'El push forzaría la actualización remota' : null;
    }
    case 'reset':
      return leerOpciones(palabras).opciones.has('--hard') ? 'El reset descartaría cambios locales' : null;
    case 'clean': {
      const { opciones } = leerOpciones(palabras, 'e', ['--exclude']);
      return opciones.has('-f') && opciones.has('-d') && !opciones.has('-n') && !opciones.has('--dry-run')
        ? 'La limpieza eliminaría archivos y directorios sin seguimiento'
        : null;
    }
    case 'checkout':
    case 'restore': {
      const { opciones, argumentos } = leerOpciones(
        palabras, subcomando === 'checkout' ? 'bB' : 's', ['--source', '--pathspec-from-file', '--conflict'],
      );
      const creaRama = subcomando === 'checkout' && (opciones.has('-b') || opciones.has('-B'));
      // Con --staged y sin --worktree, restore solo saca del área de preparación y no toca los archivos.
      const soloPreparacion = subcomando === 'restore' && (opciones.has('--staged') || opciones.has('-S')) &&
        !opciones.has('--worktree') && !opciones.has('-W');
      return !creaRama && !soloPreparacion && argumentos.includes('.')
        ? 'La operación restauraría todo el árbol de trabajo'
        : null;
    }
    case 'branch': {
      const { opciones, argumentos } = leerOpciones(palabras, '', ['--format', '--sort']);
      return opciones.has('-D') && argumentos.some((rama) => rama === 'main' || rama === 'master')
        ? 'Se eliminaría por la fuerza la rama main o master'
        : null;
    }
    default:
      return null;
  }
}

function peligro({ palabras, variables, salida }, siguiente) {
  if (variables.get(PELIGRO) === '1') return null;
  const [programa, ...args] = palabras;
  switch (nombre(programa?.valor ?? '')) {
    case 'rm': {
      const { opciones, argumentos } = leerOpciones(args);
      const recursivo = opciones.has('-r') || opciones.has('-R') || opciones.has('--recursive');
      const forzado = opciones.has('-f') || opciones.has('--force');
      return recursivo && forzado && argumentos.some((ruta) => ruta && OBJETIVOS_RM.has(ruta.replace(/\/+$/u, '')))
        ? 'El borrado recursivo y forzado afectaría una ruta amplia'
        : null;
    }
    case 'git': {
      const inicio = inicioSubcomandoGit(palabras);
      return peligroGit(palabras[inicio]?.valor, palabras.slice(inicio + 1));
    }
    case 'chmod': {
      const { opciones, argumentos } = leerOpciones(args, '', ['--reference']);
      return (opciones.has('-R') || opciones.has('--recursive')) && argumentos[0] === '777'
        ? 'El cambio recursivo daría todos los permisos a cualquier usuario'
        : null;
    }
    case 'curl': {
      const interprete = nombre(siguiente?.palabras[0]?.valor ?? '');
      return TUBERIA.has(salida) && (interprete === 'sh' || interprete === 'bash')
        ? 'La descarga se ejecutaría directamente en la shell'
        : null;
    }
    default:
      return null;
  }
}

const PATRON_SECRETO = /\b(?:sk-[\w-]{10,}|AKIA[A-Z0-9]{12,}|ghp_\w{20,}|xox[bp]-[\w-]{10,})\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

function esRutaSensible(ruta) {
  if (typeof ruta !== 'string') return false;
  const archivo = ruta.split(/[/\\]/u).at(-1);
  return archivo !== '.env.example' && /^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*|credentials.*)$/u.test(archivo);
}

function contieneSecreto(texto) {
  return typeof texto === 'string' && PATRON_SECRETO.test(texto);
}

function escribeTextoSensible({ palabras, redirecciones }) {
  const programa = nombre(palabras[0]?.valor ?? '');
  const imprime = programa === 'printf' || programa === 'echo';
  return (imprime && palabras.slice(1).some(({ valor }) => contieneSecreto(valor))) ||
    redirecciones.some(({ tipo, destino, cuerpo }) => contieneSecreto(cuerpo) ||
      (tipo === '<<<' && contieneSecreto(destino.valor)));
}

function secretoBash(segmentos, i) {
  const segmento = segmentos[i];
  if (segmento.variables.get(SECRETO) === '1') return null;
  const escrituras = segmento.redirecciones.filter(({ tipo }) => ESCRITURA.has(tipo));
  if (escrituras.length === 0) return null;
  if (escrituras.some(({ destino }) => esRutaSensible(destino.valor))) {
    return 'La redirección escribiría en un archivo reservado para credenciales';
  }

  for (let origen = i; origen >= 0; origen -= 1) {
    if (origen !== i && !TUBERIA.has(segmentos[origen].salida)) break;
    if (escribeTextoSensible(segmentos[origen])) {
      return 'La escritura incluye contenido con apariencia de secreto';
    }
  }
  return null;
}

function secretoEdicion(ruta, textos) {
  if (esRutaSensible(ruta)) return 'La operación escribiría en un archivo reservado para credenciales';
  if (textos.some(contieneSecreto)) return 'La operación incluye contenido con apariencia de secreto';
  return null;
}

const ENCABEZADO = /^(?:feat|fix|docs|style|refactor|test|chore|perf|ci|revert)(?:\([^\s():]+\))?: (\S.*)$/u;
const COAUTORIA = /\bco-authored-by\b/iu;
// Solo las firmas de autoría ("Generado con X", "Generated by X", 🤖). Nombrar una herramienta en el
// mensaje es legítimo: este proyecto trabaja con Claude, Codex y Gemini.
const FIRMA_HERRAMIENTA = /\b(?:generad[oa]s?|generated|cread[oa]s?|created|escrit[oa]s?|written|hech[oa]s?|made)\s+(?:con|por|with|by)\s+\W*(?:chatgpt|claude|codex|copilot|gemini|antigravity|windsurf|openai)\b|🤖/iu;

function mensajeDeCommit({ palabras, redirecciones }) {
  if (nombre(palabras[0]?.valor ?? '') !== 'git') return null;
  const inicio = inicioSubcomandoGit(palabras);
  if (palabras[inicio]?.valor !== 'commit') return null;

  const { opciones } = leerOpciones(palabras.slice(inicio + 1), 'mFCct', [
    '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date',
    '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file',
  ], { '--message': '-m', '--file': '-F' });
  const mensajes = opciones.get('-m') ?? [];
  if (mensajes.length) {
    if (mensajes.some((mensaje) => !mensaje || mensaje.dinamica)) return null;
    // Git separa cada -m con una línea en blanco. La primera determina el encabezado.
    return mensajes.map(({ valor }) => valor).join('\n\n');
  }

  const archivo = opciones.get('-F')?.at(-1)?.valor;
  if (archivo !== '-' && archivo !== '/dev/stdin') return null;
  return cuerpoHeredoc(ultimaEntrada(redirecciones));
}

function formatoCommit(segmento) {
  if (segmento.variables.get(COMMIT) === '1') return null;
  const mensaje = mensajeDeCommit(segmento);
  if (mensaje === null) return null;

  const [encabezado] = mensaje.split(/\r?\n/u, 1);
  const descripcion = ENCABEZADO.exec(encabezado.trimEnd())?.[1];
  if (!descripcion) return 'El encabezado debe seguir el formato tipo(alcance opcional): descripción';
  if (descripcion !== descripcion.toLowerCase()) return 'La descripción debe ir en minúsculas';
  if (descripcion.endsWith('.')) return 'La descripción debe terminar sin punto';
  if ([...encabezado].length > 72) return 'La primera línea supera los 72 caracteres';
  if (COAUTORIA.test(mensaje)) return 'El mensaje incluye un tráiler Co-Authored-By';
  if (FIRMA_HERRAMIENTA.test(mensaje)) return 'El mensaje lleva la firma de una herramienta externa';
  return null;
}

export function motivoBash(comando) {
  if (typeof comando !== 'string') return null;
  const segmentos = leerBash(comando);
  for (let i = 0; i < segmentos.length; i += 1) {
    const segmento = segmentos[i];
    const motivoPeligro = peligro(segmento, segmentos[i + 1]);
    if (motivoPeligro) {
      return `nexakit: comando peligroso. ${motivoPeligro}. Si quieres continuar, pon ${PELIGRO}=1 delante del comando.`;
    }

    const motivoSecreto = secretoBash(segmentos, i);
    if (motivoSecreto) {
      return `nexakit: protección de secretos. ${motivoSecreto}. Si quieres continuar, pon ${SECRETO}=1 delante del comando que redirige al archivo.`;
    }

    const motivoCommit = formatoCommit(segmento);
    if (motivoCommit) {
      return `nexakit: formato del commit. ${motivoCommit}. Si quieres continuar, pon ${COMMIT}=1 delante de git commit.`;
    }
  }
  return null;
}

export function motivoEscritura(ruta, textos) {
  const motivo = secretoEdicion(ruta, textos);
  return motivo ? `nexakit: protección de secretos. ${motivo}. Antes de continuar, confirma con la persona.` : null;
}
