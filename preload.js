const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // ============================================================================
    // AUTO-REFRESH (FASE 4): push desde main tras cada escritura exitosa en la BD.
    // Cero polling — el renderer solo reacciona a este evento.
    // ============================================================================
    onDbChanged: (callback) => {
        const listener = (event, payload) => callback(payload);
        ipcRenderer.on('db:changed', listener);
        return () => ipcRenderer.removeListener('db:changed', listener);
    },

    // ============================================================================
    // MÓDULO 0: EMPRESAS
    // ============================================================================
    obtenerEmpresas: () =>
        ipcRenderer.invoke('empresas:obtener'),
    crearEmpresa: (payload) => ipcRenderer.invoke('empresas:crear', payload),
    actualizarEmpresa: (payload) => ipcRenderer.invoke('empresas:actualizar', payload),
    eliminarEmpresa: (id) => ipcRenderer.invoke('empresas:eliminar', id),
    seleccionarLogoEmpresa: () => ipcRenderer.invoke('empresas:seleccionar-logo'),
    obtenerLogoDefault: () => ipcRenderer.invoke('empresas:obtener-logo-default'),

    cargarEmpleadosExcel: (payload) =>
        ipcRenderer.invoke('cargar-empleados-excel', payload),

    // ============================================================================
    // MÓDULO 1: EMPLEADOS Y EXPEDIENTE
    // ============================================================================
    /**
     * Acepta tanto un ID directo (1) como un objeto ({ empresaId: 1 }) para evitar fallos IPC.
     */
    obtenerEmpleadosPorEmpresa: (params) => {
        const id = (typeof params === 'object' && params !== null) ? (params.empresaId || params.id) : params;
        return ipcRenderer.invoke('empleados:obtener-por-empresa', id);
    },

    buscarEmpleados: (empresaId, busqueda, estatus) => {
        if (typeof empresaId === 'object' && empresaId !== null) {
            return ipcRenderer.invoke('empleados:buscar', empresaId);
        }
        if (typeof empresaId === 'string' && !busqueda) {
            return ipcRenderer.invoke('empleados:buscar', { busqueda: empresaId });
        }
        return ipcRenderer.invoke('empleados:buscar', { empresaId, busqueda, estatus });
    },

    obtenerEmpleadoPorId: (id) =>
        ipcRenderer.invoke('empleados:obtener-por-id', id),

    crearEmpleado: (empleado) => 
        ipcRenderer.invoke('empleados:crear', empleado),

    actualizarEmpleado: (empleado) => 
        ipcRenderer.invoke('empleados:actualizar', empleado),

    eliminarEmpleado: (empleadoId) =>
        ipcRenderer.invoke('empleados:eliminar', empleadoId),

    obtenerResumenContratos: (empresaId) =>
        ipcRenderer.invoke('contratos:obtener-resumen', empresaId),

    seleccionarPdfContrato: () =>
        ipcRenderer.invoke('empleados:seleccionar-pdf-contrato'),

    abrirPdfContrato: (rutaPdf) =>
        ipcRenderer.invoke('empleados:abrir-pdf-contrato', rutaPdf),

    // ============================================================================
    // EXPEDIENTE DIGITAL: documentos adjuntos por empleado
    // ============================================================================
    obtenerCatalogoDocumentos: () => ipcRenderer.invoke('documentos:catalogo-tipos'),
    listarDocumentosEmpleado: (empleadoId) => ipcRenderer.invoke('documentos:listar', empleadoId),
    subirDocumentoEmpleado: (payload) => ipcRenderer.invoke('documentos:subir', payload),
    abrirDocumentoEmpleado: (documentoId) => ipcRenderer.invoke('documentos:abrir', documentoId),
    eliminarDocumentoEmpleado: (documentoId) => ipcRenderer.invoke('documentos:eliminar', documentoId),

    // ============================================================================
    // MÓDULO 2: GESTIÓN DE VACACIONES
    // ============================================================================
    obtenerRemanenteVacacionesFiniquito: (empleadoId, fechaConsulta) => ipcRenderer.invoke('vacaciones:obtener-remanente-finiquito', {empleadoId, fechaConsulta}),
    obtenerSaldoVacaciones: (empleadoId, fechaConsulta) => {
        if (typeof empleadoId === 'object' && empleadoId !== null) {
            return ipcRenderer.invoke('vacaciones:obtener-saldo', empleadoId);
        }
        return ipcRenderer.invoke('vacaciones:obtener-saldo', { empleadoId, fechaConsulta });
    },

    diagnosticoBDVacaciones: () => ipcRenderer.invoke('vacaciones:diagnostico-bd'),
    obtenerHistorialVacaciones: (params) => {
        if (typeof params === 'object' && params !== null) {
            return ipcRenderer.invoke('vacaciones:obtener-historial', params);
        }
        return ipcRenderer.invoke('vacaciones:obtener-historial', { empresaId: params });
    },

    solicitarGoceVacaciones: (datos) => 
        ipcRenderer.invoke('vacaciones:solicitar-goce', datos),

    cancelarSolicitudVacaciones: (solicitudId) => 
        ipcRenderer.invoke('vacaciones:cancelar-solicitud', solicitudId),

    pagarDiasVacaciones: (datos) => 
        ipcRenderer.invoke('vacaciones:pagar-dias', datos),

    descontarFaltaVacaciones: (datos) => 
        ipcRenderer.invoke('vacaciones:descontar-falta', datos),
    obtenerTablaISRMensual: (ejercicio) => ipcRenderer.invoke('isr:obtener-tabla-mensual', ejercicio),
    importarTablaISRMensual: (ejercicio) => ipcRenderer.invoke('isr:importar-tabla-mensual', ejercicio),
    simularFiniquito: (datos) => ipcRenderer.invoke('finiquitos:simular', datos),
    guardarFiniquito: (datos) => ipcRenderer.invoke('finiquitos:guardar', datos),
    obtenerFiniquitoPorEmpleado: (empleadoId) => ipcRenderer.invoke('finiquitos:obtener-por-empleado', empleadoId),
    obtenerHistorialFiniquitos: (filtros={}) => ipcRenderer.invoke('finiquitos:obtener-historial', filtros),
    registrarIncidencia: (datos) => ipcRenderer.invoke('incidencias:registrar', datos),
    obtenerIncidenciasPorEmpleado: (empleadoId) => ipcRenderer.invoke('incidencias:obtener-por-empleado', empleadoId),
    obtenerTodasIncidencias: (payload = {}) => ipcRenderer.invoke('incidencias:obtener-todas', payload),
    cancelarIncidencia: (incidenciaId) => ipcRenderer.invoke('incidencias:cancelar', incidenciaId),
    exportarFichaEmpleadoPdf: (datos) => ipcRenderer.invoke('perfil:exportar-pdf', datos),
    loginAdmin: (datos) => ipcRenderer.invoke('auth:login', datos),
    cambiarPasswordAdmin: (datos) => ipcRenderer.invoke('auth:cambiar-password', datos),
    obtenerResumenDashboard: (empresaId) => ipcRenderer.invoke('dashboard:resumen', empresaId),
    obtenerAuditoria: (payload) => ipcRenderer.invoke('auditoria:listar', payload),
    exportarAuditoriaPdf: (payload) => ipcRenderer.invoke('auditoria:exportar-pdf', payload),
    crearRespaldo: () => ipcRenderer.invoke('backup:crear'),
    obtenerCalendarioVacaciones: (payload) => ipcRenderer.invoke('reportes:calendario-vacaciones', payload),
    guardarReporteExcel: (payload) => ipcRenderer.invoke('reportes:guardar-excel', payload),
    guardarReportePdf: (payload) => ipcRenderer.invoke('reportes:guardar-pdf', payload),

    // ============================================================================
    // MÓDULO NUEVO: INTEGRACIÓN DE SALARIOS
    // ============================================================================
    obtenerPlantillaSalarios: (payload) => ipcRenderer.invoke('salarios:obtener-plantilla', payload),
    aplicarIncrementoSalarial: (payload) => ipcRenderer.invoke('salarios:aplicar-incremento', payload),
    obtenerConfigSalarios: () => ipcRenderer.invoke('salarios:obtener-config'),
    guardarConfigSalarios: (payload) => ipcRenderer.invoke('salarios:guardar-config', payload),

    // ============================================================================
    // MÓDULO NUEVO: COMPLEMENTO CONTPAQI
    // ============================================================================
    contpaqiObtenerDatosEmpleados: (payload = {}) => ipcRenderer.invoke('contpaqi:datos-empleados', payload),
    contpaqiObtenerDatosMovimientos: (payload = {}) => ipcRenderer.invoke('contpaqi:datos-movimientos', payload),
    contpaqiObtenerDatosFiniquitos: (payload = {}) => ipcRenderer.invoke('contpaqi:datos-finiquitos', payload),
    contpaqiObtenerDatosMovimientosImss: (payload = {}) => ipcRenderer.invoke('contpaqi:datos-movimientos-imss', payload),
    contpaqiLeerEmpleadosExcel: (payload) => ipcRenderer.invoke('contpaqi:leer-empleados-excel', payload),
    contpaqiConfirmarImportacionEmpleados: (payload) => ipcRenderer.invoke('contpaqi:confirmar-importacion-empleados', payload),
});

window.electronAPI = Object.assign(window.electronAPI || {}, {
  incidenciasObtenerPdfV8: (id) => ipcRenderer.invoke('incidencias:obtener-pdf-v8', id)
});

window.electronAPI = Object.assign(window.electronAPI || {}, {
  incidenciasExportarPdfV12: (id) => ipcRenderer.invoke('incidencias:exportar-pdf-v11', id)
});



// V16: API PDF expuesta correctamente al mundo del renderer.
// Con contextIsolation=true, asignar window.electronAPI directamente
// desde preload NO la hace visible al renderer.
contextBridge.exposeInMainWorld('electronAPI', {
    incidenciasObtenerPdf: (id) =>
        ipcRenderer.invoke('incidencias:obtener-pdf', Number(id)),
    incidenciasObtenerPdfV8: (id) =>
        ipcRenderer.invoke('incidencias:obtener-pdf-v8', Number(id)),
    incidenciasExportarPdfV11: (id) =>
        ipcRenderer.invoke('incidencias:exportar-pdf-v11', Number(id)),
    incidenciasExportarPdfV12: (id) =>
        ipcRenderer.invoke('incidencias:exportar-pdf-v11', Number(id)),
    incidenciasExportarPdfV15: (id) =>
        ipcRenderer.invoke('incidencias:exportar-pdf-v11', Number(id)),
    incidenciasExportarPdfV16: (id) =>
        ipcRenderer.invoke('incidencias:exportar-pdf-v11', Number(id))
});
