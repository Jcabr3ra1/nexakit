// Tacha los secretos evidentes de un detalle antes de mostrarlo o guardarlo en disco.
export function sinSecretos(texto) {
  return String(texto)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/giu, '$1***@')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=([^\s"']+)/giu, '$1=***')
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1***')
    .replace(/(--?(?:password|passwd|token|secret|api-key)[= ])[^\s"']+/giu, '$1***');
}

