import { motivoBash, motivoEscritura } from './guardarrailes.js';

export function register(on) {
  on('tool.call', async ($, e, next) => {
    let deny;
    try {
      switch (e.tool) {
        case 'Bash':
          deny = motivoBash(e.command);
          break;
        case 'Write':
          deny = motivoEscritura(e.file_path, [e.content]);
          break;
        case 'Edit':
          deny = motivoEscritura(e.file_path, [e.new_string]);
          break;
        case 'MultiEdit':
          deny = motivoEscritura(e.file_path, e.edits.map(({ new_string }) => new_string));
          break;
      }
    } catch {
      // Un fallo del análisis deja pasar la llamada al motor.
    }
    return deny ? { deny } : next(e);
  });
}
