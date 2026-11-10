# Project Memory Allow-dir

`project-memory allow-dir` (o `npx nexakit memoria allow-dir`) declara la bóveda de
memoria como carpeta permitida de Claude Code en un proyecto. Sin esto, si
`permissions.blockReadsOutsideWorkingDirectories` está activo, Claude no puede
leer ni escribir notas en la bóveda desde ese proyecto, y los cierres de memoria
(`cerrar-memoria`, `project-handoff`) se quedan a medias.

La vista previa es el comportamiento predeterminado; solo `--apply` escribe.

## Uso

```bash
project-memory allow-dir /ruta/a/la/memoria            # vista previa
project-memory allow-dir /ruta/a/la/memoria --apply    # aplica
project-memory allow-dir /ruta/a/la/memoria --json
```

Después de aplicar, reinicia la sesión de Claude Code.

`npx nexakit` lo hace por ti: si eliges Claude Code y el proyecto tiene memoria,
la confirmación incluye «Permitir a Claude Code abrir la memoria desde este
proyecto» y lo aplica con el resto. Si hay un conflicto, solo avisa.

## Qué cambia

1. Añade la ruta de la bóveda a `permissions.additionalDirectories` de
   `.claude/settings.local.json`, en el repositorio fuente que declara el
   manifiesto (`source.repositoryPath`). Conserva el resto del archivo.
2. Si git no ignora ese archivo, lo excluye en `.git/info/exclude`: solo en tu
   copia, no se sube. La ruta de tu equipo no debe llegar a un commit.

## Qué concede y qué no

- Las **lecturas** de la bóveda dejan de pedir permiso.
- Las **escrituras** siguen el modo de permisos de la sesión: en modo manual cada
  edición sigue pidiéndolo; en `acceptEdits` se aprueban solas dentro de esa carpeta.
- No toca `~/.claude/settings.json` ni quita `blockReadsOutsideWorkingDirectories`:
  abre una sola carpeta, no desactiva la protección.
- No cambia el MCP de memoria, que sigue siendo de solo lectura, ni la bóveda.
- Solo existe para Claude Code (`--agent claude`).

## Conflictos (no escribe nada)

- El archivo `.claude/settings.local.json` no es JSON válido o no es un objeto.
- git ya sigue ese archivo (deja de seguirlo con `git rm --cached`).
- `.claude` o el archivo son enlaces simbólicos: Claude Code trataría estos
  ajustes como del repositorio y exigiría confianza.
- La bóveda o el repositorio fuente no existen.

Repetir la orden con la bóveda ya declarada da `unchanged`.
