/*
 * Registro de asignaturas.
 * Para añadir una asignatura nueva: deja su JSON en /data y añade una entrada aquí.
 * El JSON debe seguir la misma estructura que el de Móviles:
 *   { metadatos: {...}, examenes: [ { version, codigo, preguntas: [ { id, numero, tema, bloque,
 *     enunciado, opciones: {A,B,C,D}, respuesta_correcta, explicacion } ] } ] }
 * También se acepta el formato «banco_examenes_escalable» (banco_preguntas + versiones), como
 * el de Requisitos: lo traduce fromQuestionBank en app.js.
 */
window.SUBJECTS = [
  {
    id: 'moviles',
    nombre: 'Aplicaciones para Dispositivos Móviles',
    corto: 'Móviles',
    archivo: 'data/simulacros_moviles_UCAM_10_versiones_con_soluciones.json',
  },
  {
    id: 'requisitos',
    nombre: 'Ingeniería de Requisitos',
    corto: 'Requisitos',
    archivo: 'data/banco_requisitos_UCAM_soluciones_REENVIADO.json',
  },
  {
    id: 'tac',
    nombre: 'Tecnologías Avanzadas de Comunicación',
    corto: 'TAC',
    archivo: 'data/TAC_UCAM_CCNA_SRWE_10_tests_50_preguntas.json',
  },
];

window.APP_CONFIG = {
  // Simulacros previstos por asignatura: la cabecera indica cuántos hay de este total
  totalSlots: 30,
  // Exámenes de "Más falladas": cuántos se generan y cuántas preguntas lleva cada uno
  failedExamCount: 3,
  failedExamSize: 20,
};
