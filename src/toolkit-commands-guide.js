export function getToolkitCommandsGuide({ clients = {} } = {}) {
  const claudeActive = clients.claude?.available !== false;
  const codexActive = clients.codex?.available !== false;
  const antigravityActive = clients.antigravity?.available !== false;

  const workflowCommands = [
    {
      id: 'superpowers:brainstorming',
      claude: '/superpowers:brainstorming',
      codex: '$superpowers:brainstorming',
      antigravity: '/brainstorming',
      stage: '1. Diseñar',
      description: 'Superpowers: entiende la intención, compara alternativas y deja un diseño aprobado.',
    },
    {
      id: 'superpowers:writing-plans',
      claude: '/superpowers:writing-plans',
      codex: '$superpowers:writing-plans',
      antigravity: '/writing-plans',
      stage: '2. Planificar',
      description: 'Superpowers: plan ejecutable con rutas exactas, pruebas y pasos verificables.',
    },
    {
      id: 'superpowers:test-driven-development',
      claude: '/superpowers:test-driven-development',
      codex: '$superpowers:test-driven-development',
      antigravity: '/test-driven-development',
      stage: '2b. TDD',
      description: 'Superpowers: ciclo Rojo → Verde → Refactorizar comprobando primero el fallo esperado.',
    },
    {
      id: 'superpowers:systematic-debugging',
      claude: '/superpowers:systematic-debugging',
      codex: '$superpowers:systematic-debugging',
      antigravity: '/systematic-debugging',
      stage: '2c. Diagnóstico',
      description: 'Superpowers: aísla la causa raíz reproducible antes de proponer un parche.',
    },
    {
      id: 'quality-gate',
      claude: '/quality-gate',
      codex: '$quality-gate',
      antigravity: '/quality-gate',
      stage: '3. Verificar',
      description: 'Puerta de nexakit antes de PR o revisión: requisitos, seguridad y diff, sobre la evidencia de Superpowers.',
    },
    {
      id: 'revisar',
      claude: '/revisar',
      codex: '$revisar',
      antigravity: '/revisar',
      stage: '4. Revisión par',
      description: 'Pide una revisión a otra IA desde esta terminal; solo ocurre cuando tú la pides.',
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
    {
      command: 'nexakit ahorro',
      description: 'Resume cuánta salida de comandos recortó el mod nexakit-ahorro.',
    },
    {
      command: 'nexakit lecciones',
      description: 'Resume las correcciones y lecciones que registra el mod nexakit-lecciones y las pendientes.',
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
