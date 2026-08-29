console.log("🚀 ¡El archivo renderer.js HA SIDO CARGADO CORRECTAMENTE!");

// ==========================================
// 1. ESTADO GLOBAL SEGURO (PROTEGIDO)
// ==========================================
if (typeof window.empresas === 'undefined') window.empresas = [];
if (typeof window.listaEmpleadosEmpresa === 'undefined') window.listaEmpleadosEmpresa = [];
if (typeof window.listaEmpleadosFiltrados === 'undefined') window.listaEmpleadosFiltrados = [];
if (typeof window.empresaSeleccionadaId === 'undefined') window.empresaSeleccionadaId = null;
if (typeof window.rutaPdfSeleccionada === 'undefined') window.rutaPdfSeleccionada = '';
if (typeof window.simulacionFiniquitoActual === 'undefined') window.simulacionFiniquitoActual = null;
if (typeof window.peticionFiniquitoActual === 'undefined') window.peticionFiniquitoActual = null;
if (typeof window.empleadoVacacionesSeleccionado === 'undefined') window.empleadoVacacionesSeleccionado = null;
if (typeof window.filtroEstatusActual === 'undefined') window.filtroEstatusActual = 'TODOS';
// Estado unificado del modulo de vacaciones (evita referencias a un objeto antiguo inexistente)
if (!window.estadoVacaciones || typeof window.estadoVacaciones !== 'object') window.estadoVacaciones = {};
window.estadoVacaciones.empresaIdActual = window.empresaSeleccionadaId;
window.estadoVacaciones.empleadoIdSeleccionado = window.empleadoVacacionesSeleccionado;

// Alias para mantener compatibilidad local
var empresas = window.empresas;
var listaEmpleadosEmpresa = window.listaEmpleadosEmpresa;
var listaEmpleadosFiltrados = window.listaEmpleadosFiltrados;
var empresaSeleccionadaId = window.empresaSeleccionadaId;
var rutaPdfSeleccionada = window.rutaPdfSeleccionada;
var simulacionFiniquitoActual = window.simulacionFiniquitoActual;
var empleadoVacacionesSeleccionado = window.empleadoVacacionesSeleccionado;
var filtroEstatusActual = window.filtroEstatusActual;

// ==========================================
// SISTEMA DE ALERTAS IN-APP (reemplazo de alert/confirm/prompt nativos)
// ==========================================
let _previousFocus = null;
let _alertResolve = null;

window.showAlert = function(message, title = "Aviso", type = "info") {
    return new Promise(resolve => {
        _previousFocus = document.activeElement;
        document.getElementById('appAlertTitle').textContent = title;
        document.getElementById('appAlertMessage').textContent = message;
        document.getElementById('appAlertCancel').classList.add('hidden');
        document.getElementById('appAlertConfirm').textContent = 'Aceptar';
        document.getElementById('appAlertOverlay').classList.remove('hidden');
        document.getElementById('appAlertConfirm').focus();
        _alertResolve = resolve;
    });
};

window.showConfirm = function(message, title = "Confirmar") {
    return new Promise(resolve => {
        _previousFocus = document.activeElement;
        document.getElementById('appAlertTitle').textContent = title;
        document.getElementById('appAlertMessage').textContent = message;
        document.getElementById('appAlertCancel').classList.remove('hidden');
        document.getElementById('appAlertConfirm').textContent = 'Confirmar';
        document.getElementById('appAlertOverlay').classList.remove('hidden');
        document.getElementById('appAlertConfirm').focus();
        _alertResolve = resolve;
    });
};

function closeAppAlert(result) {
    document.getElementById('appAlertOverlay').classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.pointerEvents = '';
    document.getElementById('loginPassword')?.removeAttribute('disabled');
    if (_previousFocus && _previousFocus.focus) {
        setTimeout(() => _previousFocus.focus(), 50);
    }
    if (_alertResolve) { _alertResolve(result); _alertResolve = null; }
}

document.getElementById('appAlertConfirm').addEventListener('click', () => closeAppAlert(true));
document.getElementById('appAlertCancel').addEventListener('click', () => closeAppAlert(false));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('appAlertOverlay').classList.contains('hidden')) {
        closeAppAlert(false);
    }
});

// Constantes Ley Laboral México
if (typeof window.SALARIO_MINIMO_VIGENTE === 'undefined') window.SALARIO_MINIMO_VIGENTE = 248.93;
var SALARIO_MINIMO_VIGENTE = window.SALARIO_MINIMO_VIGENTE;


// Callback del buscador principal de Vacaciones.
// Se ejecuta al seleccionar un empleado y recupera inmediatamente sus saldos.
window.onEmpleadoVacacionesSeleccionado = async function(emp) {
    if (!emp || !emp.id) return;
    window.empleadoVacacionesSeleccionado = Number(emp.id);
    window.estadoVacaciones = window.estadoVacaciones || {};
    window.estadoVacaciones.empleadoIdSeleccionado = Number(emp.id);
    window.estadoVacaciones.empresaIdActual = Number(window.empresaSeleccionadaId || emp.empresa_id || 0);

    const hidden = document.getElementById('idEmpVacacionesSeleccionado');
    if (hidden) hidden.value = String(emp.id);

    await mostrarResumenSaldoVacaciones(Number(emp.id));
    await cargarHistorialVacaciones();
};

async function mostrarResumenSaldoVacaciones(empleadoId) {
    const contenedor = document.getElementById('resumenSaldoVacaciones');
    if (!contenedor || !empleadoId) return;

    contenedor.innerHTML = '<div class="card" style="padding:18px;text-align:center;color:#64748b;">Consultando saldo de vacaciones...</div>';

    try {
        const res = await window.api.obtenerSaldoVacaciones(
            Number(empleadoId),
            new Date().toISOString().slice(0, 10)
        );

        if (!res || !res.ok) {
            throw new Error(res?.error || 'No fue posible consultar el saldo.');
        }

        const saldo = res.saldo || {};
        const liberados = Array.isArray(saldo.liberados) ? saldo.liberados : [];
        const bloqueados = Array.isArray(saldo.bloqueados) ? saldo.bloqueados : [];

        const disponibles = Number(saldo.totalUsable || 0);
        const futuros = Number(saldo.totalBloqueado || 0);
        const total = disponibles + futuros;

        const filaSaldos = (lista, bloqueado) => lista.length
            ? lista.map(x => `
                <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #e2e8f0;">
                    <span><strong>Ciclo ${escapeHtml(String(x.periodo))}</strong>
                    <small style="display:block;color:#64748b;">Disponible: ${escapeHtml(String(x.fecha_disponible || ''))}</small></span>
                    <strong>${Number(x.dias_restantes || 0)} día(s)</strong>
                </div>
            `).join('')
            : `<div style="padding:10px 0;color:#64748b;">No hay ciclos ${bloqueado ? 'futuros bloqueados' : 'liberados'} con saldo.</div>`;

        contenedor.innerHTML = `
            <div class="card" style="padding:18px;margin-bottom:20px;border:1px solid #dbe4ee;background:#fff;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:15px;">
                    <div>
                        <h3 style="margin:0;color:#1e293b;">Resumen de vacaciones</h3>
                        <small style="color:#64748b;">Saldo calculado a ${escapeHtml(new Date().toISOString().slice(0,10))}</small>
                    </div>
                    <div style="font-weight:700;color:#0f766e;">Total: ${total} día(s)</div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
                    <div class="saldo-resumen-card" style="padding:15px;border-radius:10px;background:#ecfdf5;border:1px solid #a7f3d0;text-align:center;">
                        <div style="font-size:.82rem;color:#047857;text-align:center;">DÍAS DISPONIBLES</div>
                        <strong style="display:block;font-size:1.7rem;color:#065f46;text-align:center;">${disponibles}</strong>
                    </div>
                    <div class="saldo-resumen-card" style="padding:15px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;text-align:center;">
                        <div style="font-size:.82rem;color:#c2410c;text-align:center;">DÍAS BLOQUEADOS</div>
                        <strong style="display:block;font-size:1.7rem;color:#9a3412;text-align:center;">${futuros}</strong>
                    </div>
                    <div class="saldo-resumen-card" style="padding:15px;border-radius:10px;background:#f1f5f9;border:1px solid #cbd5e1;text-align:center;">
                        <div style="font-size:.82rem;color:#475569;text-align:center;">TOTAL DE SALDO</div>
                        <strong style="display:block;font-size:1.7rem;color:#1e293b;text-align:center;">${total}</strong>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px;">
                    <div>
                        <h4 style="margin:0 0 8px;color:#047857;">Ciclos liberados</h4>
                        ${filaSaldos(liberados, false)}
                    </div>
                    <div>
                        <h4 style="margin:0 0 8px;color:#c2410c;">Ciclos futuros bloqueados</h4>
                        ${filaSaldos(bloqueados, true)}
                    </div>
                </div>
            </div>
        `;
    } catch (error) {
        contenedor.innerHTML = `<div class="card" style="padding:18px;color:#b91c1c;">Error al consultar el saldo: ${escapeHtml(error.message)}</div>`;
        console.error('Error al mostrar saldo de vacaciones:', error);
    }
}

async function refrescarModuloVacaciones() {
    const empleadoId = Number(window.empleadoVacacionesSeleccionado || window.estadoVacaciones?.empleadoIdSeleccionado || 0);
    if (empleadoId) {
        await mostrarResumenSaldoVacaciones(empleadoId);
    } else {
        const contenedor = document.getElementById('resumenSaldoVacaciones');
        if (contenedor) contenedor.innerHTML = '<div class="card" style="padding:18px;color:#64748b;">Seleccione un empleado para consultar sus días disponibles y ciclos futuros bloqueados.</div>';
    }
    await cargarHistorialVacaciones();
}

// ==========================================
// 2. PUNTO DE ENTRADA ÚNICO (DOMContentLoaded)
// ==========================================

/* =========================================================
   V15 - Incidencias: funciones base y botones corregidos
   ========================================================= */

function seleccionarEmpleadoBuscador(id, nombre, contexto) {
  try {
    const hidden = document.getElementById('idEmpIncidenciaSeleccionado');
    if (hidden) hidden.value = String(id ?? '');

    const input =
      document.getElementById('buscarEmpIncidencia') ||
      document.getElementById('input-buscar-empleado');
    if (input && nombre != null) input.value = String(nombre);

    const resultados = document.getElementById('resBusquedaIncidencia');
    if (resultados) {
      resultados.innerHTML = '';
      resultados.style.display = 'none';
    }

    if (id) {
      Promise.resolve(actualizarSaldoIncidencia(Number(id))).catch(console.error);
      Promise.resolve(cargarHistorialIncidencias()).catch(console.error);
    }
  } catch (e) {
    console.error('V15 seleccionarEmpleadoBuscador:', e);
  }
}

async function configurarModuloIncidenciasManual() {
  const form = document.getElementById('formIncidenciaManual');
  const btnLimpiar = document.getElementById('btnLimpiarIncidenciaV12');

  if (btnLimpiar) {
    btnLimpiar.type = 'button';
    btnLimpiar.onclick = null;
    btnLimpiar.addEventListener('click', limpiarModuloIncidenciasV15, { once: false });
  }

  if (!form || form.dataset.v15Submit === '1') return;
  form.dataset.v15Submit = '1';

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    e.stopPropagation();

    const empleadoId = Number(document.getElementById('idEmpIncidenciaSeleccionado')?.value || 0);
    const fechaInicio = document.getElementById('incFecha')?.value || '';
    const fechaFin = document.getElementById('fechaIncidenciaFinV10')?.value || fechaInicio;
    const dias = Number(document.getElementById('incDias')?.value || 0);
    const observaciones = document.getElementById('incObservaciones')?.value?.trim() || '';

    if (!empleadoId) return mostrarNotificacionLocal('Seleccione un empleado.', 'error');
    if (!fechaInicio) return mostrarNotificacionLocal('Seleccione la fecha de incidencia.', 'error');
    if (fechaFin < fechaInicio) return mostrarNotificacionLocal('La fecha final no puede ser anterior a la inicial.', 'error');

    const rango = Math.floor(
      (new Date(fechaFin + 'T00:00:00') - new Date(fechaInicio + 'T00:00:00')) / 86400000
    ) + 1;

    if (dias !== rango) {
      return mostrarNotificacionLocal(`Los días a descontar (${dias}) deben coincidir con el rango (${rango}).`, 'error');
    }

    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;

    try {
      const saldo = await window.api.obtenerSaldoVacaciones(empleadoId, fechaInicio);
      const disponible = Number(saldo?.saldo?.totalUsable || 0);

      if (disponible < dias) {
        mostrarNotificacionLocal(`No cuenta con días disponibles suficientes. Disponible: ${disponible}.`, 'error');
        return;
      }

      const result = await window.api.registrarIncidencia({
        empleado_id: empleadoId,
        tipo: 'INCIDENCIA_A_CUENTA_VACACIONES',
        fecha: fechaInicio,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        dias,
        observaciones
      });

      if (!result?.ok) throw new Error(result?.error || 'No fue posible registrar la incidencia.');

      mostrarNotificacionLocal(`Incidencia ${result.folio || ''} registrada correctamente.`, 'success');
      await cargarHistorialIncidencias();
      await actualizarSaldoIncidencia(empleadoId);
      refrescarPanoramaLaboral();
    } catch (err) {
      mostrarNotificacionLocal(`Error al registrar incidencia: ${err.message}`, 'error');
    } finally {
      if (submit) submit.disabled = false;
      setTimeout(() => devolverFocoIncidenciasV15(), 0);
    }
  });
}

function limpiarModuloIncidenciasV15(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  const form = document.getElementById('formIncidenciaManual');
  if (form) {
    form.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.type === 'button' || el.type === 'submit') return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
      else if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
  }

  [
    'idEmpIncidenciaSeleccionado',
    'buscarEmpIncidencia',
    'incFecha',
    'fechaIncidenciaFinV10',
    'incObservaciones'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const dias = document.getElementById('incDias');
  if (dias) dias.value = '1';

  const rango = document.getElementById('diasRangoIncidenciaV10');
  if (rango) rango.textContent = 'Rango: 1 día';

  const saldo = document.getElementById('incSaldoEmpleado');
  if (saldo) saldo.innerHTML = '';

  const resultados = document.getElementById('resBusquedaIncidencia');
  if (resultados) {
    resultados.innerHTML = '';
    resultados.style.display = 'none';
  }

  const historial = document.getElementById('tablaHistorialIncidencias');
  if (historial) {
    historial.innerHTML =
      '<tr><td colspan="8" style="text-align:center;color:#64748b;">Seleccione un empleado.</td></tr>';
  }

  window.incidenciaSeleccionadaId = null;

  setTimeout(() => {
    devolverFocoIncidenciasV15();
    try { mostrarNotificacionLocal('Campos de Incidencias y Asistencias limpiados.', 'success'); } catch (_) {}
  }, 0);
}

function devolverFocoIncidenciasV15() {
  try {
    window.focus();
    const input =
      document.getElementById('buscarEmpIncidencia') ||
      document.querySelector('#mod-incidencias input[placeholder*="empleado" i]');
    if (input) {
      input.focus({preventScroll:true});
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  } catch (_) {}
}


/* =========================================================
   V16 - Buscador y autocompletado del Historial de Incidencias
   ========================================================= */
function configurarBuscadorHistorialIncidenciasV16() {
  const input = document.getElementById('buscarHistorialIncidenciasV16');
  const resultados = document.getElementById('resBusquedaHistorialIncidenciasV16');
  if (!input || !resultados || input.dataset.v16Ready === '1') return;

  input.dataset.v16Ready = '1';
  let timer = null;

  const cerrar = () => {
    resultados.innerHTML = '';
    resultados.style.display = 'none';
  };

  const pintar = (empleados) => {
    if (!empleados.length) {
      resultados.innerHTML = '<div class="search-result-item">Sin coincidencias</div>';
      resultados.style.display = 'block';
      return;
    }

    resultados.innerHTML = empleados.slice(0, 8).map(emp => {
      const nombre = `${emp.nombre || ''} ${emp.apellido || ''}`.trim();
      return `<div class="search-result-item"
                   data-hist-emp-id="${Number(emp.id)}"
                   data-hist-emp-name="${escapeHtml(nombre)}"
                   style="cursor:pointer;padding:9px 12px;">
                <strong>${escapeHtml(nombre)}</strong>
                ${emp.num_empleado ? `<small style="display:block;color:#64748b;">Empleado: ${escapeHtml(emp.num_empleado)}</small>` : ''}
              </div>`;
    }).join('');
    resultados.style.display = 'block';
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();

    if (!q) {
      cerrar();
      cargarHistorialIncidencias();
      return;
    }

    timer = setTimeout(async () => {
      try {
        const res = await window.api.buscarEmpleados({
          busqueda: q,
          estatus: 'TODOS'
        });
        const empleados = res?.ok && Array.isArray(res.data) ? res.data : [];
        pintar(empleados);
      } catch (err) {
        console.error('V16 autocompletado historial:', err);
        resultados.innerHTML = '<div class="search-result-item">Error al buscar empleados</div>';
        resultados.style.display = 'block';
      }
    }, 180);
  });

  resultados.addEventListener('mousedown', async (e) => {
    const item = e.target.closest('[data-hist-emp-id]');
    if (!item) return;

    e.preventDefault();

    const id = Number(item.dataset.histEmpId);
    const nombre = item.dataset.histEmpName || '';

    input.value = nombre;
    input.dataset.empleadoId = String(id);
    cerrar();

    // También sincronizamos el empleado del formulario de incidencias.
    const hidden = document.getElementById('idEmpIncidenciaSeleccionado');
    if (hidden) hidden.value = String(id);

    const buscadorInc = document.getElementById('buscarEmpIncidencia');
    if (buscadorInc) buscadorInc.value = nombre;

    await cargarHistorialIncidencias({ empleadoId: id });
    await actualizarSaldoIncidencia(id);

    setTimeout(() => input.focus({preventScroll:true}), 0);
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      delete input.dataset.empleadoId;
      cerrar();
      await cargarHistorialIncidencias();
      input.focus({preventScroll:true});
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#busquedaHistorialIncidenciasV16')) cerrar();
  });

  // Mostrar inicialmente todo el historial.
  cargarHistorialIncidencias();
}


// ==========================================
// Overlay de bloqueo para cargas masivas (impide clics en el resto de la
// app mientras corre una operación de importación que escribe en la BD).
// ==========================================
function mostrarBloqueoCarga(mensaje) {
    const overlay = document.getElementById('overlayProcesoMasivo');
    const texto = document.getElementById('overlayProcesoMasivoMensaje');
    if (texto) texto.textContent = mensaje || 'Procesando...';
    if (overlay) overlay.style.display = 'flex';
}
function ocultarBloqueoCarga() {
    const overlay = document.getElementById('overlayProcesoMasivo');
    if (overlay) overlay.style.display = 'none';
}

// Pregunta el formato de fecha cuando el archivo tiene fechas ambiguas
// (ej. "03/04/2024"). Devuelve 'DMY', 'MDY', o null si el usuario cancela.
// Serializada con una cola: si dos importaciones (ej. clásica y CONTPAQi)
// detectan ambigüedad casi al mismo tiempo, la segunda espera a que la
// primera modal se cierre antes de reutilizar los mismos botones estáticos
// del DOM — evita que un solo clic resuelva ambas preguntas a la vez.
let _colaPreguntaFormatoFecha = Promise.resolve();
function preguntarFormatoFecha(ejemplos) {
    const ejecutar = () => _preguntarFormatoFechaInterno(ejemplos);
    const resultado = _colaPreguntaFormatoFecha.then(ejecutar, ejecutar);
    _colaPreguntaFormatoFecha = resultado.catch(() => {});
    return resultado;
}
function _preguntarFormatoFechaInterno(ejemplos) {
    return new Promise(resolve => {
        const modal = document.getElementById('modalFormatoFecha');
        const msg = document.getElementById('modalFormatoFechaMensaje');
        const btnDMY = document.getElementById('btnFormatoFechaDMY');
        const btnMDY = document.getElementById('btnFormatoFechaMDY');
        const btnCancelar = document.getElementById('btnFormatoFechaCancelar');
        if (!modal || !btnDMY || !btnMDY || !btnCancelar) { resolve(null); return; }

        const lista = (ejemplos || []).map(e => `«${e}»`).join(', ');
        if (msg) msg.textContent = `Se detectaron fechas como ${lista || 'una fecha ambigua'} que pueden interpretarse de dos formas distintas. ¿Qué formato usa tu archivo?`;

        const limpiar = () => {
            modal.style.display = 'none';
            btnDMY.removeEventListener('click', onDMY);
            btnMDY.removeEventListener('click', onMDY);
            btnCancelar.removeEventListener('click', onCancelar);
        };
        const onDMY = () => { limpiar(); resolve('DMY'); };
        const onMDY = () => { limpiar(); resolve('MDY'); };
        const onCancelar = () => { limpiar(); resolve(null); };

        btnDMY.addEventListener('click', onDMY);
        btnMDY.addEventListener('click', onMDY);
        btnCancelar.addEventListener('click', onCancelar);
        modal.style.display = 'grid';
    });
}

/* =========================================================
   V17 - Importación de empleados desde Excel
   ========================================================= */
function configurarImportacionEmpleadosExcelV17() {
    const btn = document.getElementById('btnImportarEmpleadosExcel');
    const estado = document.getElementById('estadoImportacionEmpleadosExcelV17');
    if (!btn || btn.dataset.v17Ready === '1') return;

    btn.dataset.v17Ready = '1';
    btn.type = 'button';

    btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const empresaId = Number(window.empresaSeleccionadaId || document.getElementById('selectEmpresaGlobal')?.value || 0);

        if (!empresaId) {
            if (estado) {
                estado.textContent = 'Seleccione una empresa antes de importar.';
                estado.style.color = '#b91c1c';
            }
            setTimeout(() => btn.focus({preventScroll:true}), 0);
            return;
        }

        if (!window.api || typeof window.api.cargarEmpleadosExcel !== 'function') {
            console.error('V17: cargarEmpleadosExcel no está disponible en window.api.');
            if (estado) {
                estado.textContent = 'La función de importación no está disponible.';
                estado.style.color = '#b91c1c';
            }
            return;
        }

        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cargando...';
        if (estado) {
            estado.textContent = 'Seleccione el archivo Excel...';
            estado.style.color = '#64748b';
        }

        try {
            mostrarBloqueoCarga('Cargando empleados desde Excel...');
            let res = await window.api.cargarEmpleadosExcel({ empresaId });

            if (res?.requiereFormatoFecha) {
                ocultarBloqueoCarga();
                const formato = await preguntarFormatoFecha(res.ejemplos);
                if (!formato) {
                    if (estado) { estado.textContent = 'Carga cancelada.'; estado.style.color = '#64748b'; }
                    return;
                }
                mostrarBloqueoCarga('Cargando empleados desde Excel...');
                res = await window.api.cargarEmpleadosExcel({ empresaId, formatoFecha: formato, filePath: res.filePath });
            }

            if (res?.ok) {
                const errores = Number(res.totalErrores || 0);
                if (estado) {
                    estado.textContent = errores
                        ? `${res.totalProcesados || 0} empleados cargados; ${errores} filas con observaciones.`
                        : `${res.totalProcesados || 0} empleados cargados correctamente.`;
                    estado.style.color = errores ? '#92400e' : '#166534';
                }

                if (typeof actualizarVistasPorEmpresa === 'function') {
                    await actualizarVistasPorEmpresa(empresaId);
                } else if (typeof cargarEmpleadosEmpresa === 'function') {
                    await cargarEmpleadosEmpresa(empresaId);
                }
            } else if (!res?.cancelado && res?.mensaje !== 'Carga cancelada.') {
                if (estado) {
                    estado.textContent = res?.error || 'No fue posible importar el archivo.';
                    estado.style.color = '#b91c1c';
                }
            } else {
                if (estado) estado.textContent = 'Carga cancelada.';
            }
        } catch (err) {
            console.error('V17 importación Excel:', err);
            if (estado) {
                estado.textContent = `Error al importar: ${err.message}`;
                estado.style.color = '#b91c1c';
            }
        } finally {
            ocultarBloqueoCarga();
            btn.disabled = false;
            btn.innerHTML = original;
            setTimeout(() => btn.focus({preventScroll:true}), 0);
        }
    });
}

function configurarModuloContpaqi() {
    const btnEmpleados = document.getElementById('btnContpaqiExportarEmpleados');
    const btnMovimientos = document.getElementById('btnContpaqiExportarMovimientos');
    const btnFiniquitos = document.getElementById('btnContpaqiExportarFiniquitos');
    const btnImportar = document.getElementById('btnContpaqiImportarEmpleados');
    if (!btnEmpleados && !btnMovimientos && !btnFiniquitos && !btnImportar) return;
    if (btnEmpleados && btnEmpleados.dataset.contpaqiReady === '1') return;

    const estadoExportar = document.getElementById('estadoContpaqiExportar');
    const estadoImportar = document.getElementById('estadoContpaqiImportar');
    const obtenerEmpresaId = () => Number(window.empresaSeleccionadaId || document.getElementById('selectEmpresaGlobal')?.value || 0) || null;

    const conBotonOcupado = async (btn, textoCargando, fn) => {
        if (!btn) return fn();
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${textoCargando}`;
        try {
            await fn();
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    if (btnEmpleados) {
        btnEmpleados.dataset.contpaqiReady = '1';
        btnEmpleados.addEventListener('click', async () => {
            await conBotonOcupado(btnEmpleados, 'Exportando...', async () => {
                try {
                    const res = await window.api.contpaqiObtenerDatosEmpleados({ empresaId: obtenerEmpresaId() });
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible obtener el catálogo.', 'error'); return; }
                    if (!res.data.length) { mostrarNotificacionLocal('No hay empleados activos para exportar.', 'error'); return; }
                    const guardado = await exportarTablaAExcel('Empleados_CONTPAQi', res.data);
                    if (guardado?.ok) { mostrarNotificacionLocal('Catálogo de empleados exportado.', 'success'); if (estadoExportar) estadoExportar.textContent = `Empleados: ${res.data.length} registro(s) exportado(s).${guardado.filePath ? ' Guardado en: ' + guardado.filePath : ''}`; await cargarHistorialContpaqi(); }
                } catch (err) {
                    console.error('Exportar empleados CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al exportar: ' + err.message, 'error');
                }
            });
        });
    }

    if (btnMovimientos) {
        btnMovimientos.dataset.contpaqiReady = '1';
        btnMovimientos.addEventListener('click', async () => {
            const fechaInicio = document.getElementById('contpaqiFechaInicioMov')?.value;
            const fechaFin = document.getElementById('contpaqiFechaFinMov')?.value;
            if (!fechaInicio || !fechaFin) { mostrarNotificacionLocal('Indica el rango de fechas (del / al) antes de exportar.', 'error'); return; }
            await conBotonOcupado(btnMovimientos, 'Exportando...', async () => {
                try {
                    const res = await window.api.contpaqiObtenerDatosMovimientos({ empresaId: obtenerEmpresaId(), fechaInicio, fechaFin });
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible obtener los movimientos.', 'error'); return; }
                    if (!res.data.length) { mostrarNotificacionLocal('No hay movimientos ni incidencias en ese rango.', 'error'); return; }
                    const guardado = await exportarTablaAExcel('Movimientos_CONTPAQi', res.data);
                    if (guardado?.ok) { mostrarNotificacionLocal('Movimientos e incidencias exportados.', 'success'); if (estadoExportar) estadoExportar.textContent = `Movimientos: ${res.data.length} registro(s) exportado(s).${guardado.filePath ? ' Guardado en: ' + guardado.filePath : ''}`; await cargarHistorialContpaqi(); }
                } catch (err) {
                    console.error('Exportar movimientos CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al exportar: ' + err.message, 'error');
                }
            });
        });
    }

    if (btnFiniquitos) {
        btnFiniquitos.dataset.contpaqiReady = '1';
        btnFiniquitos.addEventListener('click', async () => {
            await conBotonOcupado(btnFiniquitos, 'Exportando...', async () => {
                try {
                    const fechaInicio = document.getElementById('contpaqiFechaInicioMov')?.value || '';
                    const fechaFin = document.getElementById('contpaqiFechaFinMov')?.value || '';
                    const res = await window.api.contpaqiObtenerDatosFiniquitos({ empresaId: obtenerEmpresaId(), fechaInicio, fechaFin });
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible obtener los finiquitos.', 'error'); return; }
                    if (!res.data.length) { mostrarNotificacionLocal('No hay finiquitos/liquidaciones guardados para exportar.', 'error'); return; }
                    const guardado = await exportarTablaAExcel('Finiquitos_CONTPAQi', res.data);
                    if (guardado?.ok) { mostrarNotificacionLocal('Finiquitos y liquidaciones exportados.', 'success'); if (estadoExportar) estadoExportar.textContent = `Finiquitos: ${res.data.length} registro(s) exportado(s).${guardado.filePath ? ' Guardado en: ' + guardado.filePath : ''}`; await cargarHistorialContpaqi(); }
                } catch (err) {
                    console.error('Exportar finiquitos CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al exportar: ' + err.message, 'error');
                }
            });
        });
    }

    const btnImss = document.getElementById('btnContpaqiExportarImss');
    if (btnImss) {
        btnImss.dataset.contpaqiReady = '1';
        btnImss.addEventListener('click', async () => {
            const fechaInicio = document.getElementById('contpaqiFechaInicioMov')?.value;
            const fechaFin = document.getElementById('contpaqiFechaFinMov')?.value;
            if (!fechaInicio || !fechaFin) { mostrarNotificacionLocal('Indica el rango de fechas (del / al) antes de exportar.', 'error'); return; }
            await conBotonOcupado(btnImss, 'Exportando...', async () => {
                try {
                    const res = await window.api.contpaqiObtenerDatosMovimientosImss({ empresaId: obtenerEmpresaId(), fechaInicio, fechaFin });
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible obtener las altas/bajas.', 'error'); return; }
                    if (!res.data.length) { mostrarNotificacionLocal('No hay altas ni bajas en ese rango.', 'error'); return; }
                    const guardado = await exportarTablaAExcel('AltasBajas_IMSS_CONTPAQi', res.data);
                    if (guardado?.ok) { mostrarNotificacionLocal('Altas y bajas exportadas.', 'success'); if (estadoExportar) estadoExportar.textContent = `Altas/bajas: ${res.data.length} registro(s) exportado(s).${guardado.filePath ? ' Guardado en: ' + guardado.filePath : ''}`; await cargarHistorialContpaqi(); }
                } catch (err) {
                    console.error('Exportar IMSS CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al exportar: ' + err.message, 'error');
                }
            });
        });
    }

    const previewBox = document.getElementById('contpaqiPreviewImportacion');
    const previewResumen = document.getElementById('contpaqiPreviewResumen');
    const previewTbody = document.getElementById('contpaqiPreviewTbody');
    const btnConfirmar = document.getElementById('btnContpaqiConfirmarImportacion');
    const btnCancelar = document.getElementById('btnContpaqiCancelarImportacion');
    let filasPendientes = [];
    let archivoPendiente = '';

    const ETIQUETA_ACCION = { ALTA: 'Alta nueva', ACTUALIZACION: 'Actualización', INVALIDA: 'Omitida' };
    const COLOR_ACCION = { ALTA: '#166534', ACTUALIZACION: '#1d4ed8', INVALIDA: '#b91c1c' };

    const ocultarPreview = () => {
        filasPendientes = [];
        archivoPendiente = '';
        if (previewBox) previewBox.style.display = 'none';
        if (previewTbody) previewTbody.innerHTML = '';
    };

    const mostrarPreview = (res) => {
        filasPendientes = res.filas;
        archivoPendiente = res.archivo || '';
        if (previewResumen) {
            previewResumen.innerHTML = `<b>${res.resumen.altas}</b> alta(s) nueva(s) &nbsp;·&nbsp; <b>${res.resumen.actualizaciones}</b> actualización(es) &nbsp;·&nbsp; <b style="color:${res.resumen.invalidas ? '#b91c1c' : '#166534'}">${res.resumen.invalidas}</b> fila(s) omitida(s)`;
        }
        if (previewTbody) {
            previewTbody.innerHTML = res.filas.map(f => `
                <tr>
                    <td style="padding:5px 8px;color:${COLOR_ACCION[f.accion] || '#334155'};font-weight:600;">${ETIQUETA_ACCION[f.accion] || f.accion}</td>
                    <td style="padding:5px 8px;">${f.codigo || ''}</td>
                    <td style="padding:5px 8px;">${(f.nombre || '') + ' ' + (f.apellido || '')}</td>
                    <td style="padding:5px 8px;">${f.rfc || ''}</td>
                    <td style="padding:5px 8px;color:#92400e;">${f.motivo || ''}</td>
                </tr>
            `).join('');
        }
        if (previewBox) previewBox.style.display = 'block';
    };

    if (btnImportar) {
        btnImportar.dataset.contpaqiReady = '1';
        btnImportar.addEventListener('click', async () => {
            const empresaId = obtenerEmpresaId();
            if (!empresaId) { mostrarNotificacionLocal('Selecciona una empresa antes de importar.', 'error'); return; }
            ocultarPreview();
            await conBotonOcupado(btnImportar, 'Leyendo archivo...', async () => {
                if (estadoImportar) { estadoImportar.textContent = 'Seleccione el archivo Excel...'; estadoImportar.style.color = '#64748b'; }
                try {
                    mostrarBloqueoCarga('Leyendo archivo de CONTPAQi...');
                    let res = await window.api.contpaqiLeerEmpleadosExcel({ empresaId });

                    if (res?.requiereFormatoFecha) {
                        ocultarBloqueoCarga();
                        const formato = await preguntarFormatoFecha(res.ejemplos);
                        if (!formato) { if (estadoImportar) { estadoImportar.textContent = 'Importación cancelada.'; estadoImportar.style.color = '#64748b'; } return; }
                        mostrarBloqueoCarga('Leyendo archivo de CONTPAQi...');
                        res = await window.api.contpaqiLeerEmpleadosExcel({ empresaId, formatoFecha: formato, filePath: res.filePath });
                    }

                    if (res?.cancelado) { if (estadoImportar) estadoImportar.textContent = 'Importación cancelada.'; return; }
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible leer el archivo.', 'error'); if (estadoImportar) { estadoImportar.textContent = res?.error || 'Error al leer el archivo.'; estadoImportar.style.color = '#b91c1c'; } return; }
                    mostrarPreview(res);
                    if (estadoImportar) { estadoImportar.textContent = 'Revisa la vista previa y confirma para aplicar los cambios.'; estadoImportar.style.color = '#64748b'; }
                } catch (err) {
                    console.error('Leer archivo CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al leer el archivo: ' + err.message, 'error');
                    if (estadoImportar) { estadoImportar.textContent = 'Error: ' + err.message; estadoImportar.style.color = '#b91c1c'; }
                } finally {
                    ocultarBloqueoCarga();
                }
            });
        });
    }

    if (btnCancelar) {
        btnCancelar.addEventListener('click', () => {
            ocultarPreview();
            if (estadoImportar) { estadoImportar.textContent = 'Importación cancelada.'; estadoImportar.style.color = '#64748b'; }
        });
    }

    if (btnConfirmar) {
        btnConfirmar.addEventListener('click', async () => {
            const empresaId = obtenerEmpresaId();
            if (!empresaId || !filasPendientes.length) return;
            await conBotonOcupado(btnConfirmar, 'Importando...', async () => {
                try {
                    mostrarBloqueoCarga('Aplicando cambios en la base de datos...');
                    const res = await window.api.contpaqiConfirmarImportacionEmpleados({ empresaId, archivo: archivoPendiente, filas: filasPendientes });
                    if (!res?.ok) { mostrarNotificacionLocal(res?.error || 'No fue posible importar el archivo.', 'error'); if (estadoImportar) { estadoImportar.textContent = res?.error || 'Error al importar.'; estadoImportar.style.color = '#b91c1c'; } return; }
                    const resumen = `${res.creados || 0} alta(s), ${res.actualizados || 0} actualización(es)${res.totalErrores ? `, ${res.totalErrores} observación(es)` : ''}.`;
                    mostrarNotificacionLocal('Importación de CONTPAQi completada: ' + resumen, 'success');
                    if (estadoImportar) { estadoImportar.textContent = resumen; estadoImportar.style.color = res.totalErrores ? '#92400e' : '#166534'; }
                    ocultarPreview();
                    await cargarHistorialContpaqi();
                    if (typeof actualizarVistasPorEmpresa === 'function') await actualizarVistasPorEmpresa(empresaId);
                } catch (err) {
                    console.error('Confirmar importación CONTPAQi:', err);
                    mostrarNotificacionLocal('Error al importar: ' + err.message, 'error');
                    if (estadoImportar) { estadoImportar.textContent = 'Error: ' + err.message; estadoImportar.style.color = '#b91c1c'; }
                } finally {
                    ocultarBloqueoCarga();
                }
            });
        });
    }

    cargarHistorialContpaqi();
}

async function cargarHistorialContpaqi() {
    const tbody = document.getElementById('contpaqiHistorialTbody');
    if (!tbody || !window.api || typeof window.api.obtenerAuditoria !== 'function') return;
    try {
        const res = await window.api.obtenerAuditoria();
        const filas = (res?.data || []).filter(r => r.modulo === 'CONTPAQi').slice(0, 15);
        if (!filas.length) { tbody.innerHTML = '<tr><td colspan="3" style="padding:10px;color:#94a3b8;">Sin actividad todavía.</td></tr>'; return; }
        tbody.innerHTML = filas.map(r => `
            <tr>
                <td style="padding:5px 8px;white-space:nowrap;">${r.fecha || ''}</td>
                <td style="padding:5px 8px;">${r.accion || ''}</td>
                <td style="padding:5px 8px;">${r.detalle || ''}</td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Historial CONTPAQi:', err);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    console.log("✅ DOM Listo e Inicializando Módulos...");
    try {
        configurarSeguridadProfesional();
        configurarNavegacion();
        configurarVisorPdf();
        iniciarAutoRefrescoPanoramaLaboral();

        await cargarEmpresas();
        await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);

        configurarPerfilProfesional();
        configurarExportacionFichaPerfil();
        configurarCalendarioProfesional();
        configurarAdministracionProfesional();
        configurarFormularioEmpleado();
        configurarImportacionEmpleadosExcelV17();

        configurarAutocompletadoHistorialVacaciones();
        configurarBarraBusquedaYFiltros();

        configurarBuscadorEmpleado('buscarEmpVacaciones', 'resBusquedaVacaciones', 'idEmpVacacionesSeleccionado', window.onEmpleadoVacacionesSeleccionado);
        configurarBuscadorEmpleado('buscarEmpFiniquito', 'resBusquedaFiniquito', 'idEmpFiniquitoSeleccionado', null);
        configurarBuscadorEmpleado('buscarEmpIncidencia', 'resBusquedaIncidencia', 'idEmpIncidenciaSeleccionado', async (emp)=>{await actualizarSaldoIncidencia(emp.id);await cargarHistorialIncidencias();});
        configurarBotonLimpiarVacaciones();

        configurarModuloVacaciones();
        configurarEventosFormularios();
        configurarModuloFiniquitosV23();
        configurarModuloContratosV25();
        configurarModuloSalarios();
        configurarModuloAguinaldos();
        configurarBuscadorHistorialIncidenciasV16();
        configurarModuloIncidenciasManual();
        configurarModuloContpaqi();

        await cargarHistorialVacaciones();
        await refrescarModuloVacaciones();
        await cargarCalendarioProfesional();

        console.log("✅ Módulos inicializados.");
    } catch (err) {
        console.error("❌ Error durante la inicialización:", err);
    }
});

// Helper para ejecutar configuraciones sin tumbar el hilo principal
function ejecutarSiExiste(fn, nombreModulo) {
    try {
        if (typeof fn === 'function') {
            fn();
            console.log(`✅ ${nombreModulo} configurado.`);
        }
    } catch (err) {
        console.error(`❌ Error en ${nombreModulo}:`, err);
    }
}

// ==========================================
// 3. TABLA DE INTEGRACIÓN Y VACACIONES LFT (ÚNICA FUENTE)
// ==========================================
function obtenerFactorYVacaciones(aniosAntiguedad) {
    const aniosCumplidos = Math.floor(aniosAntiguedad);
    let diasVacaciones = 12;

    if (aniosCumplidos < 1) diasVacaciones = 0;
    else if (aniosCumplidos === 1) diasVacaciones = 12;
    else if (aniosCumplidos === 2) diasVacaciones = 14;
    else if (aniosCumplidos === 3) diasVacaciones = 16;
    else if (aniosCumplidos === 4) diasVacaciones = 18;
    else if (aniosCumplidos === 5) diasVacaciones = 20;
    else if (aniosCumplidos >= 6 && aniosCumplidos <= 10) diasVacaciones = 22;
    else if (aniosCumplidos >= 11 && aniosCumplidos <= 15) diasVacaciones = 24;
    else if (aniosCumplidos >= 16 && aniosCumplidos <= 20) diasVacaciones = 26;
    else if (aniosCumplidos >= 21 && aniosCumplidos <= 25) diasVacaciones = 28;
    else if (aniosCumplidos >= 26 && aniosCumplidos <= 30) diasVacaciones = 30;
    else if (aniosCumplidos > 30) diasVacaciones = 32;

    const diasParaFactor = diasVacaciones === 0 ? 12 : diasVacaciones;
    const factorExacto = (365 + 15 + (diasParaFactor * 0.25)) / 365;

    return { 
        diasVacaciones, 
        factor: factorExacto 
    };
}

// ==========================================
// 4. GENERADOR AUTOMÁTICO DE ID EMPLEADO
// ==========================================
function generarSiguienteNumEmpleado() {
    const inputNum = document.getElementById('expNumEmpleado');
    if (!inputNum) return;

    inputNum.readOnly = true;

    if (!window.listaEmpleadosEmpresa || window.listaEmpleadosEmpresa.length === 0) {
        inputNum.value = 'EMP-0001';
        return;
    }

    let maxNum = 0;
    window.listaEmpleadosEmpresa.forEach(emp => {
        const idTexto = emp.num_empleado || String(emp.id || '');
        if (idTexto) {
            const match = idTexto.match(/\d+/);
            if (match) {
                const num = parseInt(match[0], 10);
                if (num > maxNum) maxNum = num;
            }
        }
    });

    const siguiente = maxNum + 1;
    inputNum.value = `EMP-${String(siguiente).padStart(4, '0')}`;
}

// ==========================================
// 5. NAVEGACIÓN ENTRE MÓDULOS
// ==========================================
function limpiarContextoEmpleadoV21() {
    // Buscadores de empleado de todos los módulos.
    [
        'inputBusquedaEmpleado',
        'perfilBusqueda',
        'buscarEmpVacaciones',
        'buscarEmpFiniquito',
        'buscarEmpIncidencia',
        'buscarHistorialIncidenciasV16',
        'filtroHistorialTexto'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = '';
        el.removeAttribute('data-empleado-id');
        el.removeAttribute('data-id');
        delete el.dataset.empleadoId;
        delete el.dataset.empleadoIdSeleccionado;
    });

    // Resultados de autocompletado.
    [
        'perfilResultados',
        'resBusquedaVacaciones',
        'resBusquedaFiniquito',
        'resBusquedaIncidencia',
        'resBusquedaHistorialIncidenciasV16'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        el.style.display = 'none';
    });

    // Estado global de empleado seleccionado.
    window.empleadoPerfilSeleccionado = null;
    window.empleadoVacacionesSeleccionado = null;
    window.empleadoSeleccionado = null;
    if (window.estadoVacaciones) {
        window.estadoVacaciones.empleadoIdSeleccionado = null;
    }

    // Ficha del empleado: volver a estado vacío.
    const perfil = document.getElementById('perfilContenido');
    if (perfil) {
        perfil.innerHTML = `
            <div class="profile-empty">
                <i class="fa-solid fa-user-magnifying-glass"></i>
                <p>Selecciona un empleado para consultar su ficha.</p>
            </div>`;
    }

    const fichaPdf = document.getElementById('btnExportarFichaPdf');
    if (fichaPdf) fichaPdf.disabled = true;

    // Panel de saldo de vacaciones.
    const saldo = document.getElementById('resumenSaldoVacaciones');
    if (saldo) {
        saldo.innerHTML = `
            <div style="padding:18px;color:#64748b;text-align:center;">
                Seleccione un empleado para consultar sus días disponibles y ciclos futuros.
            </div>`;
    }

    // Simulación de finiquito: eliminar cualquier cálculo anterior al cambiar de módulo.
    const finIds = [
        'buscarEmpFiniquito','idEmpFiniquitoSeleccionado','finFechaBaja',
        'finSalarioFiscal','finSalarioReal','finISR','finIncluirIndemnizacion90','finDiasPendientes','finPorcentajePrimaAntiguedad','finObservaciones'
    ];
    finIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (id === 'finISR') el.value = '0';
        else if (id === 'finIncluirIndemnizacion90') el.value = '1';
        else if (id === 'finDiasPendientes') el.value = '0';
        else el.value = '';
        el.removeAttribute('data-empleado-id');
    });
    const resFin = document.getElementById('resBusquedaFiniquito');
    if (resFin) { resFin.innerHTML=''; resFin.style.display='none'; }
    const boxFin = document.getElementById('boxResultadoSimulacion');
    if (boxFin) boxFin.style.display='none';
    const msgFin = document.getElementById('mensajeFiniquitoV23');
    if (msgFin) msgFin.style.display='none';
    window.simulacionFiniquitoActual = null;
    window.peticionFiniquitoActual = null;
    window.empleadoFiniquitoSeleccionado = null;

    // Historial filtrado por empleado: dejarlo en estado neutral.
    const historial = document.getElementById('tablaHistorialVacaciones');
    if (historial) {
        historial.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;padding:20px;color:#64748b;">
                    Seleccione un empleado para consultar el historial.
                </td>
            </tr>`;
    }

    // Mantener foco libre; no se usan alertas ni modales aquí.
}


async function cargarResumenContratosV25() {
    const tbody = document.getElementById('tablaContratos');
    if (!tbody || !window.api?.obtenerResumenContratos) return;

    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;">Cargando contratos...</td></tr>';

    try {
        const res = await window.api.obtenerResumenContratos(window.empresaSeleccionadaId);
        if (!res?.ok) throw new Error(res?.error || 'No fue posible cargar los contratos.');

        const data = Array.isArray(res.data) ? res.data : [];
        const resumen = res.resumen || {};
        window.__contratosDataV25 = data;

        const setText = (id,val) => {
            const el=document.getElementById(id);
            if(el) el.textContent=String(val ?? 0);
        };
        setText('contratosActivos', resumen.activos);
        setText('contratosPorVencer', resumen.porVencer);
        setText('contratosVencidos', resumen.vencidos);
        setText('contratosSinContrato', resumen.sinContrato);

        if (!data.length) {
            tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:25px;color:#64748b;">No hay empleados registrados en la empresa seleccionada.</td></tr>';
            return;
        }

        const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));

        tbody.innerHTML=data.map(e=>{
            let badge='badge-secondary', label='SIN CONTRATO';
            if(e.estado==='ACTIVO'){badge='badge-success';label='ACTIVO';}
            else if(e.estado==='ACTIVO_SIN_VENCIMIENTO'){badge='badge-success';label='ACTIVO · SIN VENCIMIENTO';}
            else if(e.estado==='POR_VENCER'){badge='badge-warning';label='POR VENCER';}
            else if(e.estado==='VENCIDO'){badge='badge-danger';label='VENCIDO';}

            const dias=e.dias_para_vencer === null || e.dias_para_vencer === undefined ? '—' : e.dias_para_vencer;
            const pdf=e.ruta_contrato_pdf
                ? `<button type="button" class="btn btn-sm btn-secondary" onclick="abrirContratoV25(${Number(e.id)})"><i class="fa-solid fa-file-pdf"></i> Abrir</button>`
                : '—';

            return `<tr>
                <td><strong>${esc(`${e.nombre||''} ${e.apellido||''}`.trim())}</strong><br><small>${esc(e.num_empleado||'')}</small></td>
                <td>${esc(e.empresa_nombre||'')}</td>
                <td>${esc(e.puesto||'')}</td>
                <td>${esc(e.fecha_contrato||'—')}</td>
                <td>${esc(e.fecha_vencimiento_contrato||'—')}</td>
                <td><span class="badge ${badge}">${label}</span></td>
                <td>${dias}</td>
                <td>${pdf}</td>
            </tr>`;
        }).join('');
    } catch(error) {
        console.error('V25 contratos:',error);
        tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;padding:20px;color:#991b1b;">Error al cargar contratos: ${String(error.message||error)}</td></tr>`;
    }
}

window.abrirContratoV25 = async function(id) {
    try {
        const cache = Array.isArray(window.__contratosDataV25) ? window.__contratosDataV25 : [];
        let ruta = cache.find(e => Number(e.id) === Number(id))?.ruta_contrato_pdf;
        if (!ruta) {
            // Respaldo por si el caché no está disponible (recarga de módulo, etc.).
            const res = await window.api.obtenerEmpleadoPorId(id);
            ruta = res?.data?.ruta_contrato_pdf;
        }
        if(!ruta) return;
        const r=await window.api.abrirPdfContrato(ruta);
        if(!r?.ok) throw new Error(r?.error||'No se pudo abrir el PDF.');
    } catch(error) {
        console.error('V25 abrir contrato:',error);
    }
};

function configurarModuloContratosV25() {
    const btn=document.getElementById('btnActualizarContratos');
    if(btn && !btn.dataset.v25Ready) {
        btn.dataset.v25Ready='1';
        btn.addEventListener('click',cargarResumenContratosV25);
    }
    cargarResumenContratosV25();
}

function configurarNavegacion() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    const modules = document.querySelectorAll('.module-view');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-target');

            // IMPORTANTE: limpiar primero el empleado anterior.
            limpiarContextoEmpleadoV21();

            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            modules.forEach(mod => {
                mod.classList.toggle('active', mod.id === targetId);
            });

            if (targetId === 'mod-contratos') {
                setTimeout(() => cargarResumenContratosV25(), 30);
            }

            if (targetId === 'mod-calendario') {
                setTimeout(() => cargarCalendarioProfesional(), 30);
            }

            if (targetId === 'mod-salarios') {
                setTimeout(() => cargarPlantillaSalarios(), 30);
            }

            if (targetId === 'mod-aguinaldos') {
                setTimeout(() => cargarPlantillaAguinaldos(), 30);
            }

            // V31: al entrar al Panorama Laboral, siempre se ve con datos frescos,
            // sin necesidad de un botón de "actualizar".
            if (targetId === 'mod-dashboard') {
                refrescarPanoramaLaboral();
            }

            // Al entrar de nuevo, el buscador queda listo para escribir.
            const searchByModule = {
                'mod-expediente': 'inputBusquedaEmpleado',
                'mod-vacaciones': 'buscarEmpVacaciones',
                'mod-finiquitos': 'buscarEmpFiniquito',
                'mod-incidencias': 'buscarEmpIncidencia',
                'mod-contratos': null,
                'mod-dashboard': null,
                'mod-reportes': null,
                'mod-calendario': null,
                'mod-salarios': 'salBuscarEmpleado',
                'mod-aguinaldos': 'aguBuscarEmpleado'
            };
            const inputId = searchByModule[targetId];
            if (inputId) {
                setTimeout(() => {
                    document.getElementById(inputId)?.focus({preventScroll:true});
                }, 50);
            }
        });
    });
}

window.limpiarContextoEmpleadoV21 = limpiarContextoEmpleadoV21;

// ==========================================
// 6. CARGA DE EMPRESAS Y EMPLEADOS
// ==========================================
async function cargarEmpresas() {
    const selectGlobal = document.getElementById('selectEmpresaGlobal') || document.getElementById('selectEmpresa');
    const selectExpem = document.getElementById('expEmpresa');

    if (!window.api || typeof window.api.obtenerEmpresas !== 'function') {
        console.warn("⚠️ API IPC de empresas no disponible.");
        return;
    }

    try {
        const res = await window.api.obtenerEmpresas();
        let lista = [];

        if (res && res.ok && Array.isArray(res.data)) lista = res.data;
        else if (Array.isArray(res)) lista = res;

        if (lista.length > 0) {
            window.empresas = lista;
            if (selectGlobal) selectGlobal.innerHTML = '';
            if (selectExpem) selectExpem.innerHTML = '';

            lista.forEach(emp => {
                const nombre = emp.nombre || emp.razon_social || `Empresa ${emp.id}`;
                if (selectGlobal) selectGlobal.add(new Option(nombre, emp.id));
                if (selectExpem) selectExpem.add(new Option(nombre, emp.id));
            });

            window.empresaSeleccionadaId = lista[0].id;
            if (selectGlobal) selectGlobal.value = window.empresaSeleccionadaId;
            if (selectExpem) selectExpem.value = window.empresaSeleccionadaId;

            await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);

            if (selectGlobal) {
                selectGlobal.onchange = async (e) => {
                    window.empresaSeleccionadaId = Number(e.target.value);
                    window.estadoVacaciones.empresaIdActual = window.empresaSeleccionadaId;
                    if (selectExpem) selectExpem.value = window.empresaSeleccionadaId;
                    await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
                    const historialInput = document.getElementById('filtroHistorialTexto');
                    if (historialInput) { historialInput.value = ''; delete historialInput.dataset.empleadoId; }
                    await cargarHistorialVacaciones();
                };
            }
        }
    } catch (err) {
        console.error("❌ Error al cargar empresas:", err);
    }
}

async function actualizarVistasPorEmpresa(empresaId) {
    if (!window.api || typeof window.api.obtenerEmpleadosPorEmpresa !== 'function') return;

    try {
        const res = await window.api.obtenerEmpleadosPorEmpresa(empresaId);
        window.listaEmpleadosEmpresa = (res && res.ok) ? res.data : (Array.isArray(res) ? res : []);
        window.listaEmpleadosActuales = window.listaEmpleadosEmpresa.slice();
        window.listaEmpleadosFiltrados = window.listaEmpleadosEmpresa.slice();
        window.estadoVacaciones = window.estadoVacaciones || {};
        window.estadoVacaciones.empresaIdActual = Number(empresaId);
        window.estadoVacaciones.empleadoIdSeleccionado = null;
        window.empleadoVacacionesSeleccionado = null;
        window.empleadoFiniquitoSeleccionado = null;
        const hiddenVac = document.getElementById('idEmpVacacionesSeleccionado');
        if (hiddenVac) hiddenVac.value = '';
        const hiddenFin = document.getElementById('idEmpFiniquitoSeleccionado');
        if (hiddenFin) hiddenFin.value = '';
        const hiddenInc = document.getElementById('idEmpIncidenciaSeleccionado');
        if (hiddenInc) hiddenInc.value = '';

        const inputBusqueda = document.getElementById('inputBusquedaEmpleado') || document.getElementById('inputBusquedaEmpleados');
        if (inputBusqueda) inputBusqueda.value = '';
        
        aplicarFiltrosYRenderizarTabla();
        generarSiguienteNumEmpleado();
        // V31: cualquier cambio en la plantilla (alta, edición, baja, cambio de empresa)
        // debe reflejarse solo en el Panorama Laboral, sin refrescar a mano.
        refrescarPanoramaLaboral();
        if (document.getElementById('mod-salarios')?.classList.contains('active')) {
            cargarPlantillaSalarios();
        }
        if (document.getElementById('mod-aguinaldos')?.classList.contains('active')) {
            cargarPlantillaAguinaldos();
        }
    } catch (err) {
        console.error("❌ Error al actualizar vista por empresa:", err);
    }
}

// ==========================================
// 7. BÚSQUEDA Y FILTROS AVANZADOS
// ==========================================
function configurarBarraBusquedaYFiltros() {
    const inputBusqueda = document.getElementById('inputBusquedaEmpleado') || document.getElementById('inputBusquedaEmpleados');
    const btnToggleFiltros = document.getElementById('btnToggleFiltros');
    const menuFiltros = document.getElementById('menuFiltrosAvanzados');
    const btnAplicar = document.getElementById('btnAplicarFiltros');
    const btnLimpiar = document.getElementById('btnLimpiarFiltros');

    if (inputBusqueda) {
        inputBusqueda.addEventListener('input', () => aplicarFiltrosYRenderizarTabla());
    }

    if (btnToggleFiltros && menuFiltros) {
        btnToggleFiltros.addEventListener('click', (e) => {
            e.stopPropagation();
            menuFiltros.style.display = (menuFiltros.style.display === 'block') ? 'none' : 'block';
        });

        menuFiltros.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => menuFiltros.style.display = 'none');
    }

    if (btnAplicar) {
        btnAplicar.addEventListener('click', () => {
            aplicarFiltrosYRenderizarTabla();
            if (menuFiltros) menuFiltros.style.display = 'none';
        });
    }

    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', () => {
            const idsInputs = ['filtroSDMin', 'filtroSDMax', 'filtroSBCMin', 'filtroSBCMax', 'filtroFechaInicio', 'filtroFechaFin', 'filtroAntiguedadMin', 'filtroAntiguedadMax'];
            idsInputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            aplicarFiltrosYRenderizarTabla();
        });
    }
}

function aplicarFiltrosYRenderizarTabla() {
    const inputBusqueda = document.getElementById('inputBusquedaEmpleado') || document.getElementById('inputBusquedaEmpleados');
    const query = inputBusqueda ? inputBusqueda.value.toLowerCase().trim() : '';

    const sdMin = parseFloat(document.getElementById('filtroSDMin')?.value) || null;
    const sdMax = parseFloat(document.getElementById('filtroSDMax')?.value) || null;
    const sbcMin = parseFloat(document.getElementById('filtroSBCMin')?.value) || null;
    const sbcMax = parseFloat(document.getElementById('filtroSBCMax')?.value) || null;
    const fechaInicioStr = document.getElementById('filtroFechaInicio')?.value || null;
    const fechaFinStr = document.getElementById('filtroFechaFin')?.value || null;
    const antMin = parseFloat(document.getElementById('filtroAntiguedadMin')?.value) || null;
    const antMax = parseFloat(document.getElementById('filtroAntiguedadMax')?.value) || null;

    window.listaEmpleadosFiltrados = window.listaEmpleadosEmpresa.filter(emp => {
        const num = (emp.num_empleado || emp.id || '').toString().toLowerCase();
        const nom = `${emp.nombre || ''} ${emp.apellido || ''}`.toLowerCase();
        const puesto = (emp.puesto || '').toLowerCase();

        const coincideTexto = (query === '') || num.includes(query) || nom.includes(query) || puesto.includes(query);
        if (!coincideTexto) return false;

        const sd = parseFloat(emp.salario_diario) || 0;
        if (sdMin !== null && sd < sdMin) return false;
        if (sdMax !== null && sd > sdMax) return false;

        const sbc = parseFloat(emp.salario_base) || 0;
        if (sbcMin !== null && sbc < sbcMin) return false;
        if (sbcMax !== null && sbc > sbcMax) return false;

        if (fechaInicioStr && emp.fecha_ingreso < fechaInicioStr) return false;
        if (fechaFinStr && emp.fecha_ingreso > fechaFinStr) return false;

        if (antMin !== null || antMax !== null) {
            let aniosAntiguedad = 0;
            if (emp.fecha_ingreso) {
                const partes = emp.fecha_ingreso.split('-');
                if (partes.length === 3) {
                    const fIngreso = new Date(partes[0], partes[1] - 1, partes[2]);
                    const hoy = new Date();
                    const msPorDia = 1000 * 60 * 60 * 24;
                    const diasTrabajados = Math.max(0, Math.floor((hoy - fIngreso) / msPorDia));
                    aniosAntiguedad = diasTrabajados / 365;
                }
            }
            if (antMin !== null && aniosAntiguedad < antMin) return false;
            if (antMax !== null && aniosAntiguedad > antMax) return false;
        }

        return true;
    });

    renderizarTablaExpedientes(window.listaEmpleadosFiltrados);
}

// ==========================================
// 8. BUSCADOR AUTOCOMPLETADO REUTILIZABLE
// ==========================================
function configurarBuscadorEmpleado(inputId, resultsId, hiddenId, onSelectCallback) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    const hidden = document.getElementById(hiddenId);
    if (!input || !results) return;
    if (input.dataset.autocompleteConfigured === '1') return;
    input.dataset.autocompleteConfigured = '1';

    const normalizar = (res) => {
        if (res && res.ok && Array.isArray(res.data)) return res.data;
        if (Array.isArray(res)) return res;
        return [];
    };

    const cargarLista = async () => {
        if (Array.isArray(window.listaEmpleadosEmpresa) && window.listaEmpleadosEmpresa.length) return window.listaEmpleadosEmpresa;
        if (window.api && typeof window.api.obtenerEmpleadosPorEmpresa === 'function' && window.empresaSeleccionadaId) {
            try {
                const res = await window.api.obtenerEmpleadosPorEmpresa(Number(window.empresaSeleccionadaId));
                const lista = normalizar(res);
                window.listaEmpleadosEmpresa = lista;
                window.listaEmpleadosActuales = lista;
                return lista;
            } catch (err) {
                console.error('[Autocomplete] No se pudo cargar empleados:', err);
            }
        }
        return [];
    };

    const buscar = async () => {
        const query = input.value.trim().toLowerCase();
        const lista = await cargarLista();
        const filtrados = lista.filter(emp => {
            const nombre = obtenerNombreCompleto(emp).toLowerCase();
            const numero = String(emp.num_empleado || '').toLowerCase();
            const id = String(emp.id || '').toLowerCase();
            return !query || nombre.includes(query) || numero.includes(query) || id.includes(query);
        }).slice(0, 15);

        results.innerHTML = '';
        if (!query) { results.style.display = 'none'; return; }
        if (!filtrados.length) {
            results.innerHTML = '<div class="search-item" style="color:#64748b;">No hay coincidencias de empleados</div>';
        } else {
            filtrados.forEach(emp => {
                const div = document.createElement('div');
                div.className = 'search-item';
                div.innerHTML = `<strong>[${escapeHtml(emp.num_empleado || `ID ${emp.id}`)}]</strong> ${escapeHtml(obtenerNombreCompleto(emp))}`;
                div.addEventListener('mousedown', (ev) => ev.preventDefault());
                div.addEventListener('click', () => {
                    input.value = `${emp.num_empleado ? `[${emp.num_empleado}] ` : `[ID ${emp.id}] `}${obtenerNombreCompleto(emp)}`;
                    if (hidden) hidden.value = emp.id;
                    input.dataset.empleadoId = String(emp.id);
                    window.empleadoVacacionesSeleccionado = emp.id;
                    window.estadoVacaciones.empleadoIdSeleccionado = emp.id;
                    results.style.display = 'none';
                    if (typeof onSelectCallback === 'function') onSelectCallback(emp);
                    if (inputId === 'buscarEmpVacaciones') cargarHistorialVacaciones();
                });
                results.appendChild(div);
            });
        }
        results.style.display = 'block';
    };

    input.addEventListener('input', buscar);
    input.addEventListener('focus', () => { if (input.value.trim()) buscar(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.style.display = 'none'; });
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !results.contains(e.target)) results.style.display = 'none';
    });
}

function configurarBotonLimpiarVacaciones() {
    const boton = document.getElementById('btnLimpiarEmpleadoVacaciones');
    const input = document.getElementById('buscarEmpVacaciones');
    const hidden = document.getElementById('idEmpVacacionesSeleccionado');
    const resultados = document.getElementById('resBusquedaVacaciones');
    if (!boton || !input || boton.dataset.configured === '1') return;
    boton.dataset.configured = '1';
    boton.addEventListener('click', async () => {
        input.value = '';
        input.dataset.empleadoId = '';
        if (hidden) hidden.value = '';
        if (resultados) { resultados.innerHTML = ''; resultados.style.display = 'none'; }
        window.empleadoVacacionesSeleccionado = null;
        window.estadoVacaciones = window.estadoVacaciones || {};
        window.estadoVacaciones.empleadoIdSeleccionado = null;
        const resumen = document.getElementById('resumenSaldoVacaciones');
        if (resumen) resumen.innerHTML = '<div class="card" style="padding:18px;color:#64748b;">Seleccione un empleado para consultar sus días disponibles y ciclos futuros bloqueados.</div>';
        const tbody = document.getElementById('tablaHistorialVacaciones');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#64748b;">Seleccione un empleado para consultar su historial.</td></tr>';
        ['vacFechaInicio','vacFechaFin','vacDiasSolicitados','vacObservaciones'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
        input.focus();
    });
}

// ==========================================
// 9. EXPEDIENTE DIGITAL & PDF
// ==========================================

// Helpers Utilitarios Estandarizados (Compatibles con Módulo de Vacaciones)
function obtenerIdEmpleado(emp) {
    if (!emp) return '';
    return String(emp.num_empleado || emp.numero_empleado || emp.clave || emp.id_empleado || emp.id || '').trim();
}

function obtenerIdBaseDatos(emp) {
    if (!emp) return null;
    return emp.id || emp.id_empleado || emp.empresa_id || null;
}

function obtenerNombreCompleto(emp) {
    if (!emp) return 'Empleado Desconocido';
    if (emp.nombre_completo) return String(emp.nombre_completo).trim();
    if (emp.nombreCompleto) return String(emp.nombreCompleto).trim();

    const nom = emp.nombre || emp.nombres || emp.primer_nombre || '';
    const apPaterno = emp.apellido_paterno || emp.apellidoPaterno || emp.paterno || emp.apellido || '';
    const apMaterno = emp.apellido_materno || emp.apellidoMaterno || emp.materno || '';
    
    const completo = `${nom} ${apPaterno} ${apMaterno}`.trim();
    return completo || 'Empleado Sin Nombre';
}

function calcularAntiguedad(fechaIngresoStr) {
    if (!fechaIngresoStr) return 'N/A';
    const partes = fechaIngresoStr.split('-');
    if (partes.length !== 3) return 'N/A';
    
    const fechaIngreso = new Date(partes[0], partes[1] - 1, partes[2]);
    const hoy = new Date();
    
    let anos = hoy.getFullYear() - fechaIngreso.getFullYear();
    let meses = hoy.getMonth() - fechaIngreso.getMonth();

    // Bug corregido: si aún no se llega al día del aniversario dentro del mismo
    // mes, hay que "pedir prestado" un mes ANTES de revisar si meses quedó
    // negativo — si no, un caso como mismo-mes-pero-día-anterior (meses=0)
    // saltaba directo a "meses += 12" y mostraba "12 m" en vez de "11 m".
    if (hoy.getDate() < fechaIngreso.getDate()) meses--;
    if (meses < 0) {
        anos--;
        meses += 12;
    }

    if (anos === 0 && meses === 0) return 'Nuevo ingreso';
    if (anos === 0) return `${meses} m`;
    if (meses === 0) return `${anos} a`;
    return `${anos} a, ${meses} m`;
}

function renderizarTablaExpedientes(lista) {
    const tabla = document.getElementById('tablaExpedientes');
    if (!tabla) return;

    tabla.innerHTML = '';

    if (lista && lista.length > 0) {
        lista.forEach(emp => {
            const antiguedad = calcularAntiguedad(emp.fecha_ingreso);
            const tienePdf = emp.ruta_contrato_pdf && emp.ruta_contrato_pdf.trim() !== '';
            const esActivo = (emp.estatus || 'ACTIVO').toUpperCase() === 'ACTIVO';
            
            // Priorizamos la clave pública ('EMP-0005') para la interfaz, cayendo en 'id' si no existe
            const idPublico = obtenerIdEmpleado(emp);
            const idPrimarioBD = obtenerIdBaseDatos(emp) || idPublico;
            const nombreMostrar = obtenerNombreCompleto(emp);

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><b>${idPublico}</b></td>
                <td>${nombreMostrar}</td>
                <td>${emp.empresa_nombre || 'N/A'}</td>
                <td>$${Number(emp.salario_diario || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
                <td>$${Number(emp.salario_base || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
                <td>${emp.fecha_ingreso || 'N/A'}</td>
                <td><span class="badge badge-info">${antiguedad}</span></td>
                <td>
                    <div style="display:flex; gap:5px; align-items:center;">
                        ${tienePdf 
                            ? `<button class="btn btn-sm btn-info" onclick="abrirContrato('${emp.ruta_contrato_pdf.replace(/\\/g, '\\\\')}')">
                                 <i class="fa-solid fa-file-pdf"></i> Ver PDF
                               </button>`
                            : `<span style="color:#94a3b8; font-size: 0.8rem;"><i class="fa-solid fa-file-circle-xmark"></i> Sin PDF</span>`
                        }
                        <button class="btn btn-sm btn-secondary" title="Actualizar PDF" onclick="actualizarPdfEmpleado('${idPrimarioBD}')">
                            <i class="fa-solid fa-upload"></i>
                        </button>
                    </div>
                </td>
                <td>
                    <div style="display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;">
                        <button type="button" class="btn btn-sm btn-primary" title="Editar empleado"
                                onclick="editarEmpleadoV22('${idPrimarioBD}')">
                            <i class="fa-solid fa-pen-to-square"></i> Editar
                        </button>
                        <button type="button" class="btn btn-sm btn-danger" title="Borrar empleado"
                                onclick="borrarEmpleadoV22('${idPrimarioBD}')">
                            <i class="fa-solid fa-trash"></i> Borrar
                        </button>
                    </div>
                </td>
            `;
            tabla.appendChild(tr);
        });
    } else {
        tabla.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:15px; color:#64748b;">No se encontraron empleados.</td></tr>';
    }
}

window.abrirContrato = function(rutaPdf) {
    if (window.api && typeof window.api.abrirPdfContrato === 'function') {
        window.api.abrirPdfContrato(rutaPdf).then(async res => {
            if (res && !res.ok) await showAlert(res.error || 'Error al abrir el PDF.', 'Aviso', 'error');
        });
    }
};

window.actualizarPdfEmpleado = async function(empleadoId) {
    try {
        if (!window.api || typeof window.api.seleccionarPdfContrato !== 'function') return;
        const res = await window.api.seleccionarPdfContrato();
        if (res && res.ok && res.rutaPdf) {
            const respuesta = await window.api.actualizarEmpleado({ id: empleadoId, ruta_contrato_pdf: res.rutaPdf });
            if (respuesta && respuesta.ok) {
                await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
                await showAlert('Documento actualizado correctamente.', 'Aviso', 'success');
            } else await showAlert('Error al asociar el PDF: ' + (respuesta?.error || 'Desconocido'), 'Aviso', 'error');
        }
    } catch(error) { console.error(error); await showAlert('Error al asociar el PDF: ' + error.message, 'Aviso', 'error'); }
    finally { document.getElementById('expNombre')?.focus(); }
};


window.editarEmpleadoV22 = async function(empleadoId) {
    try {
        const id = Number(empleadoId);
        if (!id || !window.api?.obtenerEmpleadoPorId) return;

        const res = await window.api.obtenerEmpleadoPorId(id);
        if (!res?.ok || !res.data) {
            mostrarMensajeEmpleadoV22(res?.error || 'No fue posible cargar el empleado.');
            return;
        }

        const emp = res.data;
        const form = document.getElementById('formEmpleado');
        if (!form) return;

        form.dataset.editingId = String(emp.id);

        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value ?? '';
        };

        set('expEmpresa', emp.empresa_id);
        set('expNumEmpleado', emp.num_empleado);
        set('expNombre', emp.nombre);
        set('expApellido', emp.apellido);
        set('expPuesto', emp.puesto);
        set('expFechaIngreso', emp.fecha_ingreso);
        set('expFechaContrato', emp.fecha_contrato);
        set('expFechaVencimientoContrato', emp.fecha_vencimiento_contrato);
        set('expEdad', emp.edad);
        set('expRFC', emp.rfc);
        set('expNSS', emp.nss);
        set('expSalarioDiario', emp.salario_diario);
        set('expSalarioBase', emp.salario_base);
        set('expRutaPdf', emp.ruta_contrato_pdf);

        window.rutaPdfSeleccionada = emp.ruta_contrato_pdf || '';

        const btnGuardar = document.getElementById('btnGuardarEmpleadoV22');
        if (btnGuardar) {
            btnGuardar.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Actualizar Empleado';
        }
        const btnCancelar = document.getElementById('btnCancelarEdicionEmpleadoV22');
        if (btnCancelar) btnCancelar.style.display = 'inline-flex';

        document.getElementById('expNombre')?.focus({preventScroll:true});
        document.getElementById('formEmpleado')?.scrollIntoView({behavior:'smooth', block:'start'});
        mostrarMensajeEmpleadoV22(`Editando: ${emp.nombre || ''} ${emp.apellido || ''}`, 'info');
    } catch (error) {
        console.error('V22 editar empleado:', error);
        mostrarMensajeEmpleadoV22('Error al cargar el empleado: ' + error.message);
    }
};

window.borrarEmpleadoV22 = async function(empleadoId) {
    const id = Number(empleadoId);
    if (!id || !window.api?.eliminarEmpleado) return;

    const emp = Array.isArray(window.listaEmpleadosEmpresa)
        ? window.listaEmpleadosEmpresa.find(e => Number(e.id) === id)
        : null;
    const nombre = emp ? `${emp.nombre || ''} ${emp.apellido || ''}`.trim() : `ID ${id}`;

    const confirmar = await showConfirm(
        `¿Deseas borrar definitivamente a ${nombre}?\n\n` +
        `Se eliminará su registro y los registros asociados de vacaciones, incidencias y finiquito.\n` +
        `Esta acción no se puede deshacer.`,
        'Confirmar'
    );
    if (!confirmar) return;

    try {
        const res = await window.api.eliminarEmpleado(id);
        if (!res?.ok) {
            mostrarMensajeEmpleadoV22(res?.error || 'No fue posible borrar el empleado.');
            return;
        }

        const form = document.getElementById('formEmpleado');
        if (Number(form?.dataset.editingId || 0) === id) {
            cancelarEdicionEmpleadoV22();
        }

        await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
        mostrarMensajeEmpleadoV22(`Empleado ${nombre} eliminado correctamente.`, 'success');
        document.getElementById('inputBusquedaEmpleado')?.focus({preventScroll:true});
    } catch (error) {
        console.error('V22 borrar empleado:', error);
        mostrarMensajeEmpleadoV22('Error al borrar el empleado: ' + error.message);
    }
};

function mostrarMensajeEmpleadoV22(texto, tipo='error') {
    const box = document.getElementById('mensajeEmpleadoV17');
    if (!box) return;
    box.textContent = texto;
    box.style.display = 'block';
    box.style.background = tipo === 'success' ? '#dcfce7' : tipo === 'info' ? '#e0f2fe' : '#fee2e2';
    box.style.color = tipo === 'success' ? '#166534' : tipo === 'info' ? '#075985' : '#991b1b';
    box.style.border = tipo === 'success' ? '1px solid #86efac' : tipo === 'info' ? '1px solid #7dd3fc' : '1px solid #fca5a5';
}

function cancelarEdicionEmpleadoV22() {
    const form = document.getElementById('formEmpleado');
    if (!form) return;
    delete form.dataset.editingId;
    form.reset();
    window.rutaPdfSeleccionada = '';

    const ruta = document.getElementById('expRutaPdf');
    if (ruta) ruta.value = '';

    const btnGuardar = document.getElementById('btnGuardarEmpleadoV22');
    if (btnGuardar) btnGuardar.innerHTML = '<i class="fa-solid fa-save"></i> Guardar Expediente';

    const btnCancelar = document.getElementById('btnCancelarEdicionEmpleadoV22');
    if (btnCancelar) btnCancelar.style.display = 'none';

    document.getElementById('expNombre')?.focus({preventScroll:true});
}

function configurarVisorPdf() {
    const btnBuscarPdf = document.getElementById('btnBuscarPdf');
    if (!btnBuscarPdf) return;

    btnBuscarPdf.addEventListener('click', async () => {
        try {
            if (!window.api || typeof window.api.seleccionarPdfContrato !== 'function') {
                await showAlert('La función de selección de contratos PDF no está disponible. Cierra y vuelve a abrir la aplicación después de actualizar los archivos.', 'Aviso', 'error');
                return;
            }

            btnBuscarPdf.disabled = true;
            const res = await window.api.seleccionarPdfContrato();

            if (res && res.ok && res.rutaPdf) {
                window.rutaPdfSeleccionada = res.rutaPdf;
                const inputRuta = document.getElementById('expRutaPdf');
                if (inputRuta) inputRuta.value = res.rutaPdf;
                btnBuscarPdf.title = 'PDF seleccionado correctamente';
                btnBuscarPdf.classList.add('pdf-selected');
            } else if (res && res.error) {
                await showAlert('No se pudo seleccionar el contrato: ' + res.error, 'Aviso', 'error');
            }
        } catch (error) {
            console.error('Error al seleccionar contrato PDF:', error);
            await showAlert('Ocurrió un error al seleccionar el contrato PDF.', 'Aviso', 'error');
        } finally {
            btnBuscarPdf.disabled = false;
        }
    });
}

function configurarFormularioEmpleado() {
    const form = document.getElementById('formEmpleado');
    if (!form) return;

    const inputNumEmpleado = document.getElementById('expNumEmpleado');
    const inputSalarioDiario = document.getElementById('expSalarioDiario');
    const inputFechaIngreso = document.getElementById('expFechaIngreso');
    const inputEdad = document.getElementById('expEdad');
    const inputRFC = document.getElementById('expRFC');
    const inputNSS = document.getElementById('expNSS');
    const inputSalarioBase = document.getElementById('expSalarioBase');

    if (inputSalarioBase) inputSalarioBase.readOnly = true;

    const autoCalcularSalarioBase = () => {
        const salarioDiario = parseFloat(inputSalarioDiario?.value) || 0;
        const fechaIngresoStr = inputFechaIngreso?.value;

        if (salarioDiario <= 0) {
            if (inputSalarioBase) inputSalarioBase.value = '';
            return;
        }

        let aniosAntiguedad = 0;
        if (fechaIngresoStr) {
            const partes = fechaIngresoStr.split('-');
            if (partes.length === 3) {
                const fIngreso = new Date(partes[0], partes[1] - 1, partes[2]);
                const hoy = new Date();
                const msPorDia = 1000 * 60 * 60 * 24;
                const diasTrabajados = Math.max(0, Math.floor((hoy - fIngreso) / msPorDia));
                aniosAntiguedad = diasTrabajados / 365;
            }
        }

        if (typeof obtenerFactorYVacaciones === 'function') {
            const { factor } = obtenerFactorYVacaciones(aniosAntiguedad);
            if (inputSalarioBase) inputSalarioBase.value = (salarioDiario * factor).toFixed(2);
        }
    };

    if (inputSalarioDiario) inputSalarioDiario.addEventListener('input', autoCalcularSalarioBase);
    if (inputFechaIngreso) inputFechaIngreso.addEventListener('change', autoCalcularSalarioBase);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const rfcCapturado = (inputRFC?.value || '').trim().toUpperCase();
        const nssCapturado = (inputNSS?.value || '').trim();

        const mostrarMensajeEmpleadoV17 = (texto, tipo = 'error') => {
            const box = document.getElementById('mensajeEmpleadoV17');
            if (!box) return;
            box.textContent = texto;
            box.style.display = 'block';
            box.style.background = tipo === 'success' ? '#dcfce7' : '#fee2e2';
            box.style.color = tipo === 'success' ? '#166534' : '#991b1b';
            box.style.border = tipo === 'success' ? '1px solid #86efac' : '1px solid #fca5a5';
        };

        if (!/^[A-Z0-9]{12,13}$/.test(rfcCapturado)) {
            mostrarMensajeEmpleadoV17('El RFC es obligatorio y debe contener exactamente 12 o 13 caracteres alfanuméricos.');
            inputRFC?.focus({preventScroll:true});
            return;
        }

        if (!/^\d{11}$/.test(nssCapturado)) {
            mostrarMensajeEmpleadoV17('El NSS es obligatorio y debe contener exactamente 11 dígitos.');
            inputNSS?.focus({preventScroll:true});
            return;
        }

        const nuevoEmpleado = {
            empresa_id: Number(document.getElementById('expEmpresa')?.value || window.empresaSeleccionadaId),
            num_empleado: inputNumEmpleado ? inputNumEmpleado.value.trim() : '',
            nombre: document.getElementById('expNombre')?.value.trim() || '',
            apellido: document.getElementById('expApellido')?.value.trim() || '',
            puesto: document.getElementById('expPuesto')?.value.trim() || '',
            fecha_ingreso: document.getElementById('expFechaIngreso')?.value || '',
            edad: Number(inputEdad?.value || 0) || null,
            fecha_contrato: document.getElementById('expFechaContrato')?.value || '',
            fecha_vencimiento_contrato: document.getElementById('expFechaVencimientoContrato')?.value || '',
            rfc: rfcCapturado,
            nss: nssCapturado,
            salario_diario: parseFloat(inputSalarioDiario?.value) || 0,
            salario_base: parseFloat(inputSalarioBase?.value) || 0,
            ruta_contrato_pdf: document.getElementById('expRutaPdf')?.value || window.rutaPdfSeleccionada || ''
        };

        const editId = Number(form.dataset.editingId || 0);
        const esEdicion = Number.isInteger(editId) && editId > 0;
        const apiGuardar = esEdicion
            ? window.api?.actualizarEmpleado
            : window.api?.crearEmpleado;

        if (typeof apiGuardar === 'function') {
            const btnSubmitV22 = document.getElementById('btnGuardarEmpleadoV22');
            if (btnSubmitV22) btnSubmitV22.disabled = true;
            let res;
            try {
                const payloadGuardar = esEdicion ? { ...nuevoEmpleado, id: editId } : nuevoEmpleado;
                res = await apiGuardar(payloadGuardar);
            } finally {
                if (btnSubmitV22) btnSubmitV22.disabled = false;
            }
            if (res && res.ok) {
                const msgOk = document.getElementById('mensajeEmpleadoV17');
                if (msgOk) msgOk.style.display = 'none';
                form.reset();
                delete form.dataset.editingId;
                const btnGuardarV22 = document.getElementById('btnGuardarEmpleadoV22');
                if (btnGuardarV22) {
                    btnGuardarV22.innerHTML = '<i class="fa-solid fa-save"></i> Guardar Expediente';
                }
                const btnCancelarV22 = document.getElementById('btnCancelarEdicionEmpleadoV22');
                if (btnCancelarV22) btnCancelarV22.style.display = 'none';

                const expRuta = document.getElementById('expRutaPdf');
                if (expRuta) expRuta.value = '';
                const expFechaContrato = document.getElementById('expFechaContrato');
                const expFechaVencimientoContrato = document.getElementById('expFechaVencimientoContrato');
                if (expFechaContrato) expFechaContrato.value = '';
                if (expFechaVencimientoContrato) expFechaVencimientoContrato.value = '';
                window.rutaPdfSeleccionada = '';

                await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
                const inputNombre = document.getElementById('expNombre');
                if (inputNombre) inputNombre.focus();
            } else {
                const mensaje = res?.error || 'Error desconocido';
                const box = document.getElementById('mensajeEmpleadoV17');
                if (box) {
                    box.textContent = mensaje;
                    box.style.display = 'block';
                    box.style.background = '#fee2e2';
                    box.style.color = '#991b1b';
                    box.style.border = '1px solid #fca5a5';
                }
                // Mantener el foco en el campo que corresponde al problema,
                // sin cerrar modal ni bloquear el formulario.
                const msg = mensaje.toLowerCase();
                if (msg.includes('rfc')) inputRFC?.focus({preventScroll:true});
                else if (msg.includes('nss')) inputNSS?.focus({preventScroll:true});
                else if (msg.includes('número de empleado')) inputNumEmpleado?.focus({preventScroll:true});
                else form.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"])')?.focus({preventScroll:true});
            }
        }
    });

    const btnCancelarEdicionV22 = document.getElementById('btnCancelarEdicionEmpleadoV22');
    if (btnCancelarEdicionV22 && !btnCancelarEdicionV22.dataset.ready) {
        btnCancelarEdicionV22.dataset.ready = '1';
        btnCancelarEdicionV22.addEventListener('click', cancelarEdicionEmpleadoV22);
    }
}

// ==========================================
// ESTADO GLOBAL COMPLEMENTARIO (PROTEGIDO)
// ==========================================
if (typeof window.saldoUsableModuloVacaciones === 'undefined') window.saldoUsableModuloVacaciones = 0;
if (typeof window.empleadoVacacionesSeleccionado === 'undefined') window.empleadoVacacionesSeleccionado = null;
if (typeof window.empleadoFiniquitoSeleccionado === 'undefined') window.empleadoFiniquitoSeleccionado = null;
if (typeof window.simulacionFiniquitoActual === 'undefined') window.simulacionFiniquitoActual = null;
if (typeof window.peticionFiniquitoActual === 'undefined') window.peticionFiniquitoActual = null;

// Días festivos oficiales según la LFT México
const DIAS_FESTIVOS_MEX = [
    '2026-01-01', '2026-02-02', '2026-03-16', 
    '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25'
];

// Helper Garantizado para Obtener Empleados
async function obtenerEmpleadosGarantizado() {
    if (Array.isArray(window.listaEmpleadosEmpresa) && window.listaEmpleadosEmpresa.length > 0) {
        return window.listaEmpleadosEmpresa;
    }
    if (window.api && typeof window.api.obtenerEmpleadosPorEmpresa === 'function' && window.empresaSeleccionadaId) {
        try {
            const res = await window.api.obtenerEmpleadosPorEmpresa(window.empresaSeleccionadaId);
            const lista = (res && res.ok) ? res.data : (Array.isArray(res) ? res : []);
            window.listaEmpleadosEmpresa = lista;
            return lista;
        } catch (err) {
            console.error("❌ Error al recuperar empleados en el módulo:", err);
            return [];
        }
    }
    return [];
}

// Helper para coincidencias de Búsqueda
function coincideEmpleado(emp, query) {
    if (!emp || !query) return false;
    const q = query.toLowerCase().trim();
    const idEmp = obtenerIdEmpleado(emp).toLowerCase();
    const nomEmp = obtenerNombreCompleto(emp).toLowerCase();
    return idEmp.includes(q) || nomEmp.includes(q);
}
// Helper seguro para obtener las APIs expuestas por preload
function getAPI() {
    return window.api || window.electronAPI || {};
}

// ============================================================================
// DESPLEGABLE Y SUGERENCIAS DE BÚSQUEDA (CON 'APELLIDO' UNIFICADO)
// ============================================================================

function renderizarSugerenciasBuscador(query) {
    const inputBuscar = document.getElementById('buscarEmpVacaciones') || document.getElementById('input-buscar-empleado');
    const contenedor = document.getElementById('resBusquedaVacaciones') || document.getElementById('dropdown-sugerencias-empleados');
    if (!inputBuscar || !contenedor) return;
    if (!query) { contenedor.innerHTML = ''; contenedor.style.display = 'none'; return; }
    const q = query.toLowerCase().trim();
    const lista = Array.isArray(window.listaEmpleadosEmpresa) ? window.listaEmpleadosEmpresa : [];
    const coincidencias = lista.filter(emp => {
        const nombre = obtenerNombreCompleto(emp).toLowerCase();
        const folio = String(emp.num_empleado || '').toLowerCase();
        const id = String(emp.id || '').toLowerCase();
        return nombre.includes(q) || folio.includes(q) || id.includes(q);
    }).slice(0, 20);
    if (!coincidencias.length) {
        contenedor.innerHTML = '<div style="padding:8px 12px; color:#94a3b8; font-size:0.85rem;">No se encontraron coincidencias</div>';
        contenedor.style.display = 'block'; return;
    }
    contenedor.innerHTML = coincidencias.map(emp => `<div class="search-item" data-id="${emp.id}"><strong>[${emp.num_empleado || `ID ${emp.id}`}]</strong> ${obtenerNombreCompleto(emp)}</div>`).join('');
    contenedor.querySelectorAll('.search-item').forEach((item,index) => item.addEventListener('click', () => seleccionarEmpleadoBuscador(coincidencias[index].id, obtenerNombreCompleto(coincidencias[index]))));
    contenedor.style.display = 'block';
}

// ============================================================================
// AUTOCOMPLETADO DEL BUSCADOR DEL HISTORIAL
// ============================================================================

function configurarAutocompletadoHistorialVacaciones() {
    const input = document.getElementById('filtroHistorialTexto');
    const resultados = document.getElementById('resFiltroHistorialTexto');
    if (!input || !resultados || input.dataset.autocompleteConfigured === '1') return;
    input.dataset.autocompleteConfigured = '1';

    const buscar = async () => {
        const query = input.value.trim().toLowerCase();
        resultados.innerHTML = '';
        delete input.dataset.empleadoId;
        if (!query) {
            resultados.style.display = 'none';
            cargarHistorialVacaciones();
            return;
        }

        let lista = Array.isArray(window.listaEmpleadosEmpresa) ? window.listaEmpleadosEmpresa : [];
        if (!lista.length && window.api?.obtenerEmpleadosPorEmpresa && window.empresaSeleccionadaId) {
            const res = await window.api.obtenerEmpleadosPorEmpresa(Number(window.empresaSeleccionadaId));
            lista = normalizarArreglo(res);
            window.listaEmpleadosEmpresa = lista;
            window.listaEmpleadosActuales = lista.slice();
        }

        const coincidencias = lista.filter(emp => {
            const nombre = obtenerNombreCompleto(emp).toLowerCase();
            const folio = String(emp.num_empleado || '').toLowerCase();
            const id = String(emp.id || '').toLowerCase();
            return nombre.includes(query) || folio.includes(query) || id.includes(query);
        }).slice(0, 12);

        if (!coincidencias.length) {
            resultados.innerHTML = '<div class="search-item" style="color:#64748b;">No hay coincidencias de empleados</div>';
        } else {
            coincidencias.forEach(emp => {
                const div = document.createElement('div');
                div.className = 'search-item';
                div.style.cssText = 'padding:9px 12px;cursor:pointer;border-bottom:1px solid #e2e8f0;background:#fff;';
                div.innerHTML = `<strong>[${escapeHtml(emp.num_empleado || `ID ${emp.id}`)}]</strong> ${escapeHtml(obtenerNombreCompleto(emp))}`;
                div.addEventListener('mouseenter', () => div.style.background = '#f8fafc');
                div.addEventListener('mouseleave', () => div.style.background = '#fff');
                div.addEventListener('click', async () => {
                    input.value = `${emp.num_empleado ? `[${emp.num_empleado}] ` : ''}${obtenerNombreCompleto(emp)}`;
                    input.dataset.empleadoId = String(emp.id);
                    resultados.style.display = 'none';
                    window.empleadoVacacionesSeleccionado = Number(emp.id);
                    window.estadoVacaciones = window.estadoVacaciones || {};
                    window.estadoVacaciones.empleadoIdSeleccionado = Number(emp.id);
                    const hidden = document.getElementById('idEmpVacacionesSeleccionado');
                    if (hidden) hidden.value = emp.id;
                    await refrescarModuloVacaciones();
                    await cargarHistorialVacaciones();
                });
                resultados.appendChild(div);
            });
        }
        resultados.style.display = 'block';
    };

    input.addEventListener('input', buscar);
    input.addEventListener('focus', () => { if (input.value.trim()) buscar(); });
    document.addEventListener('click', e => {
        if (!input.contains(e.target) && !resultados.contains(e.target)) resultados.style.display = 'none';
    });
}
// ============================================================================
// CARGA DE HISTORIAL DE VACACIONES (CON VERIFICACIÓN DE API)
// ============================================================================

async function cargarHistorialVacaciones() {
    const tbody=document.getElementById('tablaHistorialVacaciones');
    if(!tbody) return;
    const input=document.getElementById('filtroHistorialTexto');
    const texto=input?.value?.trim() || '';
    const empleadoId=input?.dataset?.empleadoId || window.estadoVacaciones?.empleadoIdSeleccionado || null;
    const estatus=document.getElementById('filtroHistorialEstatus')?.value || 'TODOS';
    const fechaInicio=document.getElementById('filtroHistorialFechaInicio')?.value || '';
    const fechaFin=document.getElementById('filtroHistorialFechaFin')?.value || '';
    tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:#64748b;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando historial...</td></tr>';
    try {
        const api=getAPI();
        if(typeof api.obtenerHistorialVacaciones!=='function') throw new Error('La API de historial de vacaciones no está disponible.');
        const res=await api.obtenerHistorialVacaciones({empresaId:window.empresaSeleccionadaId||null,empleadoId,texto,estatus,fechaInicio,fechaFin});
        if(!res||!res.ok) throw new Error(res?.error||'No fue posible consultar el historial.');
        renderizarTablaHistorial(res.data||[]);
    } catch(err) {
        console.error('[Renderer] Error consultando historial:',err);
        tbody.innerHTML=`<tr><td colspan="7" style="text-align:center;padding:20px;color:#dc2626;">Error al cargar el historial: ${err.message}</td></tr>`;
    }
}

function renderizarTablaHistorial(historial) {
    const tbody=document.getElementById('tablaHistorialVacaciones');
    if(!tbody) return;
    if(!Array.isArray(historial)||historial.length===0){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:#64748b;">No se encontraron registros de vacaciones.</td></tr>';return;}
    tbody.innerHTML=historial.map(item=>{
        const nombre=item.nombre_completo||`${item.nombre||''} ${item.apellido||''}`.trim()||'N/A';
        const folio=item.num_empleado||`ID ${item.empleado_id}`;
        const fechas=item.fecha_fin?`${item.fecha_inicio} al ${item.fecha_fin}`:(item.fecha_inicio||'N/A');
        const estado=String(item.estado||'').toUpperCase();
        const activo=['APROBADA','APROBADO','APLICADO'].includes(estado);
        const badge=activo?'<span class="badge badge-success">Otorgado</span>':estado==='PENDIENTE'?'<span class="badge badge-warning">Pendiente</span>':'<span class="badge badge-danger">Cancelado</span>';
        const accion=item.tipo==='GOCE'&&activo?`<button type="button" class="btn btn-sm btn-danger" onclick="cancelarSolicitud(${item.id})"><i class="fa-solid fa-ban"></i> Cancelar</button>`:'-';
        return `<tr><td style="padding:10px;"><strong>${folio}</strong><br><small>#${item.id}</small></td><td style="padding:10px;">${nombre}</td><td style="padding:10px;">${fechas}</td><td style="padding:10px;">${Number(item.dias||0)}</td><td style="padding:10px;">${badge}</td><td style="padding:10px;"><small>${item.observaciones||''}</small></td><td style="padding:10px;text-align:center;">${accion}</td></tr>`;
    }).join('');
}
window.cargarHistorialVacaciones=cargarHistorialVacaciones;

// ============================================================================
// GESTIÓN DE FORMULARIOS Y ACCIONES
// ============================================================================

function mostrarNotificacionLocal(mensaje,tipo='info'){let b=document.getElementById('notificacionLocalRRHH');if(!b){b=document.createElement('div');b.id='notificacionLocalRRHH';b.style.cssText='position:fixed;right:24px;top:24px;z-index:2147483647;max-width:420px;padding:14px 18px;border-radius:10px;box-shadow:0 10px 30px rgba(15,23,42,.18);font-family:Segoe UI,Arial,sans-serif;font-weight:600;display:none;';document.body.appendChild(b);}b.textContent=mensaje;b.style.background=tipo==='error'?'#fee2e2':'#dcfce7';b.style.color=tipo==='error'?'#991b1b':'#166534';b.style.display='block';clearTimeout(b._timer);b._timer=setTimeout(()=>b.style.display='none',3500);}
function configurarEventosFormularios() {
    const form = document.getElementById('formSolicitudVacaciones');
    if (!form || form.dataset.configured === '1') return;
    form.dataset.configured = '1';

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const empleadoId = Number(
            document.getElementById('idEmpVacacionesSeleccionado')?.value ||
            window.estadoVacaciones?.empleadoIdSeleccionado ||
            window.empleadoVacacionesSeleccionado ||
            0
        );
        const fechaInicio = document.getElementById('vacFechaInicio')?.value || '';
        const fechaFin = document.getElementById('vacFechaFin')?.value || '';
        const dias = Number(document.getElementById('vacDiasSolicitados')?.value || 0);
        const observaciones = document.getElementById('vacObservaciones')?.value || '';

        if (!empleadoId) {
            await showAlert('Seleccione un empleado antes de registrar las vacaciones.', 'Validación', 'warning');
            return;
        }
        if (!fechaInicio || !fechaFin) {
            await showAlert('Complete la fecha de inicio y la fecha de fin.', 'Validación', 'warning');
            return;
        }
        if (fechaFin < fechaInicio) {
            await showAlert('La fecha de fin no puede ser anterior a la fecha de inicio.', 'Validación', 'warning');
            return;
        }
        if (!Number.isFinite(dias) || dias <= 0) {
            await showAlert('Indique una cantidad válida de días de vacaciones.', 'Validación', 'warning');
            return;
        }

        const boton = form.querySelector('button[type="submit"]');
        if (boton) {
            boton.disabled = true;
            boton.dataset.textoOriginal = boton.innerHTML;
            boton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registrando...';
        }

        try {
            const res = await window.api.solicitarGoceVacaciones({
                empleadoId,
                fechaInicio,
                fechaFin,
                dias,
                observaciones
            });

            if (!res || !res.ok) {
                throw new Error(res?.error || 'No fue posible registrar la solicitud.');
            }

            mostrarNotificacionLocal('Vacaciones registradas correctamente.', 'success');
            form.reset();

            // Mantener al empleado seleccionado; no recargar la aplicación ni regresar al login.
            const hidden = document.getElementById('idEmpVacacionesSeleccionado');
            if (hidden) hidden.value = String(empleadoId);
            window.empleadoVacacionesSeleccionado = empleadoId;
            window.estadoVacaciones = window.estadoVacaciones || {};
            window.estadoVacaciones.empleadoIdSeleccionado = empleadoId;

            Promise.resolve(refrescarModuloVacaciones()).catch(err => console.warn('Actualización posterior de vacaciones:', err));
            refrescarPanoramaLaboral();
        } catch (error) {
            console.error('Error al registrar vacaciones:', error);
            mostrarNotificacionLocal(`Error al registrar vacaciones: ${error.message}`, 'error');
        } finally {
            if (boton) {
                boton.disabled = false;
                boton.innerHTML = boton.dataset.textoOriginal || '<i class="fa-solid fa-check"></i> Registrar Vacaciones';
            }
        }
    });
}

function mostrarDialogoCancelacion() {
    return new Promise(resolve => {
        const existente = document.getElementById('modalConfirmacionCancelacion');
        if (existente) existente.remove();

        const overlay = document.createElement('div');
        overlay.id = 'modalConfirmacionCancelacion';
        overlay.innerHTML = `
          <div style="position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:20px;">
            <div role="dialog" aria-modal="true" style="width:min(430px,100%);background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);padding:24px;">
              <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
                <div style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#fee2e2;color:#b91c1c;"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <h3 style="margin:0;color:#0f172a;">Cancelar solicitud</h3>
              </div>
              <p style="margin:0 0 22px;color:#475569;">¿Desea cancelar esta solicitud de vacaciones? Los días consumidos serán devueltos al saldo correspondiente.</p>
              <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button type="button" id="cancelarDialogoNo" class="btn btn-secondary">No, conservar</button>
                <button type="button" id="cancelarDialogoSi" class="btn btn-danger">Sí, cancelar</button>
              </div>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        const cerrar = (valor) => {
            overlay.remove();
            resolve(valor);
        };
        overlay.querySelector('#cancelarDialogoNo').addEventListener('click', () => cerrar(false));
        overlay.querySelector('#cancelarDialogoSi').addEventListener('click', () => cerrar(true));
        overlay.addEventListener('click', e => { if (e.target === overlay.firstElementChild) cerrar(false); });
        setTimeout(() => overlay.querySelector('#cancelarDialogoNo')?.focus(), 0);
    });
}

function mostrarAvisoNoBloqueante(mensaje, tipo='success') {
    const id='avisoCancelacionVacaciones';
    document.getElementById(id)?.remove();
    const el=document.createElement('div');
    el.id=id;
    el.innerHTML=`<div style="position:fixed;right:24px;bottom:24px;z-index:2147483646;background:${tipo==='success'?'#ecfdf5':'#fef2f2'};color:${tipo==='success'?'#166534':'#991b1b'};border:1px solid ${tipo==='success'?'#86efac':'#fecaca'};border-radius:10px;padding:12px 16px;box-shadow:0 8px 25px rgba(0,0,0,.15);font-weight:600;">${escapeHtml(mensaje)}</div>`;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),3500);
}

async function cancelarSolicitud(solicitudId) {
    const confirmado = await mostrarDialogoCancelacion();
    if (!confirmado) {
        setTimeout(()=>document.getElementById('buscarEmpVacaciones')?.focus({preventScroll:true}),0);
        return;
    }

    const botonOrigen = document.activeElement;
    if (botonOrigen && typeof botonOrigen.blur === 'function') botonOrigen.blur();

    try {
        const promesa = window.api.cancelarSolicitudVacaciones(solicitudId);
        const res = await Promise.race([
            promesa,
            new Promise(resolve => setTimeout(() => resolve({ok:false,error:'La operación tardó demasiado. No se bloqueará la interfaz; verifica el historial antes de repetirla.'}), 12000))
        ]);

        if (res.ok) {
            mostrarAvisoNoBloqueante('Solicitud cancelada correctamente.');
            await refrescarModuloVacaciones();
            refrescarPanoramaLaboral();
        } else {
            mostrarAvisoNoBloqueante(`No se pudo cancelar: ${res.error || 'Error desconocido.'}`,'error');
        }
    } catch (error) {
        console.error('Error al cancelar solicitud:', error);
        mostrarAvisoNoBloqueante(`No se pudo cancelar: ${error.message}`,'error');
    } finally {
        document.querySelectorAll('#mod-vacaciones input, #mod-vacaciones select, #mod-vacaciones textarea, #mod-vacaciones button').forEach(el => {
            el.disabled = false;
            el.removeAttribute('aria-disabled');
            if (el.dataset.bloqueadoPorCancelacion === '1') delete el.dataset.bloqueadoPorCancelacion;
        });
        document.body.classList.remove('modal-open','loading');
        const buscador=document.getElementById('buscarEmpVacaciones');
        setTimeout(()=>{
            try { buscador?.focus({preventScroll:true}); } catch(_) { buscador?.focus(); }
        },50);
    }
}

// Exposición al scope global para listeners `onclick` dinámicos
window.cancelarSolicitud = cancelarSolicitud;

// La inicialización consolidada se realiza en el único DOMContentLoaded principal.
// ==========================================
// 4. MÓDULO DE FINIQUITOS
// ==========================================

function formatoMonedaV23(n) {
    return Number(n || 0).toLocaleString('es-MX', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function mensajeFiniquitoV23(texto, tipo='error') {
    const el = document.getElementById('mensajeFiniquitoV23');
    if (!el) return;
    el.textContent = texto;
    el.style.display = 'block';
    el.style.background = tipo === 'ok' ? '#dcfce7' : tipo === 'info' ? '#e0f2fe' : '#fee2e2';
    el.style.color = tipo === 'ok' ? '#166534' : tipo === 'info' ? '#075985' : '#991b1b';
    el.style.border = tipo === 'ok' ? '1px solid #86efac' : tipo === 'info' ? '1px solid #7dd3fc' : '1px solid #fca5a5';
}

function renderizarSimulacionFiniquitoV23(sim) {
    const box=document.getElementById('boxResultadoSimulacion'); if(!box)return;
    const fmt=formatoMonedaV23;
    const rows=[
      ['Sueldo pendiente',`${sim.dias_sueldo_pendiente} días`,sim.sueldo_pendiente_fiscal,sim.sueldo_pendiente_real],
      ['Aguinaldo proporcional',`${sim.dias_aguinaldo} días`,sim.aguinaldo_fiscal,sim.aguinaldo_real],
      ['Vacaciones — REMANENTE (DÍAS DISPONIBLES)',`${sim.dias_vacaciones.toFixed(2)} días`,sim.vacaciones_fiscal,sim.vacaciones_real],
      ['Prima vacacional','25% del remanente',sim.prima_vacacional_fiscal,sim.prima_vacacional_real],
      ['Prima de antigüedad',`${sim.anios_antiguedad} completos + 1 = ${sim.anios_calculo} × 12 días × ${sim.porcentaje_prima_antiguedad}%`,sim.prima_antiguedad_fiscal,sim.prima_antiguedad_real],
      ['Indemnización',sim.indemnizacion_incluida?'90 días':'No aplica',sim.indemnizacion_fiscal,sim.indemnizacion_real],
    ];
    const tbody=document.getElementById('detalleFiniquitoV23');
    if(tbody)tbody.innerHTML=rows.map(r=>`<tr><td>${r[0]}</td><td style="text-align:right;">${r[1]}</td><td style="text-align:right;">$${fmt(r[2])}</td><td style="text-align:right;">$${fmt(r[3])}</td></tr>`).join('');
    const resumen=document.getElementById('resumenCalculoFiniquitoV23');
    if(resumen)resumen.innerHTML=`<div class="card" style="padding:12px;background:#f8fafc;"><b>Antigüedad</b><br>${sim.anios_antiguedad} años</div><div class="card" style="padding:12px;background:#f8fafc;"><b>Vacaciones remanentes</b><br>${sim.dias_vacaciones.toFixed(2)} días</div><div class="card" style="padding:12px;background:#f8fafc;"><b>Prima vacacional</b><br>25%</div><div class="card" style="padding:12px;background:#f8fafc;"><b>Prima antigüedad</b><br>${sim.porcentaje_prima_antiguedad}%</div>`;
    const totales=document.getElementById('totalesFiniquitoV23');
    if(totales)totales.innerHTML=`<div style="padding:15px;background:#f1f5f9;border-radius:8px;"><b>Total percepciones fiscales</b><div style="font-size:1.35rem;">$${fmt(sim.total_fiscal_bruto)}</div><b>Parte exenta fiscal</b><div>$${fmt(sim.total_fiscal_bruto-sim.percepcion_gravada_fiscal)}</div><b>Parte gravada fiscal</b><div>$${fmt(sim.percepcion_gravada_fiscal)}</div><b>ISR fiscal calculado</b><div>-$${fmt(sim.isr_retenido_fiscal)}</div><strong>Total pago fiscal</strong><div style="font-size:1.45rem;color:#16a34a;">$${fmt(sim.total_fiscal_neto)}</div></div><div style="padding:15px;background:#f1f5f9;border-radius:8px;"><b>Total percepciones reales</b><div style="font-size:1.35rem;">$${fmt(sim.total_real_bruto)}</div><b>Parte exenta real</b><div>$${fmt(sim.total_real_bruto-sim.percepcion_gravada_real)}</div><b>Parte gravada real</b><div>$${fmt(sim.percepcion_gravada_real)}</div><b>ISR real calculado</b><div>-$${fmt(sim.isr_retenido_real)}</div><strong>Total pago real</strong><div style="font-size:1.45rem;color:#16a34a;">$${fmt(sim.total_real_neto)}</div></div>`;
    box.style.display='block';
}

async function ejecutarSimulacionFiniquitoV23() {
    // FASE 3: el cálculo (aguinaldo, vacaciones, prima antigüedad, ISR, exenciones)
    // vive por completo en main (ver finiquitos:simular). Aquí solo se recolectan
    // los inputs del formulario y se renderiza la respuesta del proceso principal.
    const empleadoId=Number(document.getElementById('idEmpFiniquitoSeleccionado')?.value||0);
    const fechaBaja=document.getElementById('finFechaBaja')?.value;
    const tipoBaja=document.getElementById('finTipoBaja')?.value||'FINIQUITO';
    if(!empleadoId||!fechaBaja){mensajeFiniquitoV23('Selecciona un empleado y una fecha de baja.');return;}
    const emp=window.empleadoFiniquitoSeleccionado||(window.listaEmpleadosActuales||[]).find(e=>Number(e.id||e.id_empleado)===empleadoId);
    const salarioFiscal=Number(document.getElementById('finSalarioFiscal')?.value||emp?.salario_diario||0);
    const salarioReal=Number(document.getElementById('finSalarioReal')?.value||salarioFiscal||0);
    const diasSueldo=Math.max(0,Number(document.getElementById('finDiasPendientes')?.value||0));
    let porcentajePA=Number(document.getElementById('finPorcentajePrimaAntiguedad')?.value||100);
    if(!Number.isFinite(porcentajePA)) porcentajePA=100;
    porcentajePA=Math.min(100,Math.max(40,porcentajePA));
    const inputPA=document.getElementById('finPorcentajePrimaAntiguedad');
    if(inputPA) inputPA.value=String(porcentajePA);
    const incluir90=tipoBaja==='LIQUIDACION' ? document.getElementById('finIncluirIndemnizacion90')?.value!=='0' : false;
    const peticionFiniquito={
        empleado_id: empleadoId,
        fecha_baja: fechaBaja,
        tipo_baja: tipoBaja,
        salario_fiscal: salarioFiscal,
        salario_real: salarioReal,
        dias_sueldo_pendiente: diasSueldo,
        porcentaje_prima_antiguedad: porcentajePA,
        incluir_indemnizacion_90: incluir90
    };
    try{
        const res=await window.api.simularFiniquito(peticionFiniquito);
        if(!res?.ok) throw new Error(res?.error||'No se pudo calcular el finiquito.');
        window.simulacionFiniquitoActual=res.data;
        window.peticionFiniquitoActual=peticionFiniquito;
        renderizarSimulacionFiniquitoV23(window.simulacionFiniquitoActual);
        mensajeFiniquitoV23(`Cálculo actualizado: ${res.data.anios_antiguedad} años completos + 1 = ${res.data.anios_calculo} años para los conceptos por antigüedad; vacaciones disponibles/remanentes actuales ${res.data.dias_vacaciones.toFixed(2)} días. La fecha de baja puede ser histórica para efectos de migración. ISR con tabla mensual ${res.data.tabla_isr_ejercicio}.`, 'success');
    }catch(e){mensajeFiniquitoV23(`Error al calcular: ${e.message}`);}
}

function configurarModuloFiniquitosV23() {
    const input = document.getElementById('buscarEmpFiniquito');
    const resultados = document.getElementById('resBusquedaFiniquito');

    const buscar = () => {
        const q = (input?.value || '').trim().toLowerCase();
        if (!input || !resultados) return;
        resultados.innerHTML = '';
        const lista = window.listaEmpleadosActuales || [];
        lista.filter(e => !q ||
            `${e.nombre||''} ${e.apellido||''} ${e.num_empleado||''}`.toLowerCase().includes(q)
        ).slice(0,20).forEach(emp => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.textContent = `[${emp.num_empleado || emp.id}] ${emp.nombre || ''} ${emp.apellido || ''}`.trim();
            item.addEventListener('click', () => {
                window.empleadoFiniquitoSeleccionado = emp;
                input.value = item.textContent;
                document.getElementById('idEmpFiniquitoSeleccionado').value = emp.id;
                document.getElementById('finSalarioFiscal').value = Number(emp.salario_diario || 0).toFixed(2);
                document.getElementById('finSalarioReal').value = Number(emp.salario_diario || 0).toFixed(2);
                resultados.style.display = 'none';
                input.focus({preventScroll:true});
            });
            resultados.appendChild(item);
        });
        resultados.style.display = resultados.children.length ? 'block' : 'none';
    };

    if (input && !input.dataset.v23Ready) {
        input.dataset.v23Ready = '1';
        input.addEventListener('input', buscar);
        input.addEventListener('focus', buscar);
    }

    const btnCalc=document.getElementById('btnSimularFiniquito');
    const btnClear=document.getElementById('btnLimpiarFiniquitoV23');
    const btnSave=document.getElementById('btnGuardarFiniquito');
    const btnPdf=document.getElementById('btnExportarPdfFiniquito');

    if (btnCalc && !btnCalc.dataset.v23Ready) {
        btnCalc.dataset.v23Ready='1';
        btnCalc.addEventListener('click', ejecutarSimulacionFiniquitoV23);
    }
    if (btnClear && !btnClear.dataset.v23Ready) {
        btnClear.dataset.v23Ready='1';
        btnClear.addEventListener('click', ()=>{
            document.getElementById('buscarEmpFiniquito').value='';
            document.getElementById('idEmpFiniquitoSeleccionado').value='';
            document.getElementById('finFechaBaja').value='';
            document.getElementById('finSalarioFiscal').value='';
            document.getElementById('finSalarioReal').value='';
            document.getElementById('finISR').value='0';
            document.getElementById('finIncluirIndemnizacion90').value='1';
            document.getElementById('finDiasPendientes').value='0';
            document.getElementById('finObservaciones').value='';
            document.getElementById('boxResultadoSimulacion').style.display='none';
            window.simulacionFiniquitoActual=null;
            window.peticionFiniquitoActual=null;
            window.empleadoFiniquitoSeleccionado=null;
            mensajeFiniquitoV23('Formulario limpiado.', 'info');
            document.getElementById('buscarEmpFiniquito').focus({preventScroll:true});
        });
    }
    if (btnSave && !btnSave.dataset.v23Ready) {
        btnSave.dataset.v23Ready='1';
        btnSave.addEventListener('click', async ()=>{
            const peticion=window.peticionFiniquitoActual;
            if(!peticion || !window.simulacionFiniquitoActual){mensajeFiniquitoV23('Primero realiza el cálculo.');return;}
            const ok=await showConfirm('¿Confirmas aplicar la baja y guardar este cálculo?', 'Confirmar');
            if(!ok)return;
            try{
                const res=await window.api.guardarFiniquito(peticion);
                if(res?.ok){
                    mensajeFiniquitoV23('Finiquito/liquidación guardado correctamente.', 'ok');
                    document.getElementById('boxResultadoSimulacion').style.display='none';
                    window.simulacionFiniquitoActual=null;
                    window.peticionFiniquitoActual=null;
                    if(typeof cargarEmpleadosEmpresa==='function' && window.empresaSeleccionadaId){
                        await cargarEmpleadosEmpresa(window.empresaSeleccionadaId);
                    }
                    refrescarPanoramaLaboral();
                }else mensajeFiniquitoV23('No se pudo guardar: '+(res?.error||'Error desconocido'));
            }catch(e){mensajeFiniquitoV23('Error al guardar: '+e.message);}
        });
    }
    const btnImportISR=document.getElementById('btnImportarTablaISRV26');
    const inputEjercicioISR=document.getElementById('ejercicioTablaISRV26');
    if(inputEjercicioISR && !inputEjercicioISR.value) inputEjercicioISR.value=String(new Date().getFullYear());
    if(btnImportISR && !btnImportISR.dataset.v23Ready){
        btnImportISR.dataset.v23Ready='1';
        btnImportISR.addEventListener('click',async()=>{
            const estado=document.getElementById('estadoTablaISRV26');
            const ejercicio=Number(inputEjercicioISR?.value)||new Date().getFullYear();
            try{
                if(estado)estado.textContent=`Selecciona el Excel de la tabla ISR ${ejercicio}...`;
                const r=await window.api.importarTablaISRMensual(ejercicio);
                if(r?.ok){
                    if(estado)estado.textContent=`Tabla ISR ${r.ejercicio} cargada: ${r.filas} renglones (${r.hoja}).`;
                    mensajeFiniquitoV23(`Tabla ISR ${r.ejercicio} importada correctamente desde ${r.archivo}. Los cálculos de finiquitos con fecha de baja en ${r.ejercicio} usarán esta tabla.`, 'success');
                }else if(r?.cancelado){
                    if(estado)estado.textContent='Importación cancelada.';
                }else{
                    if(estado)estado.textContent='No se pudo importar la tabla ISR.';
                    mensajeFiniquitoV23(r?.error||'No se pudo importar la tabla ISR.');
                }
            }catch(e){if(estado)estado.textContent='Error al importar la tabla ISR.';mensajeFiniquitoV23(`Error al importar ISR: ${e.message}`);}
        });
    }


    configurarHistorialFiniquitosV29();
    if (btnPdf && !btnPdf.dataset.v23Ready) {
        btnPdf.dataset.v23Ready='1';
        btnPdf.addEventListener('click',()=>{
            const sim=window.simulacionFiniquitoActual;
            if(!sim)return;
            const emp=window.empleadoFiniquitoSeleccionado;
            const rows=document.getElementById('detalleFiniquitoV23')?.outerHTML||'';
            const totals=document.getElementById('totalesFiniquitoV23')?.outerHTML||'';
            if(typeof imprimirReportePdf==='function'){
                imprimirReportePdf(`Finiquito_${emp?.nombre||'Empleado'}`,`
                    <h2 style="text-align:center;">Finiquito / Liquidación</h2>
                    <p><b>Empleado:</b> ${emp ? `${emp.nombre||''} ${emp.apellido||''}` : ''}</p>
                    <p><b>Fecha de baja:</b> ${sim.fecha_baja}</p>
                    <p><b>Tipo:</b> ${sim.tipo_baja}</p>
                    <p><b>Prima vacacional:</b> 25%</p><p><b>Antigüedad para cálculo:</b> ${sim.anios_antiguedad} años completos + 1 = ${sim.anios_calculo}</p><p><b>Indemnización 90 días:</b> ${sim.indemnizacion_incluida ? 'Incluida' : 'No incluida'}</p><p><b>ISR:</b> Tabla mensual ${sim.tabla_isr_ejercicio}</p>
                    <table><thead><tr><th>Concepto</th><th>Días / Base</th><th>Monto fiscal</th><th>Monto real</th></tr></thead><tbody>${rows}</tbody></table>
                    ${totals}
                `, emp?.empresa_id);
            }
        });
    }
}



async function cargarHistorialFiniquitosV29(busqueda='') {
    const tbody=document.getElementById('tablaHistorialFiniquitos'); if(!tbody)return;
    tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Cargando historial...</td></tr>';
    try{
        const r=await window.api.obtenerHistorialFiniquitos({
            busqueda,
            tipo:document.getElementById('filtroTipoHistorialFiniquitos')?.value||'',
            desde:document.getElementById('filtroDesdeHistorialFiniquitos')?.value||'',
            hasta:document.getElementById('filtroHastaHistorialFiniquitos')?.value||''
        });
        if(!r?.ok)throw new Error(r?.error||'No se pudo cargar el historial.');
        if(!r.data?.length){tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">No hay finiquitos o liquidaciones registrados.</td></tr>';return;}
        tbody.innerHTML=r.data.map(x=>{
            const nombre=`${x.nombre||''} ${x.apellido||''}`.trim();
            return `<tr>
              <td><strong>FIN-${String(x.id).padStart(6,'0')}</strong></td>
              <td>${nombre}<br><small>${x.num_empleado||x.empleado_id}</small></td>
              <td>${x.empresa_nombre||'—'}</td><td>${x.tipo_baja==='LIQUIDACION'?'Liquidación':'Finiquito'}</td>
              <td>${x.fecha_baja||'—'}</td><td>${Number(x.remanente_vacaciones??x.dias_vacaciones??0).toFixed(2)} días</td>
              <td>$${formatoMonedaV23(x.isr_retenido||0)}</td><td>$${formatoMonedaV23(x.total_fiscal_neto||x.total_pagar||0)}</td>
            </tr>`;
        }).join('');
    }catch(e){tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;color:#b91c1c;">Error al cargar historial: ${e.message}</td></tr>`;}
}
function configurarHistorialFiniquitosV29(){
    const input=document.getElementById('buscarHistorialFiniquitos');
    const res=document.getElementById('resBusquedaHistorialFiniquitos');
    const actualizar=()=>cargarHistorialFiniquitosV29(input?.value||'');
    if(input&&!input.dataset.v29Ready){
        input.dataset.v29Ready='1';
        input.addEventListener('input',()=>{
            const q=input.value.trim().toLowerCase();
            if(!q){if(res)res.style.display='none';actualizar();return;}
            const lista=window.listaEmpleadosActuales||[];
            const matches=lista.filter(e=>`${e.nombre||''} ${e.apellido||''} ${e.num_empleado||''}`.toLowerCase().includes(q)).slice(0,8);
            if(res){
                res.innerHTML=matches.map(e=>`<div class="search-result-item" data-id="${e.id}">${e.nombre||''} ${e.apellido||''} <small>${e.num_empleado||e.id}</small></div>`).join('');
                res.style.display=matches.length?'block':'none';
                res.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>{
                    input.value=el.textContent.trim();res.style.display='none';actualizar();input.focus({preventScroll:true});
                }));
            }
            actualizar();
        });
    }
    ['filtroTipoHistorialFiniquitos','filtroDesdeHistorialFiniquitos','filtroHastaHistorialFiniquitos'].forEach(id=>{
        const el=document.getElementById(id); if(el&&!el.dataset.v29Ready){el.dataset.v29Ready='1';el.addEventListener('change',actualizar);}
    });
    const btn=document.getElementById('btnActualizarHistorialFiniquitos');
    if(btn&&!btn.dataset.v29Ready){btn.dataset.v29Ready='1';btn.addEventListener('click',actualizar);}
    actualizar();
}

async function imprimirReportePdf(titulo, htmlContenido) {
    try {
        const ventanaImpresion = window.open('', '_blank', 'width=800,height=600');
        if (!ventanaImpresion) {
            await showAlert('No se pudo abrir la ventana de impresión. Revisa si las ventanas emergentes están bloqueadas.', 'Aviso', 'error');
            return;
        }

        ventanaImpresion.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${titulo}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; color: #1e293b; }
                    h2 { color: #0f172a; margin-bottom: 10px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                    th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
                    th { background-color: #f1f5f9; }
                    hr { border: 0; border-top: 1px solid #cbd5e1; margin: 15px 0; }
                </style>
            </head>
            <body>
                ${htmlContenido}
            </body>
            </html>
        `);

        ventanaImpresion.document.close();
        ventanaImpresion.focus();

        setTimeout(() => {
            ventanaImpresion.print();
            ventanaImpresion.close();
        }, 300);
    } catch (err) {
        console.error("❌ Error en la generación del PDF de impresión:", err);
    }
}
// ==========================================
// MÓDULO FINIQUITOS & EXPORTACIÓN PDF
// (la inicialización real es configurarModuloFiniquitosV23(); este bloque
// legacy duplicado nunca se invocaba y calculaba/guardaba finiquitos con una
// forma de datos obsoleta — se elimina para no dejar una ruta muerta que
// vuelva a filtrar cálculo al renderer si alguien la reconecta por error.)
// ==========================================

// ==========================================
// INCIDENCIAS MANUALES & EXCEL
// ==========================================

async function actualizarSaldoIncidencia(empleadoId){const box=document.getElementById('incSaldoEmpleado');if(!box||!empleadoId)return;try{const r=await window.api.obtenerSaldoVacaciones(Number(empleadoId),new Date().toISOString().slice(0,10));const s=r?.saldo||{};const d=Number(s.totalUsable||0),b=Number(s.totalBloqueado||0);box.innerHTML=`<div class="profile-box"><span>Días disponibles</span><strong>${d}</strong></div><div class="profile-box"><span>Próximo ciclo bloqueado</span><strong>${b}</strong></div><div class="profile-box"><span>Máximo a descontar</span><strong>${d}</strong></div>`;}catch(e){box.innerHTML='<div class="profile-box"><span>Saldo</span><strong>No disponible</strong></div>';}}
async function cargarHistorialIncidencias(filtro = {}) {
  const tbody = document.getElementById('tablaHistorialIncidencias');
  if (!tbody) return;

  const empleadoSeleccionado = Number(
    document.getElementById('idEmpIncidenciaSeleccionado')?.value || 0
  );

  const empleadoId = Number(filtro.empleadoId || empleadoSeleccionado || 0);
  const busqueda = String(filtro.busqueda || '').trim();

  try {
    let res;

    if (typeof window.api.obtenerTodasIncidencias === 'function') {
      res = await window.api.obtenerTodasIncidencias({
        empleadoId,
        busqueda
      });
    } else if (empleadoId > 0) {
      res = await window.api.obtenerIncidenciasPorEmpleado(empleadoId);
    } else {
      res = { ok: true, data: [] };
    }

    if (!res?.ok) throw new Error(res?.error || 'Error al cargar historial.');

    let filas = Array.isArray(res.data) ? res.data : [];

    if (busqueda) {
      const q = busqueda.toLowerCase();
      filas = filas.filter(i => {
        const nombre = `${i.nombre || ''} ${i.apellido || ''}`.trim().toLowerCase();
        return nombre.includes(q) ||
               String(i.folio || '').toLowerCase().includes(q);
      });
    }

    tbody.innerHTML = filas.map(i => {
      const cancelada = Number(i.cancelada) === 1;
      const acciones = cancelada
        ? '<span style="color:#64748b;">Sin acción</span>'
        : `<button type="button" class="btn btn-sm btn-danger"
                   data-cancel-inc="${Number(i.id)}">Cancelar</button>
           <button type="button" class="btn btn-sm btn-secondary"
                   data-export-inc-pdf="${Number(i.id)}"
                   style="margin-left:6px;">
             <i class="fa-solid fa-file-pdf"></i> PDF
           </button>`;

      return `<tr data-incidencia-id="${Number(i.id)}">
        <td>${escapeHtml(i.folio || `INC-${i.id}`)}</td>
        <td>${Number(i.id)}</td>
        <td>${escapeHtml(`${i.nombre || ''} ${i.apellido || ''}`.trim())}</td>
        <td>${escapeHtml(i.fecha_inicio || '')}${i.fecha_fin && i.fecha_fin !== i.fecha_inicio ? ` al ${escapeHtml(i.fecha_fin)}` : ''}</td>
        <td>${escapeHtml(i.empresa_nombre || '')}</td>
        <td>${Number(i.dias || 0)}</td>
        <td>${cancelada ? 'Cancelada' : 'Activa'}</td>
        <td>${acciones}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:#64748b;">Sin incidencias encontradas.</td></tr>';

    tbody.querySelectorAll('[data-cancel-inc]').forEach(btn => {
      btn.addEventListener('click', async function(e) {
        e.preventDefault();
        e.stopPropagation();

        const confirmado = await mostrarDialogoCancelacion();
        if (!confirmado) {
          setTimeout(devolverFocoIncidenciasV15, 0);
          return;
        }

        btn.disabled = true;
        try {
          const r = await window.api.cancelarIncidencia(Number(btn.dataset.cancelInc));
          if (!r?.ok) throw new Error(r?.error || 'No fue posible cancelar.');

          mostrarNotificacionLocal('Incidencia cancelada y días devueltos.', 'success');
          await cargarHistorialIncidencias({
            empleadoId,
            busqueda
          });
          if (empleadoId) await actualizarSaldoIncidencia(empleadoId);
          refrescarPanoramaLaboral();
        } catch (err) {
          btn.disabled = false;
          mostrarNotificacionLocal(`Error al cancelar: ${err.message}`, 'error');
        } finally {
          setTimeout(devolverFocoIncidenciasV15, 0);
        }
      });
    });

    tbody.querySelectorAll('[data-export-inc-pdf]').forEach(btn => {
      btn.addEventListener('click', async function(e) {
        e.preventDefault();
        e.stopPropagation();

        const id = Number(btn.dataset.exportIncPdf);
        if (!Number.isInteger(id) || id <= 0) {
          mostrarNotificacionLocal('No se pudo identificar la incidencia.', 'error');
          return;
        }

        // V16: contextBridge garantiza que esta API exista en el renderer.
        const exportar = window.electronAPI?.incidenciasExportarPdfV16;

        console.log('V16 PDF: electronAPI disponible =', !!window.electronAPI);
        console.log('V16 PDF: función disponible =', typeof exportar);

        if (typeof exportar !== 'function') {
          mostrarNotificacionLocal(
            'No se pudo conectar con el módulo PDF. Reinicie la aplicación con esta versión.',
            'error'
          );
          setTimeout(devolverFocoIncidenciasV15, 0);
          return;
        }

        const old = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';

        try {
          const result = await exportar(id);

          if (result?.ok) {
            mostrarNotificacionLocal('PDF de la incidencia generado correctamente.', 'success');
          } else if (!result?.canceled && !result?.cancelado) {
            mostrarNotificacionLocal(
              `Error al exportar: ${result?.error || 'No fue posible generar el PDF.'}`,
              'error'
            );
          }
        } catch (err) {
          console.error('V16 PDF incidencia:', err);
          mostrarNotificacionLocal(
            `Error al exportar la incidencia: ${err.message}`,
            'error'
          );
        } finally {
          btn.disabled = false;
          btn.innerHTML = old;
          setTimeout(devolverFocoIncidenciasV15, 0);
        }
      });
    });
  } catch (err) {
    console.error('V16 historial incidencias:', err);
    tbody.innerHTML =
      `<tr><td colspan="8" style="text-align:center;color:#dc2626;">${escapeHtml(err.message || 'Error al cargar el historial.')}</td></tr>`;
  }
}


// ==========================================
// FUNCIONES AUXILIARES DE EXPORTACIÓN
// ==========================================

function normalizarArreglo(respuesta) {
    if (Array.isArray(respuesta)) return respuesta;
    if (respuesta && typeof respuesta === 'object') {
        if (Array.isArray(respuesta.data)) return respuesta.data;
        if (Array.isArray(respuesta.empleados)) return respuesta.empleados;
        if (Array.isArray(respuesta.rows)) return respuesta.rows;
        if (Array.isArray(respuesta.result)) return respuesta.result;
    }
    return [];
}

async function imprimirReportePdf(titulo, contenidoHtml, empresaId) {
    try {
        if (window.api && typeof window.api.guardarReportePdf === 'function') {
            const res = await window.api.guardarReportePdf({
                nombre: titulo,
                html: contenidoHtml,
                empresaId: empresaId || window.empresaSeleccionadaId || null
            });
            if (res?.ok) {
                console.log('✅ PDF guardado:', res.filePath);
            } else if (!res?.cancelado) {
                await showAlert('Error al guardar el PDF: ' + (res?.error || 'Error desconocido'), 'Aviso', 'error');
            }
            return res;
        }

        const ventana = window.open('', '_blank', 'width=900,height=650');
        if (!ventana) {
            await showAlert('⚠️ No fue posible abrir la vista de impresión.', 'Aviso', 'warning');
            return { ok: false, error: 'Ventana de impresión bloqueada.' };
        }
        ventana.document.write(`<!DOCTYPE html><html><head><title>${titulo}</title><style>
            body{font-family:Segoe UI,Arial,sans-serif;padding:25px;color:#1e293b}
            table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #cbd5e1;padding:8px 12px;text-align:left}
            th{background:#f1f5f9}h2{margin-bottom:5px}.empresa-header{font-weight:700}.fecha,.total-empleados{color:#64748b}
        </style></head><body>${contenidoHtml}</body></html>`);
        ventana.document.close();
        ventana.focus();
        setTimeout(() => { ventana.print(); ventana.close(); }, 300);
        return { ok: true };
    } catch (err) {
        console.error('❌ Error generando PDF:', err);
        await showAlert('Error al generar el PDF: ' + err.message, 'Aviso', 'error');
        return { ok: false, error: err.message };
    }
}

async function exportarTablaAExcel(nombreArchivo, datos) {
    try {
        if (window.api && typeof window.api.guardarReporteExcel === 'function') {
            const res=await window.api.guardarReporteExcel({nombre:nombreArchivo,datos});
            if(!res?.ok && !res?.cancelado) await showAlert('Error al guardar Excel: '+(res?.error||'Desconocido'), 'Aviso', 'error');
            return res;
        }
        if(typeof XLSX==='undefined'){await showAlert('La librería XLSX no está disponible.', 'Aviso', 'error');return {ok:false};}
        const ws=XLSX.utils.json_to_sheet(datos),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Reporte');XLSX.writeFile(wb,`${nombreArchivo}.xlsx`);return {ok:true};
    }catch(err){console.error(err);await showAlert('Error al exportar Excel: '+err.message, 'Aviso', 'error');return {ok:false,error:err.message};}
}

// ==========================================
// ESTADO GLOBAL EN MEMORIA
// ==========================================
if (typeof window.empresaSeleccionadaId === 'undefined') window.empresaSeleccionadaId = null;
if (typeof window.listaEmpleadosActuales === 'undefined') window.listaEmpleadosActuales = [];
if (typeof window.listaEmpleadosFiltrados === 'undefined') window.listaEmpleadosFiltrados = [];

// ==========================================
// FUNCIONES GLOBALES (ACCESO HTML Y EVENTOS)
// ==========================================

window.mostrarOpcionesReporte = function(tipo) {
    console.log("📊 Cargando menú de reporte tipo:", tipo);
    const panel = document.getElementById("panelContenidoReportes");
    if (!panel) {
        console.error("❌ No se encontró el contenedor #panelContenidoReportes");
        return;
    }

    let titulo = "";
    let descripcion = "";

    switch (tipo) {
        case "expedientes":
            titulo = '<i class="fa-solid fa-users"></i> Reporte de Expedientes y Empleados';
            descripcion = 'Genera la exportación general con la información completa del personal registrado.';
            break;
        case "salarios":
            titulo = '<i class="fa-solid fa-wallet"></i> Reporte de Salarios y SBC';
            descripcion = 'Consulta e imprime la estructura salarial y la base de cotización IMSS.';
            break;
        case "antiguedad":
            titulo = '<i class="fa-solid fa-calendar-days"></i> Reporte de Antigüedad y Fechas';
            descripcion = 'Desglose detallado de años trabajados, fechas de ingreso y aniversarios LFT.';
            break;
        default:
            titulo = '<i class="fa-solid fa-file-lines"></i> Reporte General';
            descripcion = 'Selección de datos generales de la empresa.';
            break;
    }

    panel.innerHTML = `
        <div class="reporte-card">
            <h3 style="margin-top: 0; font-size: 1.25rem; color: #0f172a;">${titulo}</h3>
            <p style="color: #64748b; font-size: 0.95rem; margin-bottom: 24px;">${descripcion}</p>
            
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                <button type="button" class="btn btn-primary" data-reporte-pdf="${tipo}" style="display: flex; align-items: center; gap: 8px;">
                    <i class="fa-solid fa-file-pdf"></i> Imprimir / Guardar en PDF
                </button>
                <button type="button" class="btn btn-secondary" data-reporte-excel="${tipo}" style="display: flex; align-items: center; gap: 8px; background: #16a34a; color: white; border: none;">
                    <i class="fa-solid fa-file-excel"></i> Exportar a Excel (.xlsx)
                </button>
            </div>
        </div>
    `;
};

document.addEventListener('click', (e) => {
    const pdfBtn = e.target.closest('[data-reporte-pdf]');
    if (pdfBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.generarReportePDF(pdfBtn.dataset.reportePdf);
        return;
    }
    const excelBtn = e.target.closest('[data-reporte-excel]');
    if (excelBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.generarReporteExcel(excelBtn.dataset.reporteExcel);
    }
});

window.generarReportePDF = async function(tipo) {
    const selectEmpresa = document.getElementById("selectEmpresaGlobal");

    const idEmpresaActiva = window.empresaSeleccionadaId || (selectEmpresa ? selectEmpresa.value : null);

    const nombreEmpresaSeleccionada = (selectEmpresa && selectEmpresa.selectedIndex !== -1)
        ? selectEmpresa.options[selectEmpresa.selectedIndex].text 
        : "EMPRESA NO ESPECIFICADA";

    window.listaEmpleadosActuales = Array.isArray(window.listaEmpleadosEmpresa) ? window.listaEmpleadosEmpresa.slice() : window.listaEmpleadosActuales;
    if (!Array.isArray(window.listaEmpleadosActuales) || window.listaEmpleadosActuales.length === 0) {
        if (idEmpresaActiva && window.api && typeof window.api.obtenerEmpleadosPorEmpresa === "function") {
            try {
                let respuesta = await window.api.obtenerEmpleadosPorEmpresa(Number(idEmpresaActiva));
                if (!respuesta || (Array.isArray(respuesta) && respuesta.length === 0)) {
                    respuesta = await window.api.obtenerEmpleadosPorEmpresa(idEmpresaActiva);
                }
                window.listaEmpleadosActuales = normalizarArreglo(respuesta);
            } catch (err) {
                console.error("❌ Error en consulta IPC directa:", err);
            }
        }
    } else {
        window.listaEmpleadosActuales = normalizarArreglo(window.listaEmpleadosActuales);
    }

    window.listaEmpleadosActuales = Array.isArray(window.listaEmpleadosEmpresa) ? window.listaEmpleadosEmpresa.slice() : window.listaEmpleadosActuales;
    if (!Array.isArray(window.listaEmpleadosActuales) || window.listaEmpleadosActuales.length === 0) {
        await showAlert(`⚠️ No se encontraron empleados registrados para la Empresa seleccionada (ID: "${idEmpresaActiva}").`, 'Aviso', 'warning');
        return;
    }

    const totalEmpleados = window.listaEmpleadosActuales.length;

    let filasHTML = '';
    window.listaEmpleadosActuales.forEach((emp, index) => {
        filasHTML += `
            <tr>
                <td>${index + 1}</td>
                <td><b>${emp.nombre || ''} ${emp.apellido || ''}</b></td>
                <td>${emp.puesto || 'N/A'}</td>
                <td>$${parseFloat(emp.salario_diario || 0).toFixed(2)}</td>
                <td>$${parseFloat(emp.salario_base || 0).toFixed(2)}</td>
                <td>${emp.fecha_ingreso || 'N/A'}</td>
            </tr>
        `;
    });

    const tablaHtml = `
        <div class="empresa-header">EMPRESA: ${nombreEmpresaSeleccionada}</div>
        <h2>REPORTE DE PERSONAL (${tipo.toUpperCase()})</h2>
        <div class="fecha">Fecha de emisión: ${new Date().toLocaleString()}</div>
        <div class="total-empleados">Total de empleados: ${totalEmpleados}</div>
        <hr>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Nombre Completo</th>
                    <th>Puesto</th>
                    <th>Salario Diario</th>
                    <th>SBC / Base</th>
                    <th>Fecha Ingreso</th>
                </tr>
            </thead>
            <tbody>
                ${filasHTML}
            </tbody>
        </table>
    `;

    imprimirReportePdf(`Reporte - ${tipo}`, tablaHtml, idEmpresaActiva);
};

window.generarReporteExcel = async function(tipo) {
    const selectEmpresa = document.getElementById("selectEmpresaGlobal");

    const idEmpresaActiva = window.empresaSeleccionadaId || (selectEmpresa ? selectEmpresa.value : null);

    if (!Array.isArray(window.listaEmpleadosActuales) || window.listaEmpleadosActuales.length === 0) {
        if (idEmpresaActiva && window.api && typeof window.api.obtenerEmpleadosPorEmpresa === "function") {
            try {
                let respuesta = await window.api.obtenerEmpleadosPorEmpresa(Number(idEmpresaActiva));
                if (!respuesta || (Array.isArray(respuesta) && respuesta.length === 0)) {
                    respuesta = await window.api.obtenerEmpleadosPorEmpresa(idEmpresaActiva);
                }
                window.listaEmpleadosActuales = normalizarArreglo(respuesta);
            } catch (err) {
                console.error("❌ Error en consulta IPC directa:", err);
            }
        }
    } else {
        window.listaEmpleadosActuales = normalizarArreglo(window.listaEmpleadosActuales);
    }

    if (!Array.isArray(window.listaEmpleadosActuales) || window.listaEmpleadosActuales.length === 0) {
        await showAlert(`⚠️ No se encontraron empleados registrados para la Empresa seleccionada (ID: "${idEmpresaActiva}").`, 'Aviso', 'warning');
        return;
    }

    const datosExcel = window.listaEmpleadosActuales.map((emp, index) => {
        if (tipo === "salarios") {
            return {
                "No.": index + 1,
                "Empleado": `${emp.nombre || ''} ${emp.apellido || ''}`.trim(),
                "Puesto": emp.puesto || 'N/A',
                "Salario Diario ($)": parseFloat(emp.salario_diario || 0),
                "Salario Base Cotización ($)": parseFloat(emp.salario_base || 0)
            };
        } else if (tipo === "antiguedad") {
            return {
                "No.": index + 1,
                "Empleado": `${emp.nombre || ''} ${emp.apellido || ''}`.trim(),
                "Puesto": emp.puesto || 'N/A',
                "Fecha Ingreso": emp.fecha_ingreso || 'N/A'
            };
        } else {
            return {
                "No.": index + 1,
                "Empleado": `${emp.nombre || ''} ${emp.apellido || ''}`.trim(),
                "Puesto": emp.puesto || 'N/A',
                "Salario Diario ($)": parseFloat(emp.salario_diario || 0),
                "SBC ($)": parseFloat(emp.salario_base || 0),
                "Fecha Ingreso": emp.fecha_ingreso || 'N/A'
            };
        }
    });

    exportarTablaAExcel(`Reporte_${tipo}_${new Date().toISOString().slice(0,10)}`, datosExcel);
};

// ==========================================
// CONSULTAS IPC Y CARGA DE DATOS
// ==========================================

async function inicializarSelectEmpresas() {
    try {
        if (window.api && typeof window.api.obtenerEmpresas === "function") {
            const empresas = await window.api.obtenerEmpresas();

            const selectEmpresa = document.getElementById("selectEmpresa") || 
                                  document.getElementById("filtroEmpresa") || 
                                  document.querySelector("select");

            if (selectEmpresa && Array.isArray(empresas) && empresas.length > 0) {
                selectEmpresa.innerHTML = '';
                
                empresas.forEach((emp) => {
                    const option = document.createElement("option");
                    option.value = emp.id;
                    option.textContent = emp.nombre || emp.razon_social || emp.nombre_comercial;
                    selectEmpresa.appendChild(option);
                });

                selectEmpresa.selectedIndex = 0;
                window.empresaSeleccionadaId = selectEmpresa.value;

                if (window.empresaSeleccionadaId) {
                    await cargarEmpleadosEmpresa(window.empresaSeleccionadaId);
                }
            } else {
                console.warn("⚠️ No se encontró el elemento <select> en el HTML o no hay empresas registradas.");
            }
        } else {
            console.error("❌ window.api.obtenerEmpresas no está definido en preload.js");
        }
    } catch (err) {
        console.error("❌ Error al inicializar selector de empresas:", err);
    }
}

async function cargarEmpleadosEmpresa(empresaId) {
    if (!empresaId) {
        window.listaEmpleadosActuales = [];
        return [];
    }

    try {
        if (window.api && typeof window.api.obtenerEmpleadosPorEmpresa === "function") {
            const idNumerico = Number(empresaId);
            const resultado = await window.api.obtenerEmpleadosPorEmpresa(idNumerico);
            const lista = normalizarArreglo(resultado);
            window.listaEmpleadosActuales = lista;
            window.listaEmpleadosEmpresa = lista;
            window.listaEmpleadosFiltrados = lista.slice();
        } else {
            console.error("❌ window.api.obtenerEmpleadosPorEmpresa no está disponible.");
            window.listaEmpleadosActuales = [];
        }
    } catch (err) {
        console.error("❌ Error en IPC al obtener empleados:", err);
        window.listaEmpleadosActuales = [];
    }

    return window.listaEmpleadosActuales;
}

// ==========================================
// SEGURIDAD Y FUNCIONES PROFESIONALES v2
// ==========================================
function configurarSeguridadProfesional(){
    const form=document.getElementById('formLoginAdmin');
    const overlay=document.getElementById('loginOverlay');
    const msg=document.getElementById('loginMensaje');
    const toggle=document.getElementById('btnMostrarPassword');
    if(toggle) toggle.onclick=()=>{const i=document.getElementById('loginPassword');i.type=i.type==='password'?'text':'password';};
    if(form) form.addEventListener('submit',async e=>{e.preventDefault();msg.textContent='Validando acceso...';const r=await window.api.loginAdmin({usuario:document.getElementById('loginUsuario').value,password:document.getElementById('loginPassword').value});if(!r.ok){msg.textContent=r.error||'No fue posible iniciar sesión.';return;} overlay.style.display='none'; document.body.classList.add('authenticated'); if(r.debeCambiarPassword) abrirModalPassword(true); await cargarDashboardProfesional();});
    document.getElementById('btnCambiarPasswordTop')?.addEventListener('click',()=>abrirModalPassword(false));
}
function abrirModalPassword(obligatorio=false){const m=document.getElementById('modalPassword');if(!m)return;m.style.display='grid';const close=document.getElementById('btnCerrarPassword');close.style.display=obligatorio?'none':'inline-flex';const a=document.getElementById('passwordActual'),n=document.getElementById('passwordNueva'),n2=document.getElementById('passwordNueva2'),msg=document.getElementById('passwordMensaje');if(a)a.value='';if(n)n.value='';if(n2)n2.value='';if(msg){msg.textContent='';msg.style.color='';}if(a)a.focus();}
function cerrarModalPassword(){document.getElementById('modalPassword').style.display='none';const a=document.getElementById('passwordActual'),n=document.getElementById('passwordNueva'),n2=document.getElementById('passwordNueva2');if(a)a.value='';if(n)n.value='';if(n2)n2.value='';}

// ==========================================
// V31 - PANORAMA LABORAL EN TIEMPO REAL
// ==========================================
// Refresca el panorama sin bloquear la acción que lo dispara (fire-and-forget), con un
// pequeño debounce para no disparar N refrescos si varias acciones ocurren casi juntas.
function refrescarPanoramaLaboral(){
    if(window.__panoramaRefrescoTimeout) clearTimeout(window.__panoramaRefrescoTimeout);
    window.__panoramaRefrescoTimeout=setTimeout(()=>{
        try{
            if(typeof cargarDashboardProfesional==='function') cargarDashboardProfesional();
        }catch(e){ console.warn('No fue posible refrescar el Panorama Laboral:',e); }
    },250);
}
window.refrescarPanoramaLaboral=refrescarPanoramaLaboral;

// FASE 4: auto-refresh por push, cero polling. Main emite 'db:changed' tras
// cada escritura exitosa en la BD (ver notificarCambioDB en main.js: hoy manda
// {origen, ts} — origen solo viene poblado para el guardado de finiquitos; el
// resto de escrituras (alta de empleado, vacaciones, incidencias, etc.) pasan
// por el hook genérico de dbRun sin etiqueta de tabla). Por eso este listener
// refresca ante CUALQUIER db:changed en lugar de filtrar por tabla — filtrar
// por un campo que main.js no envía dejaría sin refresco justo el caso de
// "crear empleado" que se pide probar. actualizarVistasPorEmpresa() vuelve a
// pedir la lista de empleados (lo que refrescarPanoramaLaboral por sí solo NO
// hacía) y ya internamente llama a cargarDashboardProfesional(); se llama
// también aparte por si no hay empresa seleccionada. Debounce para no
// re-disparar varias veces dentro de una misma transacción.
let _debouncePanoramaDbChanged = null;
function iniciarAutoRefrescoPanoramaLaboral(){
    if (window.__panoramaAutoRefrescoListo) return;
    window.__panoramaAutoRefrescoListo = true;

    const refrescarTrasCambio = () => {
        if (window.empresaSeleccionadaId) actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
        if (typeof cargarDashboardProfesional === 'function') cargarDashboardProfesional();
    };

    if (typeof window.api?.onDbChanged === 'function') {
        window.api.onDbChanged(() => {
            clearTimeout(_debouncePanoramaDbChanged);
            _debouncePanoramaDbChanged = setTimeout(refrescarTrasCambio, 300);
        });
    }
    window.addEventListener('focus', refrescarTrasCambio);
}
window.iniciarAutoRefrescoPanoramaLaboral=iniciarAutoRefrescoPanoramaLaboral;

// V30 - PANORAMA LABORAL: reloj en vivo + saludo dinámico según la hora del día.
function iniciarRelojPanoramaLaboral(){
    const elHora=document.getElementById('panoramaHora');
    const elFecha=document.getElementById('panoramaFecha');
    const elSaludo=document.getElementById('panoramaSaludo');
    if(!elHora||!elFecha) return;
    const tick=()=>{
        const ahora=new Date();
        elHora.textContent=ahora.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        elFecha.textContent=ahora.toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
        if(elSaludo){
            const h=ahora.getHours();
            elSaludo.textContent=h<12?'Buenos días':(h<19?'Buenas tardes':'Buenas noches');
        }
    };
    tick();
    if(window.__panoramaRelojInterval) clearInterval(window.__panoramaRelojInterval);
    window.__panoramaRelojInterval=setInterval(tick,1000);
}

// Anima un contador numérico de 0 (o su valor previo) hasta el valor final.
function animarContadorPanorama(el,valorFinal){
    if(!el) return;
    const destino=Number(valorFinal)||0;
    const inicio=Number(el.dataset.valor||0);
    const duracion=650;
    const t0=performance.now();
    const paso=(t)=>{
        const p=Math.min(1,(t-t0)/duracion);
        const facil=1-Math.pow(1-p,3);
        const actual=inicio+(destino-inicio)*facil;
        el.textContent=Number.isInteger(destino)?Math.round(actual):actual.toFixed(1);
        if(p<1) requestAnimationFrame(paso); else { el.textContent=destino; el.dataset.valor=destino; }
    };
    requestAnimationFrame(paso);
}

// Iniciales para el "avatar" de la línea de tiempo de antigüedades.
function inicialesPanorama(nombre,apellido){
    const a=(nombre||'').trim().charAt(0), b=(apellido||'').trim().charAt(0);
    return `${a}${b}`.toUpperCase()||'—';
}

async function cargarDashboardProfesional(){
    iniciarRelojPanoramaLaboral();
    try{
        const r=await window.api.obtenerResumenDashboard(window.empresaSeleccionadaId||null);
        if(!r?.ok)return;
        const d=r.data||{};
        const empleados=Number(d.empleados||0), disponibles=Number(d.diasDisponibles||0), otorgados=Number(d.diasOtorgados||0), pendientes=Number(d.pendientes||0);

        animarContadorPanorama(document.getElementById('dashEmpleados'),empleados);
        animarContadorPanorama(document.getElementById('dashDisponibles'),disponibles);
        animarContadorPanorama(document.getElementById('dashOtorgados'),otorgados);
        animarContadorPanorama(document.getElementById('dashPendientes'),pendientes);

        const empresaTxt=document.getElementById('panoramaEmpresaTxt');
        if(empresaTxt){
            const nombreEmpresa=window.empresaSeleccionadaId?(document.getElementById('empresaActualLabel')?.textContent||''):'';
            empresaTxt.textContent=nombreEmpresa&&nombreEmpresa!=='Panel administrativo'?` · ${nombreEmpresa}`:'';
        }

        // Donut dinámico de balance: proporción de días disponibles vs. otorgados.
        const totalDonut=disponibles+otorgados;
        const pct=totalDonut>0?Math.round((disponibles/totalDonut)*100):0;
        const circulo=document.getElementById('panoramaDonutValue');
        if(circulo) circulo.setAttribute('stroke-dasharray',`${pct}, 100`);
        const pctTxt=document.getElementById('panoramaDonutPct');
        if(pctTxt) pctTxt.textContent=`${pct}%`;
        const estado=document.getElementById('panoramaEstadoOperacion');
        const estadoDetalle=document.getElementById('panoramaEstadoDetalle');
        const prioridad=document.getElementById('panoramaPrioridad');
        const prioridadDetalle=document.getElementById('panoramaPrioridadDetalle');
        const cobertura=document.getElementById('panoramaCobertura');
        if(cobertura) cobertura.textContent=`${pct}%`;
        if(estado){
            estado.textContent=pendientes>0?'Requiere atención':'Operación estable';
        }
        if(estadoDetalle){
            estadoDetalle.textContent=pendientes>0
              ? `${pendientes} solicitud(es) pendiente(s) requieren revisión.`
              : 'Sin solicitudes pendientes de revisión.';
        }
        if(prioridad){
            prioridad.textContent=pendientes>0?`${pendientes} pendiente(s)`:'Sin pendientes';
        }
        if(prioridadDetalle){
            prioridadDetalle.textContent=disponibles>0
              ? `${disponibles} día(s) disponibles en la plantilla.`
              : 'No hay días disponibles registrados.';
        }
        const leyDisp=document.getElementById('panoramaLeyDisponibles');
        if(leyDisp) leyDisp.textContent=disponibles;
        const leyOto=document.getElementById('panoramaLeyOtorgados');
        if(leyOto) leyOto.textContent=otorgados;

        const alertas=[];
        if(pendientes>0)alertas.push(`<div class="alert-item"><i class="fa-solid fa-clock"></i><strong>${pendientes}</strong> solicitud(es) pendiente(s) de revisión.</div>`);
        if(disponibles>0)alertas.push(`<div class="alert-item"><i class="fa-solid fa-umbrella-beach"></i> Hay <strong>${disponibles}</strong> días disponibles en la plantilla.</div>`);
        if(!alertas.length)alertas.push('<div class="alert-item"><i class="fa-solid fa-circle-check"></i> No hay alertas críticas pendientes.</div>');
        document.getElementById('dashAlertas').innerHTML=alertas.join('');

        // Línea de tiempo: calcula el próximo aniversario laboral de cada colaborador y ordena por cercanía.
        const hoy=new Date(); hoy.setHours(0,0,0,0);
        const conAniversario=(d.proximos||[]).map(e=>{
            const fi=e.fecha_ingreso?new Date(`${e.fecha_ingreso}T00:00:00`):null;
            let dias=null, aniosCumplidos=null;
            if(fi&&!isNaN(fi.getTime())){
                let prox=new Date(hoy.getFullYear(),fi.getMonth(),fi.getDate());
                if(prox<hoy) prox=new Date(hoy.getFullYear()+1,fi.getMonth(),fi.getDate());
                dias=Math.round((prox-hoy)/86400000);
                aniosCumplidos=prox.getFullYear()-fi.getFullYear();
            }
            return {...e,_dias:dias,_anios:aniosCumplidos};
        }).sort((a,b)=>(a._dias??9999)-(b._dias??9999));

        document.getElementById('dashProximos').innerHTML=conAniversario.map(e=>{
            const nombreCompleto=`${e.nombre||''} ${e.apellido||''}`.trim();
            const badge=e._dias===null?'':(e._dias<=30?`<span class="timeline-badge proxima">en ${e._dias} día(s)</span>`:`<span class="timeline-badge">${e._anios} años</span>`);
            return `<div class="timeline-item">
                <div class="timeline-avatar">${escapeHtml(inicialesPanorama(e.nombre,e.apellido))}</div>
                <div class="timeline-info"><strong>${escapeHtml(nombreCompleto)}</strong><small>Ingreso: ${escapeHtml(e.fecha_ingreso||'—')}</small></div>
                ${badge}
            </div>`;
        }).join('')||'<div class="timeline-item"><div class="timeline-info"><strong>Sin registros</strong></div></div>';
    }catch(e){console.error('Dashboard:',e);}
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

// ==========================================
// V31 - MÓDULO: INTEGRACIÓN DE SALARIOS
// ==========================================
function formatearMonedaMX(valor){
    return `$${Number(valor||0).toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

window.__salariosCache = window.__salariosCache || [];
window.__salariosComparativaPendiente = window.__salariosComparativaPendiente || null;

async function cargarPlantillaSalarios(){
    const tbody=document.getElementById('tablaSalarios');
    if(!tbody) return;
    if(!window.empresaSeleccionadaId){ tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Selecciona una empresa.</td></tr>'; return; }
    tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Cargando...</td></tr>';
    try{
        const res=await window.api.obtenerEmpleadosPorEmpresa(window.empresaSeleccionadaId);
        const lista=(res&&res.ok)?res.data:(Array.isArray(res)?res:[]);
        window.__salariosCache=lista;
        renderizarTablaSalarios(lista);
    }catch(e){
        console.error('Salarios:',e);
        tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#b91c1c;">Error al cargar la plantilla.</td></tr>';
    }
}

function renderizarTablaSalarios(lista){
    const tbody=document.getElementById('tablaSalarios');
    if(!tbody) return;
    if(!lista || !lista.length){ tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Sin empleados registrados.</td></tr>'; return; }
    tbody.innerHTML=lista.map(emp=>{
        const salarioDiario=Number(emp.salario_diario||0);
        return `<tr data-empleado-id="${emp.id}">
            <td><input type="checkbox" class="sal-check-empleado" value="${emp.id}"></td>
            <td>${emp.id}</td>
            <td>${escapeHtml(`${emp.nombre||''} ${emp.apellido||''}`.trim())}</td>
            <td>${escapeHtml(emp.empresa_nombre||'')}</td>
            <td>${formatearMonedaMX(salarioDiario)}</td>
            <td>${escapeHtml(emp.fecha_ingreso||'')}</td>
            <td><span class="badge badge-info">${calcularAntiguedad(emp.fecha_ingreso)}</span></td>
            <td><strong>${formatearMonedaMX(salarioDiario*30)}</strong></td>
        </tr>`;
    }).join('');
}

function filtrarListaPorNombre(lista,texto){
    const q=(texto||'').trim().toLowerCase();
    if(!q) return lista;
    return lista.filter(emp=>`${emp.nombre||''} ${emp.apellido||''}`.trim().toLowerCase().includes(q));
}

function renderizarComparativaSalarios(filas){
    const tbody=document.getElementById('salTablaComparativa');
    if(!tbody) return;
    tbody.innerHTML=filas.map(f=>{
        const diferencia=f.nuevo-f.actual;
        const colorDif=diferencia>=0?'#16a34a':'#b91c1c';
        return `<tr>
            <td>${escapeHtml(f.nombre)}</td>
            <td>${escapeHtml(f.empresa)}</td>
            <td>${formatearMonedaMX(f.actual)}</td>
            <td><strong style="color:#0f766e;">${formatearMonedaMX(f.nuevo)}</strong></td>
            <td style="color:${colorDif};font-weight:600;">${diferencia>=0?'+':''}${formatearMonedaMX(diferencia)}</td>
            <td>${formatearMonedaMX(f.actual*30)}</td>
            <td><strong>${formatearMonedaMX(f.nuevo*30)}</strong></td>
        </tr>`;
    }).join('');
}

function mostrarAvisoSalarios(texto,tipo='error'){
    const el=document.getElementById('salMensajeAviso');
    if(!el) return;
    el.textContent=texto;
    el.style.color=tipo==='error'?'#b91c1c':'#16a34a';
}

function configurarModuloSalarios(){
    if(document.body.dataset.salariosListo==='1') return;
    document.body.dataset.salariosListo='1';

    document.getElementById('salBuscarEmpleado')?.addEventListener('input',(e)=>{
        renderizarTablaSalarios(filtrarListaPorNombre(window.__salariosCache,e.target.value));
    });

    document.getElementById('salSeleccionarTodos')?.addEventListener('change',(e)=>{
        document.querySelectorAll('.sal-check-empleado').forEach(cb=>{cb.checked=e.target.checked;});
    });

    document.getElementById('btnSalCompararIncremento')?.addEventListener('click',()=>{
        const porcentaje=parseFloat(document.getElementById('salPorcentajeIncremento')?.value);
        if(!Number.isFinite(porcentaje)||porcentaje===0){
            mostrarAvisoSalarios('Ingresa un porcentaje distinto de 0.');
            return;
        }
        const seleccionados=Array.from(document.querySelectorAll('.sal-check-empleado:checked')).map(cb=>Number(cb.value));
        if(!seleccionados.length){
            mostrarAvisoSalarios('Selecciona al menos un empleado de la tabla.');
            return;
        }
        mostrarAvisoSalarios('','ok');
        const filas=window.__salariosCache.filter(emp=>seleccionados.includes(Number(emp.id)));
        window.__salariosComparativaPendiente=filas.map(emp=>{
            const actual=Number(emp.salario_diario||0);
            const nuevo=+(actual*(1+porcentaje/100)).toFixed(2);
            return {id:emp.id,nombre:`${emp.nombre||''} ${emp.apellido||''}`.trim(),empresa:emp.empresa_nombre||'',actual,nuevo};
        });
        renderizarComparativaSalarios(window.__salariosComparativaPendiente);
        const panel=document.getElementById('salPanelComparativo');
        if(panel){ panel.style.display='block'; panel.scrollIntoView({behavior:'smooth',block:'start'}); }
    });

    document.getElementById('btnSalCancelarIncremento')?.addEventListener('click',()=>{
        const panel=document.getElementById('salPanelComparativo');
        if(panel) panel.style.display='none';
        window.__salariosComparativaPendiente=null;
    });

    document.getElementById('btnSalConfirmarIncremento')?.addEventListener('click',async()=>{
        const pendientes=window.__salariosComparativaPendiente;
        if(!pendientes || !pendientes.length) return;
        const ok=await showConfirm(`¿Aplicar el nuevo salario diario fiscal a ${pendientes.length} empleado(s)? Esta acción no se puede deshacer.`, 'Confirmar');
        if(!ok) return;
        const btn=document.getElementById('btnSalConfirmarIncremento');
        if(btn) btn.disabled=true;
        try{
            const cambios=pendientes.map(f=>({id:f.id,nuevoSalario:f.nuevo}));
            const porcentaje=parseFloat(document.getElementById('salPorcentajeIncremento')?.value)||0;
            const res=await window.api.aplicarIncrementoSalarial({cambios,porcentaje});
            if(res && res.ok){
                mostrarNotificacionLocal(`Incremento aplicado a ${res.aplicados} empleado(s). El nuevo salario diario fiscal ya está disponible para finiquitos, liquidaciones y aguinaldos.`,'success');
                const panel=document.getElementById('salPanelComparativo');
                if(panel) panel.style.display='none';
                window.__salariosComparativaPendiente=null;
                const inputPct=document.getElementById('salPorcentajeIncremento');
                if(inputPct) inputPct.value='';
                document.querySelectorAll('.sal-check-empleado:checked').forEach(cb=>{cb.checked=false;});
                const selAll=document.getElementById('salSeleccionarTodos');
                if(selAll) selAll.checked=false;
                await cargarPlantillaSalarios();
                if(window.empresaSeleccionadaId && typeof actualizarVistasPorEmpresa==='function'){
                    await actualizarVistasPorEmpresa(window.empresaSeleccionadaId);
                }
                refrescarPanoramaLaboral();
            }else{
                mostrarNotificacionLocal(res?.error||'No fue posible aplicar el incremento.','error');
            }
        }catch(e){
            console.error('Aplicar incremento salarial:',e);
            mostrarNotificacionLocal('Error al aplicar el incremento: '+e.message,'error');
        }finally{
            if(btn) btn.disabled=false;
        }
    });
}

// ==========================================
// V31 - MÓDULO: AGUINALDOS
// ==========================================
window.__aguinaldosCache = window.__aguinaldosCache || [];
window.__aguinaldosDias = window.__aguinaldosDias || {};

function calcularAguinaldo(salarioDiario,diasLaborados){
    const dias=Math.max(0,Math.min(365,Number(diasLaborados)||0));
    return (Number(salarioDiario)||0)*(dias/365)*15;
}

async function cargarPlantillaAguinaldos(){
    const tbody=document.getElementById('tablaAguinaldos');
    if(!tbody) return;
    if(!window.empresaSeleccionadaId){ tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Selecciona una empresa.</td></tr>'; return; }
    tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Cargando...</td></tr>';
    try{
        const res=await window.api.obtenerEmpleadosPorEmpresa(window.empresaSeleccionadaId);
        const lista=(res&&res.ok)?res.data:(Array.isArray(res)?res:[]);
        window.__aguinaldosCache=lista;
        renderizarTablaAguinaldos(lista);
    }catch(e){
        console.error('Aguinaldos:',e);
        tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#b91c1c;">Error al cargar la plantilla.</td></tr>';
    }
}

function renderizarTablaAguinaldos(lista){
    const tbody=document.getElementById('tablaAguinaldos');
    if(!tbody) return;
    if(!lista || !lista.length){ tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#64748b;">Sin empleados registrados.</td></tr>'; return; }
    tbody.innerHTML=lista.map(emp=>{
        const salarioDiario=Number(emp.salario_diario||0);
        const diasGuardados=(window.__aguinaldosDias[emp.id]!==undefined)?window.__aguinaldosDias[emp.id]:365;
        const monto=calcularAguinaldo(salarioDiario,diasGuardados);
        return `<tr data-empleado-id="${emp.id}">
            <td>${emp.id}</td>
            <td>${escapeHtml(`${emp.nombre||''} ${emp.apellido||''}`.trim())}</td>
            <td>${escapeHtml(emp.empresa_nombre||'')}</td>
            <td>${formatearMonedaMX(salarioDiario)}</td>
            <td>${escapeHtml(emp.fecha_ingreso||'')}</td>
            <td><span class="badge badge-info">${calcularAntiguedad(emp.fecha_ingreso)}</span></td>
            <td><input type="number" class="form-control agu-dias-laborados" min="0" max="365" value="${diasGuardados}" data-empleado-id="${emp.id}" style="width:90px;"></td>
            <td><strong class="agu-monto" data-empleado-id="${emp.id}">${formatearMonedaMX(monto)}</strong></td>
        </tr>`;
    }).join('');
}

function filtroActualAguinaldos(){
    return filtrarListaPorNombre(window.__aguinaldosCache,document.getElementById('aguBuscarEmpleado')?.value);
}

function configurarModuloAguinaldos(){
    if(document.body.dataset.aguinaldosListo==='1') return;
    document.body.dataset.aguinaldosListo='1';

    document.getElementById('aguBuscarEmpleado')?.addEventListener('input',()=>{
        renderizarTablaAguinaldos(filtroActualAguinaldos());
    });

    // Recalcula en vivo el monto de cada renglón cuando se editan los días laborados.
    document.getElementById('tablaAguinaldos')?.addEventListener('input',(e)=>{
        if(!e.target.classList.contains('agu-dias-laborados')) return;
        const id=Number(e.target.dataset.empleadoId);
        let dias=Number(e.target.value);
        if(!Number.isFinite(dias)) dias=0;
        dias=Math.max(0,Math.min(365,dias));
        window.__aguinaldosDias[id]=dias;
        const emp=window.__aguinaldosCache.find(x=>Number(x.id)===id);
        const monto=calcularAguinaldo(emp?.salario_diario||0,dias);
        const celda=document.querySelector(`.agu-monto[data-empleado-id="${id}"]`);
        if(celda) celda.textContent=formatearMonedaMX(monto);
    });

    document.getElementById('btnAguDiasTodos')?.addEventListener('click',()=>{
        const dias=Math.max(0,Math.min(365,Number(document.getElementById('aguDiasParaTodos')?.value)||0));
        window.__aguinaldosCache.forEach(emp=>{ window.__aguinaldosDias[emp.id]=dias; });
        renderizarTablaAguinaldos(filtroActualAguinaldos());
    });

    document.getElementById('btnAguExportar')?.addEventListener('click',async()=>{
        if(!window.__aguinaldosCache.length){
            mostrarNotificacionLocal('No hay empleados para exportar.','error');
            return;
        }
        const datos=window.__aguinaldosCache.map(emp=>{
            const dias=(window.__aguinaldosDias[emp.id]!==undefined)?window.__aguinaldosDias[emp.id]:365;
            const monto=calcularAguinaldo(emp.salario_diario||0,dias);
            return {
                'ID':emp.id,
                'Nombre completo':`${emp.nombre||''} ${emp.apellido||''}`.trim(),
                'Empresa':emp.empresa_nombre||'',
                'Salario diario fiscal':Number(emp.salario_diario||0),
                'Fecha de ingreso':emp.fecha_ingreso||'',
                'Antigüedad':calcularAntiguedad(emp.fecha_ingreso),
                'Días laborados':dias,
                'Aguinaldo a percibir':+monto.toFixed(2)
            };
        });
        try{
            const res=await window.api.guardarReporteExcel({nombre:'Aguinaldos',datos});
            if(res && res.ok) mostrarNotificacionLocal('Plantilla de aguinaldos exportada correctamente.','success');
            else if(!res?.cancelado) mostrarNotificacionLocal(res?.error||'No fue posible exportar.','error');
        }catch(e){
            console.error('Exportar aguinaldos:',e);
            mostrarNotificacionLocal('Error al exportar: '+e.message,'error');
        }
    });
}


async function configurarExportacionFichaPerfil(){const btn=document.getElementById('btnExportarFichaPdf');if(!btn||btn.dataset.configurado==='1')return;btn.dataset.configurado='1';btn.onclick=async()=>{const emp=window.empleadoPerfilSeleccionado;if(!emp?.id)return mostrarNotificacionLocal('Seleccione un empleado.','error');btn.disabled=true;try{const r=await window.api.exportarFichaEmpleadoPdf({empleadoId:emp.id});if(r?.ok)mostrarNotificacionLocal('Ficha exportada correctamente.','success');else if(!r?.cancelado)mostrarNotificacionLocal(r?.error||'No fue posible exportar.','error');}catch(e){mostrarNotificacionLocal(`Error: ${e.message}`,'error');}finally{btn.disabled=false;}};}
function configurarPerfilProfesional(){
    const input=document.getElementById('perfilBusqueda'),res=document.getElementById('perfilResultados');if(!input)return;
    let timer;input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(async()=>{const q=input.value.trim();if(!q){res.style.display='none';return;}const r=await window.api.buscarEmpleados({empresaId:window.empresaSeleccionadaId||null,busqueda:q,estatus:'TODOS'});const arr=normalizarArreglo(r).slice(0,8);res.innerHTML=arr.map(e=>`<div class="search-item" data-profile-id="${e.id}"><strong>${escapeHtml(`${e.nombre||''} ${e.apellido||''}`.trim())}</strong>${Number(e.activo)!==1?' <span class="badge badge-secondary" style="font-size:.7rem;">INACTIVO</span>':''}<br><small>${escapeHtml(e.num_empleado||'')} · ${escapeHtml(e.puesto||'')}</small></div>`).join('')||'<div class="search-item">Sin coincidencias</div>';res.style.display='block';res.querySelectorAll('[data-profile-id]').forEach(x=>x.onclick=()=>{const emp=arr.find(e=>String(e.id)===x.dataset.profileId);mostrarPerfilProfesional(emp);window.empleadoPerfilSeleccionado=emp;document.getElementById('btnExportarFichaPdf')?.removeAttribute('disabled');res.style.display='none';input.value=`${emp.nombre||''} ${emp.apellido||''}`.trim();});},180);});
    document.addEventListener('click',e=>{if(!e.target.closest('.profile-search'))res.style.display='none';});
}
async function mostrarPerfilProfesional(emp){
    if(!emp)return;
    let saldo=0;
    try{
        const r=await window.api.obtenerSaldoVacaciones(emp.id,new Date().toISOString().slice(0,10));
        const a=r?.data||r?.saldo||r;
        saldo=Number(a?.totalUsable??a?.dias_restantes??a?.total_disponible??0);
    }catch(e){console.warn('No fue posible obtener saldo del perfil:',e);}
    const contenido=document.getElementById('perfilContenido');
    if(!contenido)return;
    const activo=Number(emp.activo)===1;
    const antiguedad=typeof calcularAntiguedad==='function'?calcularAntiguedad(emp.fecha_ingreso):'';
    contenido.innerHTML=`
      <div class="profile-summary">
        <div class="profile-box"><span>Empleado</span><strong>${escapeHtml(emp.num_empleado||'')}</strong></div>
        <div class="profile-box"><span>Puesto</span><strong>${escapeHtml(emp.puesto||'Sin puesto')}</strong></div>
        <div class="profile-box"><span>Ingreso</span><strong>${escapeHtml(emp.fecha_ingreso||'')}</strong></div>
        <div class="profile-box"><span>Vacaciones disponibles</span><strong>${saldo}</strong></div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <h3 style="margin:0;"><i class="fa-solid fa-address-card"></i> Expediente completo</h3>
          <span class="badge ${activo?'badge-success':'badge-secondary'}">${activo?'ACTIVO':'INACTIVO'}${!activo&&emp.fecha_baja?' · Baja: '+escapeHtml(emp.fecha_baja):''}</span>
        </div>
        <h4 style="margin:16px 0 6px;color:#64748b;font-size:.85rem;text-transform:uppercase;">Identificación</h4>
        <div class="profile-summary">
          <div class="profile-box"><span>Nombre completo</span><strong>${escapeHtml(`${emp.nombre||''} ${emp.apellido||''}`.trim())}</strong></div>
          <div class="profile-box"><span>Empresa</span><strong>${escapeHtml(emp.empresa_nombre||'')}</strong></div>
          <div class="profile-box"><span>Edad</span><strong>${emp.edad != null && emp.edad !== '' ? escapeHtml(emp.edad) + ' años' : 'No capturada'}</strong></div>
          <div class="profile-box"><span>RFC</span><strong>${escapeHtml(emp.rfc||'No capturado')}</strong></div>
          <div class="profile-box"><span>CURP</span><strong>${escapeHtml(emp.curp||'No capturada')}</strong></div>
          <div class="profile-box"><span>NSS (alta IMSS)</span><strong>${escapeHtml(emp.nss||'No capturado')}</strong></div>
        </div>
        <h4 style="margin:16px 0 6px;color:#64748b;font-size:.85rem;text-transform:uppercase;">Información laboral</h4>
        <div class="profile-summary">
          <div class="profile-box"><span>Antigüedad</span><strong>${escapeHtml(antiguedad||'—')}</strong></div>
          <div class="profile-box"><span>Salario diario</span><strong>$${Number(emp.salario_diario||0).toFixed(2)}</strong></div>
          <div class="profile-box"><span>SBC</span><strong>$${Number(emp.salario_base||0).toFixed(2)}</strong></div>
        </div>
        <h4 style="margin:16px 0 6px;color:#64748b;font-size:.85rem;text-transform:uppercase;">Contrato</h4>
        <div class="profile-summary">
          <div class="profile-box"><span>Fecha de firma</span><strong>${escapeHtml(emp.fecha_contrato||'No capturada')}</strong></div>
          <div class="profile-box"><span>Vencimiento</span><strong>${escapeHtml(emp.fecha_vencimiento_contrato||'No aplica / indefinido')}</strong></div>
          <div class="profile-box">
            <span>Contrato PDF</span>
            ${emp.ruta_contrato_pdf
              ? `<button type="button" class="btn btn-secondary" style="margin-top:6px;padding:4px 10px;font-size:.82rem;" onclick="abrirContratoV25(${Number(emp.id)})"><i class="fa-solid fa-file-pdf"></i> Ver contrato</button>`
              : '<strong>No asociado</strong>'}
          </div>
        </div>
      </div>`;
}

async function cargarCalendarioProfesional() {
    const tbody = document.getElementById('tablaCalendario');
    const detalle = document.getElementById('calendarioDetalle');
    const resumen = document.getElementById('calendarioResumen');
    if (!tbody || !detalle) return;

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#64748b;">Cargando...</td></tr>';
    detalle.innerHTML = '<div class="calendar-empty">Consultando registros...</div>';

    try {
        const res = await window.api.obtenerCalendarioVacaciones({ empresaId: Number(window.empresaSeleccionadaId || 0) });
        if (!res?.ok) throw new Error(res?.error || 'No fue posible consultar el calendario.');
        const data = Array.isArray(res.data) ? res.data : [];

        if (resumen) resumen.textContent = ` · ${data.length} registro(s)`;

        if (!data.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#64748b;">No hay vacaciones registradas para la empresa seleccionada.</td></tr>';
            detalle.innerHTML = '<div class="calendar-empty">No existen registros de vacaciones para mostrar.</div>';
            return;
        }

        tbody.innerHTML = data.map(x => `
            <tr>
                <td><strong>${escapeHtml(`${x.nombre || ''} ${x.apellido || ''}`.trim())}</strong><br><small>${escapeHtml(x.num_empleado || `ID ${x.empleado_id}`)}</small></td>
                <td>${escapeHtml(x.fecha_inicio || '')}</td>
                <td>${escapeHtml(x.fecha_fin || '')}</td>
                <td>${Number(x.dias_solicitados || 0)}</td>
                <td>${escapeHtml(x.estado || '')}</td>
            </tr>`).join('');

        detalle.innerHTML = data.slice(0, 20).map(x => `
            <div class="calendar-detail-card" style="padding:14px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
                    <strong>${escapeHtml(`${x.nombre || ''} ${x.apellido || ''}`.trim())}</strong>
                    <span class="badge badge-success">${Number(x.dias_solicitados || 0)} día(s)</span>
                </div>
                <div style="margin-top:7px;color:#475569;font-size:.9rem;">
                    ${escapeHtml(x.fecha_inicio || '')} ${x.fecha_fin ? `al ${escapeHtml(x.fecha_fin)}` : ''}
                </div>
                <div style="margin-top:5px;color:#64748b;font-size:.82rem;">
                    Folio: ${escapeHtml(x.num_empleado || `ID ${x.empleado_id}`)} · Estado: ${escapeHtml(x.estado || '')}
                </div>
            </div>`).join('');
    } catch (err) {
        console.error('Calendario:', err);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#dc2626;">Error: ${escapeHtml(err.message)}</td></tr>`;
        detalle.innerHTML = `<div class="calendar-empty" style="color:#dc2626;">Error al cargar el detalle: ${escapeHtml(err.message)}</div>`;
    }
}

function configurarCalendarioProfesional() {
    const btn = document.getElementById('btnActualizarCalendario');
    if (btn && btn.dataset.configurado !== '1') {
        btn.dataset.configurado = '1';
        btn.addEventListener('click', cargarCalendarioProfesional);
    }
}
window.cargarCalendarioProfesional = cargarCalendarioProfesional;
window.configurarCalendarioProfesional = configurarCalendarioProfesional;
function configurarModuloVacaciones() {
    // La lógica principal del módulo se configura mediante el buscador, el resumen,
    // el historial y el formulario. Esta función existe para mantener un único
    // punto de inicialización y evitar que una referencia inexistente detenga
    // el resto de los listeners del DOM.
    const form = document.getElementById('formSolicitudVacaciones');
    if (form) form.setAttribute('novalidate', 'false');
}

window.configurarModuloVacaciones = configurarModuloVacaciones;
window.configurarFormularioEmpleado = configurarFormularioEmpleado;

async function imprimirReportePdf(titulo, contenidoHtml, empresaId) {
    try {
        if (window.api && typeof window.api.guardarReportePdf === 'function') {
            const res = await window.api.guardarReportePdf({
                nombre: titulo,
                html: contenidoHtml,
                empresaId: empresaId || window.empresaSeleccionadaId || null
            });
            if (res?.ok) {
                console.log('✅ PDF guardado:', res.filePath);
            } else if (!res?.cancelado) {
                await showAlert('Error al guardar el PDF: ' + (res?.error || 'Error desconocido'), 'Aviso', 'error');
            }
            return res;
        }

        const ventana = window.open('', '_blank', 'width=900,height=650');
        if (!ventana) {
            await showAlert('⚠️ No fue posible abrir la vista de impresión.', 'Aviso', 'warning');
            return { ok: false, error: 'Ventana de impresión bloqueada.' };
        }
        ventana.document.write(`<!DOCTYPE html><html><head><title>${titulo}</title><style>
            body{font-family:Segoe UI,Arial,sans-serif;padding:25px;color:#1e293b}
            table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #cbd5e1;padding:8px 12px;text-align:left}
            th{background:#f1f5f9}h2{margin-bottom:5px}.empresa-header{font-weight:700}.fecha,.total-empleados{color:#64748b}
        </style></head><body>${contenidoHtml}</body></html>`);
        ventana.document.close();
        ventana.focus();
        setTimeout(() => { ventana.print(); ventana.close(); }, 300);
        return { ok: true };
    } catch (err) {
        console.error('❌ Error generando PDF:', err);
        await showAlert('Error al generar el PDF: ' + err.message, 'Aviso', 'error');
        return { ok: false, error: err.message };
    }
}


function configurarAdministracionProfesional(){
    document.getElementById('btnCambiarPasswordAdmin')?.addEventListener('click',()=>abrirModalPassword(false));
    document.getElementById('btnCerrarPassword')?.addEventListener('click',cerrarModalPassword);
    document.getElementById('btnGuardarPassword')?.addEventListener('click',async()=>{const msg=document.getElementById('passwordMensaje'),a=document.getElementById('passwordActual').value,n=document.getElementById('passwordNueva').value,n2=document.getElementById('passwordNueva2').value;if(n!==n2){msg.textContent='Las contraseñas nuevas no coinciden.';return;}const r=await window.api.cambiarPasswordAdmin({actual:a,nueva:n});if(!r.ok){msg.textContent=r.error||'No se pudo cambiar la contraseña.';return;}msg.style.color='#0f766e';msg.textContent='Contraseña actualizada correctamente.';setTimeout(cerrarModalPassword,700);});
    document.getElementById('btnCrearBackup')?.addEventListener('click',async()=>{const el=document.getElementById('backupMensaje');const r=await window.api.crearRespaldo();el.textContent=r.ok?'Respaldo creado correctamente.':(r.cancelado?'Operación cancelada.':(r.error||'Error al crear respaldo.'));cargarAuditoriaProfesional();});
    document.getElementById('btnActualizarAuditoria')?.addEventListener('click',cargarAuditoriaProfesional);document.querySelectorAll('.nav-item[data-target="mod-admin"]').forEach(x=>x.addEventListener('click',cargarAuditoriaProfesional));

    document.getElementById('btnNuevaEmpresa')?.addEventListener('click',()=>abrirModalEmpresa(null));
    document.getElementById('btnCerrarModalEmpresa')?.addEventListener('click',cerrarModalEmpresa);
    document.getElementById('btnGuardarEmpresa')?.addEventListener('click',guardarEmpresaAdmin);
    document.getElementById('tablaEmpresasAdmin')?.addEventListener('click',manejarClicTablaEmpresas);
    document.querySelectorAll('.nav-item[data-target="mod-admin"]').forEach(x=>x.addEventListener('click',cargarTablaEmpresasAdmin));

    document.getElementById('btnSeleccionarLogoEmpresa')?.addEventListener('click',async()=>{
        if(!window.api?.seleccionarLogoEmpresa) return;
        const r=await window.api.seleccionarLogoEmpresa();
        if(!r?.ok) return;
        document.getElementById('empresaLogoRutaTemporal').value=r.rutaTemporal||'';
        document.getElementById('empresaLogoEliminar').value='0';
        const preview=document.getElementById('empresaLogoPreview');
        if(preview && r.previewDataUrl) preview.src=r.previewDataUrl;
        const btnQuitar=document.getElementById('btnQuitarLogoEmpresa');
        if(btnQuitar) btnQuitar.style.display='inline-flex';
    });
    document.getElementById('btnQuitarLogoEmpresa')?.addEventListener('click',async()=>{
        document.getElementById('empresaLogoRutaTemporal').value='';
        document.getElementById('empresaLogoEliminar').value='1';
        const preview=document.getElementById('empresaLogoPreview');
        if(preview && window.api?.obtenerLogoDefault){
            try{const r=await window.api.obtenerLogoDefault();preview.src=r?.dataUrl||'';}catch(_){}
        }
        document.getElementById('btnQuitarLogoEmpresa').style.display='none';
    });
}
async function cargarAuditoriaProfesional(){try{const r=await window.api.obtenerAuditoria();const data=r?.data||[];document.getElementById('tablaAuditoria').innerHTML=data.map(x=>`<tr><td>${escapeHtml(x.fecha||'')}</td><td>${escapeHtml(x.usuario||'')}</td><td>${escapeHtml(x.accion||'')}</td><td>${escapeHtml(x.modulo||'')}</td><td>${escapeHtml(x.detalle||'')}</td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;padding:25px">Sin movimientos registrados.</td></tr>';}catch(e){console.error(e);}}

// ==========================================
// ADMINISTRACIÓN: CRUD de empresas
// ==========================================
async function cargarTablaEmpresasAdmin(){
    const tbody=document.getElementById('tablaEmpresasAdmin');
    if(!tbody||!window.api?.obtenerEmpresas) return;
    try{
        const r=await window.api.obtenerEmpresas();
        const lista=(r?.ok&&Array.isArray(r.data))?r.data:[];
        window.empresas=lista;
        tbody.innerHTML=lista.map(e=>`
            <tr>
                <td><img src="${e.logoDataUrl||''}" alt="Logotipo" style="width:34px;height:34px;object-fit:contain;border-radius:6px;border:1px solid #e2e8f0;background:#fff;"></td>
                <td>${escapeHtml(e.nombre||'')}</td>
                <td>${escapeHtml(e.rfc||'')}</td>
                <td style="white-space:nowrap;">
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:.8rem;" data-accion-empresa="editar" data-id="${e.id}"><i class="fa-solid fa-pen"></i> Editar</button>
                    <button type="button" class="btn" style="padding:4px 10px;font-size:.8rem;background-color:#dc2626;color:#fff;border:none;" data-accion-empresa="eliminar" data-id="${e.id}"><i class="fa-solid fa-trash"></i> Eliminar</button>
                </td>
            </tr>
        `).join('')||'<tr><td colspan="4" style="text-align:center;padding:25px">Sin empresas registradas.</td></tr>';
    }catch(e){console.error('Cargar empresas (admin):',e);}
}

async function abrirModalEmpresa(empresa){
    const modal=document.getElementById('modalEmpresa');
    if(!modal) return;
    document.getElementById('modalEmpresaTitulo').innerHTML=empresa?.id?'<i class="fa-solid fa-building"></i> Editar empresa':'<i class="fa-solid fa-building"></i> Nueva empresa';
    document.getElementById('empresaIdEdicion').value=empresa?.id||'';
    document.getElementById('empresaNombreInput').value=empresa?(empresa.nombre||''):'';
    document.getElementById('empresaRfcInput').value=empresa?(empresa.rfc||''):'';
    document.getElementById('empresaModalMensaje').textContent='';
    document.getElementById('empresaLogoRutaTemporal').value='';
    document.getElementById('empresaLogoEliminar').value='0';
    const preview=document.getElementById('empresaLogoPreview');
    const btnQuitar=document.getElementById('btnQuitarLogoEmpresa');
    if(btnQuitar) btnQuitar.style.display=(empresa?.id && empresa?.logoPersonalizado)?'inline-flex':'none';
    if(preview){
        if(empresa?.logoDataUrl){
            preview.src=empresa.logoDataUrl;
        }else if(window.api?.obtenerLogoDefault){
            try{const r=await window.api.obtenerLogoDefault();preview.src=r?.dataUrl||'';}catch(_){preview.src='';}
        }
    }
    modal.style.display='grid';
    setTimeout(()=>document.getElementById('empresaNombreInput')?.focus(),0);
}

function cerrarModalEmpresa(){
    const modal=document.getElementById('modalEmpresa');
    if(modal) modal.style.display='none';
}

async function guardarEmpresaAdmin(){
    const msg=document.getElementById('empresaModalMensaje');
    const id=Number(document.getElementById('empresaIdEdicion').value||0);
    const nombre=document.getElementById('empresaNombreInput').value.trim();
    const rfc=document.getElementById('empresaRfcInput').value.trim().toUpperCase();
    const logoRutaTemporal=document.getElementById('empresaLogoRutaTemporal').value||'';
    const eliminarLogo=document.getElementById('empresaLogoEliminar').value==='1';
    if(!nombre){ if(msg) msg.textContent='El nombre de la empresa es obligatorio.'; return; }

    const btn=document.getElementById('btnGuardarEmpresa');
    if(btn) btn.disabled=true;
    try{
        const payload={id,nombre,rfc,logoRutaTemporal,eliminarLogo};
        const res=id
            ? await window.api.actualizarEmpresa(payload)
            : await window.api.crearEmpresa(payload);
        if(!res?.ok){ if(msg) msg.textContent=res?.error||'No fue posible guardar la empresa.'; return; }

        mostrarNotificacionLocal(id?'Empresa actualizada.':'Empresa creada.','success');
        cerrarModalEmpresa();
        await cargarTablaEmpresasAdmin();
        if(typeof cargarEmpresas==='function') await cargarEmpresas();
    }catch(err){
        console.error('Guardar empresa:',err);
        if(msg) msg.textContent='Error: '+err.message;
    }finally{
        if(btn) btn.disabled=false;
    }
}

async function manejarClicTablaEmpresas(ev){
    const btn=ev.target.closest('[data-accion-empresa]');
    if(!btn) return;
    const id=Number(btn.dataset.id||0);
    if(!id) return;
    const empresa=(window.empresas||[]).find(e=>Number(e.id)===id);

    if(btn.dataset.accionEmpresa==='editar'){
        await abrirModalEmpresa(empresa||{id});
        return;
    }

    if(btn.dataset.accionEmpresa==='eliminar'){
        const confirmar=await window.showConfirm(
            `¿Eliminar la empresa "${empresa?.nombre||id}"? Esta acción no se puede deshacer.`,
            'Confirmar'
        );
        if(!confirmar) return;
        btn.disabled=true;
        try{
            const res=await window.api.eliminarEmpresa(id);
            if(!res?.ok){ await window.showAlert(res?.error||'No fue posible eliminar la empresa.','Aviso','error'); return; }
            mostrarNotificacionLocal('Empresa eliminada.','success');
            await cargarTablaEmpresasAdmin();
            if(typeof cargarEmpresas==='function') await cargarEmpresas();
        }catch(err){
            console.error('Eliminar empresa:',err);
            await window.showAlert('Error al eliminar: '+err.message,'Aviso','error');
        }finally{
            btn.disabled=false;
        }
    }
}

/* V16: actualizar historial respetando el filtro de búsqueda */
document.addEventListener('click', function(e) {
  const btn = e.target.closest('#btnActualizarHistorialIncidencias');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();

  const input = document.getElementById('buscarHistorialIncidenciasV16');
  const id = Number(input?.dataset.empleadoId || 0);
  const busqueda = input?.value?.trim() || '';

  cargarHistorialIncidencias({
    empleadoId: id,
    busqueda
  }).catch(console.error);
}, true);


console.log('V17 RRHH: validación inline RFC/NSS, importación Excel y foco de expediente cargados.');

console.log('V21 cargado: historial vacaciones + limpieza de contexto por módulo.');

/* V34: validación de porcentaje de prima de antigüedad (40%–100%). */
document.addEventListener('DOMContentLoaded', () => {
  const pa = document.getElementById('finPorcentajePrimaAntiguedad');
  if (!pa || pa.dataset.v34Bound === '1') return;
  pa.dataset.v34Bound = '1';
  const normalizarPA = () => {
    let v = Number(pa.value);
    if (!Number.isFinite(v)) v = 100;
    v = Math.min(100, Math.max(40, v));
    pa.value = String(v);
  };
  pa.addEventListener('blur', normalizarPA);
  pa.addEventListener('change', normalizarPA);
});
