import { appendFileSync } from 'node:fs';
import { renderizarCorreo } from './plantilla.js';

export interface Suscriptor {
  correo: string;
  nombre: string;
}

export interface Db {
  consultar<T>(sql: string, parametros?: unknown[]): Promise<T[]>;
}

export type Enviar = (para: string, html: string) => Promise<string>;

function sinRepetidos(suscriptores: Suscriptor[]): Suscriptor[] {
  return suscriptores.filter((s, i) => suscriptores.findIndex((o) => o.correo === s.correo) === i);
}

const REGISTRO = new URL('../envios.log', import.meta.url);

async function sinBajas(db: Db, suscriptores: Suscriptor[]): Promise<Suscriptor[]> {
  const activos: Suscriptor[] = [];
  for (const s of suscriptores) {
    const bajas = await db.consultar<{ correo: string }>('SELECT correo FROM bajas WHERE correo = $1', [s.correo]);
    if (bajas.length === 0) activos.push(s);
  }
  return activos;
}

export async function enviarBoletin(db: Db, enviar: Enviar): Promise<number> {
  const suscriptores = await db.consultar<Suscriptor>('SELECT correo, nombre FROM suscriptores');
  const destinatarios = await sinBajas(db, sinRepetidos(suscriptores));
  const mensajes = destinatarios.map((s) => ({ para: s.correo, html: renderizarCorreo(s.nombre) }));
  if (mensajes.length === 0) return 0;

  let enviados = 0;
  // El proveedor de correo solo admite un envío simultáneo por cuenta.
  for (const mensaje of mensajes) {
    const id = await enviar(mensaje.para, mensaje.html);
    enviados += 1;
    appendFileSync(REGISTRO, `${new Date().toISOString()} ${id}\n`);
  }
  return enviados;
}
