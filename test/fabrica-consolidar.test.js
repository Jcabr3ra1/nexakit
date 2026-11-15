import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { consolidar, consolidadoMarkdown, escribirConsolidado } from '../dist/fabrica/consolidar.js';

const h = (estacion, gravedad, archivo, linea, extra = {}) => ({
  estacion,
  gravedad,
  archivo,
  linea,
  categoria: 'bug',
  hallazgo: `fallo ${estacion}`,
  evidencia: 'x',
  propuesta: 'arreglar',
  confianza: 'media',
  ...extra,
});
const informe = (...hallazgos) => ({ hallazgos, resumen: 'r' });
const estadoBase = (extra = {}) => ({ id: 'fab-1', dir: '/x', fase: 'terminado', estaciones: [], escriturasDetectadas: [], ...extra });

test('funde hallazgos cercanos, conserva estaciones y la gravedad mayor', () => {
  const lista = consolidar([
    { estacion: 'seguridad', informe: informe(h('seguridad', 'media', 'a.ts', 10)) },
    { estacion: 'codigo', informe: informe(h('codigo', 'alta', 'a.ts', 13), h('codigo', 'baja', 'a.ts', 40)) },
  ]);
  assert.equal(lista.length, 2);
  assert.equal(lista[0].gravedad, 'alta');
  assert.deepEqual(lista[0].estaciones, ['seguridad', 'codigo']);
  assert.equal(lista[1].linea, 40);
});

test('no funde a más de 3 líneas ni con otra categoría', () => {
  const lista = consolidar([
    { estacion: 'seguridad', informe: informe(h('seguridad', 'alta', 'a.ts', 10), h('seguridad', 'alta', 'a.ts', 14), h('seguridad', 'alta', 'a.ts', 10, { categoria: 'otra' })) },
  ]);
  assert.equal(lista.length, 3);
});

test('ordena por gravedad y luego por archivo; admite hallazgos de Claude', () => {
  const lista = consolidar(
    [{ estacion: 'codigo', informe: informe(h('codigo', 'baja', 'a.ts', 1), h('codigo', 'alta', 'z.ts', 1), h('codigo', 'alta', 'b.ts', 1)) }],
    [h('arquitectura', 'media', 'c.ts', null)],
  );
  assert.deepEqual(lista.map((x) => x.archivo), ['b.ts', 'z.ts', 'c.ts', 'a.ts']);
});

test('markdown: tabla, no revisado y escapado', () => {
  const lista = consolidar([{ estacion: 'codigo', informe: informe(h('codigo', 'alta', 'a.ts', 1, { hallazgo: 'a|b\nc', propuesta: '<x>' })) }]);
  const md = consolidadoMarkdown(
    'fab-1',
    lista,
    estadoBase({
      estaciones: [
        { estacion: 'seguridad', estado: 'fallida', motivo: 'tiempo agotado' },
        { estacion: 'pruebas', estado: 'sin-modelo' },
        { estacion: 'codigo', estado: 'ok' },
      ],
      escriturasDetectadas: ['src/a.ts'],
    }),
    [{ estacion: 'codigo', modelo: 'm1', modeloInformado: 'm2' }],
  );
  assert.match(md, /\| alta \| codigo \| a\.ts:1 \| a\\\|b c \| &lt;x&gt; \|  \|/u);
  assert.match(md, /## No revisado[\s\S]*seguridad \(fallida\): tiempo agotado[\s\S]*pruebas \(sin-modelo\)/u);
  assert.match(md, /## Escrituras detectadas[\s\S]*src\/a\.ts/u);
  assert.match(md, /## Modelos[\s\S]*codigo: pedido m1, informado m2/u);
  assert.ok(md.indexOf('## Hallazgos') < md.indexOf('## No revisado'));
  assert.ok(md.indexOf('## No revisado') < md.indexOf('## Escrituras detectadas'));
  assert.ok(md.indexOf('## Escrituras detectadas') < md.indexOf('## Modelos'));
});

test('markdown sin hallazgos', () => {
  assert.match(consolidadoMarkdown('fab-1', [], estadoBase()), /Sin hallazgos en las estaciones que terminaron/u);
  assert.doesNotMatch(consolidadoMarkdown('fab-1', [], estadoBase()), /No revisado/u);
});

test('escribirConsolidado lee el rastro y escribe consolidado.md con 0o600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-consol-'));
  try {
    const guarda = (estacion, resultado, modelo) =>
      writeFileSync(path.join(dir, `${estacion}.json`), JSON.stringify({ estacion, encargo: { modelo }, resultado }));
    guarda('codigo', { estado: 'ok', crudo: '', modeloInformado: 'real-1', informe: informe(h('codigo', 'alta', 'a.ts', 2)) }, 'pedido-1');
    guarda('seguridad', { estado: 'fallida', crudo: '', modeloInformado: null, motivo: 'boom' }, 'pedido-2');
    const estado = estadoBase({
      dir,
      estaciones: [
        { estacion: 'codigo', estado: 'ok' },
        { estacion: 'seguridad', estado: 'fallida', motivo: 'boom' },
        { estacion: 'pruebas', estado: 'omitida' },
      ],
    });
    const ruta = await escribirConsolidado(estado);
    assert.equal(ruta, path.join(dir, 'consolidado.md'));
    const md = readFileSync(ruta, 'utf8');
    assert.match(md, /a\.ts:2/u);
    assert.match(md, /seguridad \(fallida\): boom/u);
    assert.match(md, /codigo: pedido pedido-1, informado real-1/u);
    if (process.platform !== 'win32') assert.equal(statSync(ruta).mode & 0o777, 0o600);
    await escribirConsolidado(estado); // reescribir no falla
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
