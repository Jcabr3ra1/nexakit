import { TablaModelos, type NombreEstacion } from './esquemas.js';
import tablaCruda from './tabla-modelos.json' with { type: 'json' };

export interface Estacion {
  foco: string;
  criterios: string[];
  ordenesPermitidas: string[];
}

export const ESTACIONES: Record<NombreEstacion, Estacion> = {
  seguridad: {
    foco: 'Seguridad: hooks, comandos, permisos, secretos, red y rutas de archivos.',
    criterios: [
      'Inyección de órdenes o de rutas al ejecutar comandos o construir rutas.',
      'Secretos, tokens o credenciales expuestos en código, registros o rastro.',
      'Permisos y modos de archivo demasiado amplios; enlaces simbólicos seguidos.',
      'Llamadas de red o entradas externas sin validar.',
    ],
    ordenesPermitidas: [],
  },
  arquitectura: {
    foco: 'Arquitectura: rutas críticas y archivos que nombra un ADR de Decisiones.md.',
    criterios: [
      'El cambio respeta las decisiones registradas en Decisiones.md.',
      'Límites de módulos, responsabilidades claras y dependencias en un solo sentido.',
      'Interfaces públicas estables y sin acoplamiento accidental.',
      'Duplicación o capas nuevas que el diseño no contempla.',
    ],
    ordenesPermitidas: [],
  },
  pruebas: {
    foco: 'Pruebas: que el código cambiado esté cubierto por pruebas que verifiquen comportamiento.',
    criterios: [
      'Cada comportamiento nuevo o corregido tiene una prueba que fallaría sin el cambio.',
      'Casos borde y errores cubiertos, no solo el camino feliz.',
      'Las pruebas no dependen de red, modelos reales ni del HOME real.',
      'Las pruebas existentes siguen pasando (se permite ejecutar npm test).',
    ],
    ordenesPermitidas: ['npm test'],
  },
  codigo: {
    foco: 'Código: corrección, claridad y mantenibilidad del diff.',
    criterios: [
      'Errores lógicos, condiciones de carrera y casos no manejados.',
      'Nombres claros, funciones acotadas y sin código muerto.',
      'Coherencia con los patrones del repositorio.',
      'Manejo de errores con mensajes útiles en español.',
    ],
    ordenesPermitidas: [],
  },
  interfaz: {
    foco: 'Interfaz y UX: HTML, CSS y componentes de interfaz.',
    criterios: [
      'Accesibilidad: foco, contraste, etiquetas y navegación por teclado.',
      'Jerarquía visual, adaptación a distintos tamaños y estados vacíos o de error.',
      'Textos de interfaz claros y en español.',
      'Coherencia con el sistema de diseño existente.',
    ],
    ordenesPermitidas: [],
  },
  rendimiento: {
    foco: 'Rendimiento: bucles, E/S y rutas marcadas como calientes en la configuración.',
    criterios: [
      'Bucles o consultas con coste innecesario o crecimiento no acotado.',
      'E/S síncrona o repetida que podría agruparse o evitarse.',
      'Uso de memoria desproporcionado con entradas grandes.',
      'Trabajo en rutas calientes que podría cachearse o diferirse.',
    ],
    ordenesPermitidas: [],
  },
  documentacion: {
    foco: 'Documentación: cambios en docs/ o README, y órdenes nuevas sin documentar.',
    criterios: [
      'README y guías coinciden con el comportamiento real del código.',
      'Toda orden o bandera nueva está documentada.',
      'Los ejemplos funcionan y los textos están en español.',
      'Sin enlaces rotos ni información obsoleta.',
    ],
    ordenesPermitidas: [],
  },
};

export const TABLA_MODELOS_INICIAL: TablaModelos = TablaModelos.parse(tablaCruda);
