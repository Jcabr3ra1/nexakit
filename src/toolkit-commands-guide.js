export function getToolkitCommandsGuide({ clients = {} } = {}) {
  const claudeActive = clients.claude?.available !== false;
  const codexActive = clients.codex?.available !== false;
  const antigravityActive = clients.antigravity?.available !== false;

  const workflowCommands = [
    {
      id: 'spec-driven-development',
      claude: '/spec-driven-development',
      codex: '$spec-driven-development',
      antigravity: '/spec-driven-development',
      stage: '1. Diseñar',
      description: 'Entrevista breve, comparación de alternativas, especificación y plan verificable.',
    },
    {
      id: 'desarrollo-con-pruebas',
      claude: '/desarrollo-con-pruebas',
      codex: '$desarrollo-con-pruebas',
      antigravity: '/desarrollo-con-pruebas',
      stage: '2b. TDD',
      description: 'Ciclo Rojo → Verde → Refactorizar comprobando primero el fallo esperado.',
    },
    {
      id: 'depurar',
      claude: '/depurar',
      codex: '$depurar',
      antigravity: '/depurar',
      stage: '2c. Diagnóstico',
      description: 'Aísla causa raíz reproducible antes de proponer un parche.',
    },
    {
      id: 'quality-gate',
      claude: '/quality-gate',
      codex: '$quality-gate',
      antigravity: '/quality-gate',
      stage: '3. Verificar',
      description: 'Puerta de cierre con evidencia fresca ejecutada frente a criterios.',
    },
    {
      id: 'revisar',
      claude: '/revisar',
      codex: '$revisar',
      antigravity: '/revisar',
      stage: '4. Revisión par',
      description: 'Pide una revisión adicional a otra IA desde esta terminal.',
    },
    {
      id: 'cerrar-memoria',
      claude: '/cerrar-memoria',
      codex: '$cerrar-memoria',
      antigravity: '/cerrar-memoria',
      stage: 'Cierre',
      description: 'Prepara resumen de sesión y cambios propuestos para memoria.',
    },
  ];

  const cliCommands = [
    {
      command: 'npx nexakit',
      description: 'Abre el asistente de tres preguntas y deja listo el proyecto (--si aplica sin preguntar).',
    },
    {
      command: 'npx nexakit comprobar',
      description: 'Comprueba en solo lectura Node, las tres IA, las skills base y los restos antiguos.',
    },
    {
      command: 'npx nexakit quitar --si',
      description: 'Retira las skills del proyecto, .agent-toolkit/ y su bloque de .gitignore sin tocar lo tuyo.',
    },
    {
      command: 'npx nexakit scan <carpeta de skill>',
      description: 'Revisa el contenido de una skill sin ejecutarla y avisa de lo sospechoso.',
    },
    {
      command: 'npx nexakit reparar --desde <ruta>',
      description: 'Re-apunta enlaces antiguos rotos tras mostrar la lista y pedir confirmación.',
    },
    {
      command: 'npx nexakit memoria <subcomando>',
      description: 'Ejecuta init, connect, doctor, status o sync sobre la bóveda de memoria.',
    },
    {
      command: 'nexakit revision --disponibles',
      description: 'Consulta las IA disponibles y certificadas o lanza una revisión en solo lectura.',
    },
    {
      command: 'nexakit modelo',
      description: 'Consulta modelos reales, esfuerzos y valores guardados.',
    },
  ];

  return {
    claudeActive,
    codexActive,
    antigravityActive,
    workflowCommands,
    cliCommands,
  };
}
