const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const Database = require('better-sqlite3-multiple-ciphers');

let mainWindow;
let db;
let dbPath;
let sesionIniciada = false;

// ==========================================
// CONTROL DE ACCESO A NIVEL DE IPC
// ==========================================
// El login de la app es una cortina visual del renderer; sin esto, cualquier
// script con acceso a window.api (ej. la consola de DevTools) podía invocar
// directamente los canales de IPC sin haber iniciado sesión. Los canales de
// solo lectura quedan abiertos porque la app los usa para precargar datos
// ANTES de que el login se resuelva (así el login se siente instantáneo);
// todo lo que crea, modifica, elimina, paga, importa, respalda o exporta
// PDF/Excel exige sesión iniciada. Un canal nuevo queda protegido por
// defecto salvo que se agregue explícitamente a este allowlist.
const CANALES_LECTURA_SIN_SESION = new Set([
    'vacaciones:diagnostico-bd',
    'dashboard:resumen',
    'auditoria:listar',
    'reportes:calendario-vacaciones',
    'isr:obtener-tabla-mensual',
    'empresas:obtener',
    'empleados:obtener-por-empresa',
    'empleados:buscar',
    'empleados:obtener-por-id',
    'contratos:obtener-resumen',
    'vacaciones:obtener-remanente-finiquito',
    'vacaciones:obtener-saldo',
    'vacaciones:obtener-historial',
    'incidencias:obtener-todas',
    'incidencias:obtener-por-empleado',
    'finiquitos:simular',
    'finiquitos:obtener-por-empleado',
    'finiquitos:obtener-historial',
    'reportes:obtener-resumen-empresa',
]);
const _ipcHandleOriginal = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (canal, listener) => {
    if (canal === 'auth:login' || CANALES_LECTURA_SIN_SESION.has(canal)) {
        return _ipcHandleOriginal(canal, listener);
    }
    return _ipcHandleOriginal(canal, async (event, ...args) => {
        if (!sesionIniciada) return { ok: false, error: 'Debes iniciar sesión para realizar esta acción.' };
        return listener(event, ...args);
    });
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// ==========================================
// HELPERS UTILITARIOS
// ==========================================

function normalizarFecha(fechaStr) {
    if (!fechaStr) return null;
    const s = String(fechaStr).trim();
    
    // Formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const parts = s.substring(0, 10).split('-');
        return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    // Formato DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
        const parts = s.split('/');
        return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
    
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function parseExcelFecha(valor) {
    if (!valor) return obtenerFechaLocal();
    if (typeof valor === 'number') {
        const fecha = XLSX.SSF.parse_date_code(valor);
        if (fecha) {
            const m = String(fecha.m).padStart(2, '0');
            const d = String(fecha.d).padStart(2, '0');
            return `${fecha.y}-${m}-${d}`;
        }
    }
    const stringFecha = String(valor).trim();
    if (stringFecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return stringFecha;
    }
    return stringFecha;
}

// Detecta si una fecha en texto tipo "3/4/2024" es genuinamente ambigua
// (día/mes/año vs. mes/día/año) antes de guardarla. No intenta adivinar:
// solo distingue entre casos donde la ambigüedad es real (ambas partes <=12)
// y casos donde el rango de un componente ya descarta una interpretación.
function analizarFechaTexto(valor) {
    if (typeof valor === 'number') return { tipo: 'serial' };
    const s = String(valor ?? '').trim();
    if (!s) return { tipo: 'vacia' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { tipo: 'iso' };
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) return { tipo: 'desconocida' };
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), anio = m[3];
    if (a > 12 && b <= 12) return { tipo: 'no_ambigua', dia: a, mes: b, anio };
    if (b > 12 && a <= 12) return { tipo: 'no_ambigua', dia: b, mes: a, anio };
    if (a <= 12 && b <= 12) return { tipo: 'ambigua', a, b, anio, texto: s };
    return { tipo: 'desconocida' };
}

// Superconjunto de parseExcelFecha: para serial de Excel, ISO, vacío o texto
// no reconocible el comportamiento es idéntico al de siempre. Solo agrega
// tratamiento explícito para fechas de texto ambiguas, usando el formato que
// el usuario confirmó (formatoFecha: 'DMY' o 'MDY') en vez de adivinar.
function resolverFechaConFormato(valor, formatoFecha) {
    const info = analizarFechaTexto(valor);
    if (info.tipo === 'no_ambigua') {
        return `${info.anio}-${String(info.mes).padStart(2, '0')}-${String(info.dia).padStart(2, '0')}`;
    }
    if (info.tipo === 'ambigua') {
        const dia = formatoFecha === 'MDY' ? info.b : info.a;
        const mes = formatoFecha === 'MDY' ? info.a : info.b;
        return `${info.anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
    return parseExcelFecha(valor);
}

function escaparHtmlPdf(valor) {
    return String(valor ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function obtenerFechaLocal() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Retorna los días de vacaciones según LFT México (reforma Vacaciones Dignas)
 */
function calcularDiasVacacionesLFT(anios) {
    if (anios < 1) return 0;
    if (anios === 1) return 12;
    if (anios === 2) return 14;
    if (anios === 3) return 16;
    if (anios === 4) return 18;
    if (anios === 5) return 20;
    if (anios >= 6 && anios <= 10) return 22;
    if (anios >= 11 && anios <= 15) return 24;
    if (anios >= 16 && anios <= 20) return 26;
    if (anios >= 21 && anios <= 25) return 28;
    if (anios >= 26 && anios <= 30) return 30;
    return 32;
}

// V34 - Factor de integración del salario (mismo criterio que usa CONTPAQi y el
// Excel "INTEGRADOS DEFINITIVOS": FI = (365 + días de aguinaldo + (días de
// vacaciones × % de prima vacacional)) / 365. Los días de vacaciones se toman
// de la MISMA tabla LFT (calcularDiasVacacionesLFT) que ya usa el módulo de
// Vacaciones, así que el factor de integración es consistente con el resto
// del sistema. Aguinaldo (15 días) y prima vacacional (25%) son las mismas
// constantes que ya usan los módulos de Aguinaldos y Finiquitos.
const SDI_DIAS_AGUINALDO = 15;
const SDI_PRIMA_VACACIONAL_PCT = 25;

// V35 - Años de antigüedad para la tabla de vacaciones/factor de integración:
// mismo criterio que Finiquitos (aniosCalculo = años cumplidos + 1, ver
// aniosCumplidosFiniquitoV23 / calcularFiniquitoV23) y que el Excel
// "INTEGRADOS DEFINITIVOS" (columna AÑOS ANTIGÜEDAD = años cumplidos a la
// fecha de corte + 1). Así el empleado ya cuenta, para efectos de vacaciones
// e integración, el año de servicio que está cursando.
function calcularFactorIntegracionSDI(fechaIngreso, fechaReferencia) {
    const ing = normalizarFecha(fechaIngreso);
    const ref = normalizarFecha(fechaReferencia) || normalizarFecha(obtenerFechaLocal());
    if (!ing || !ref || ref < ing) return { aniosCumplidos: 0, aniosAntiguedad: 1, diasVacaciones: 12, primaVacacionalDias: 3, factor: 1 };
    let aniosCumplidos = ref.getFullYear() - ing.getFullYear();
    if (ref.getMonth() < ing.getMonth() ||
        (ref.getMonth() === ing.getMonth() && ref.getDate() < ing.getDate())) aniosCumplidos--;
    aniosCumplidos = Math.max(0, aniosCumplidos);
    const aniosAntiguedad = aniosCumplidos + 1;
    const diasVacaciones = calcularDiasVacacionesLFT(aniosAntiguedad);
    const primaVacacionalDias = diasVacaciones * (SDI_PRIMA_VACACIONAL_PCT / 100);
    const factor = (365 + SDI_DIAS_AGUINALDO + primaVacacionalDias) / 365;
    return { aniosCumplidos, aniosAntiguedad, diasVacaciones, primaVacacionalDias, factor };
}

// ==========================================
// 1. CONEXIÓN Y HELPERS BETTER-SQLITE3
// ==========================================

const SALT_CIFRADO_DB = 'SISTEMA_RRHH_VACACIONES_V3_SALT_FIJO_2026';
const CABECERA_SQLITE_PLANO = 'SQLite format 3';

// Fórmula de llave heredada (v3): derivada solo de datos NO secretos de la máquina
// (hostname, usuario de Windows, ruta). Cualquiera con acceso al equipo puede
// recalcularla — no protege contra un atacante local. Se conserva únicamente
// para poder abrir/re-cifrar bases de datos creadas antes del refuerzo de
// seguridad (ver obtenerClaveCifradoDB).
function obtenerClaveCifradoDBHeredada() {
    const materialClave = [
        os.hostname(),
        os.userInfo().username,
        process.platform,
        app.getPath('userData')
    ].join('|');
    return crypto.scryptSync(materialClave, SALT_CIFRADO_DB, 32).toString('hex');
}

// ==========================================
// GESTIÓN SEGURA DE LLAVES (Electron safeStorage / DPAPI en Windows)
// ==========================================
// Genera (una sola vez) un secreto aleatorio de 256 bits por archivo y lo
// guarda cifrado con el almacén de credenciales del sistema operativo,
// ligado a la cuenta de Windows del usuario — a diferencia de la fórmula
// heredada de arriba, esto SÍ es un secreto real: nadie puede leerlo sin
// iniciar sesión como ese usuario de Windows.
function obtenerOCrearSecretoSeguro(nombreArchivo) {
    const rutaSecreto = path.join(app.getPath('userData'), nombreArchivo);
    if (fs.existsSync(rutaSecreto)) {
        const cifrado = fs.readFileSync(rutaSecreto);
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error(`El almacén seguro del sistema operativo no está disponible para leer ${nombreArchivo}.`);
        }
        return Buffer.from(safeStorage.decryptString(cifrado), 'hex');
    }
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(`El almacén seguro del sistema operativo no está disponible para crear ${nombreArchivo}.`);
    }
    const nuevoSecreto = crypto.randomBytes(32);
    const cifrado = safeStorage.encryptString(nuevoSecreto.toString('hex'));
    fs.writeFileSync(rutaSecreto, cifrado);
    return nuevoSecreto;
}

let _claveCifradoDBCache = null;
// Llave real (v4) de la base de datos completa: secreto aleatorio protegido
// por el sistema operativo, no una fórmula recalculable.
function obtenerClaveCifradoDB() {
    if (_claveCifradoDBCache) return _claveCifradoDBCache;
    const secreto = obtenerOCrearSecretoSeguro('db.key');
    _claveCifradoDBCache = secreto.toString('hex');
    return _claveCifradoDBCache;
}

let _claveCifradoCamposCache = null;
let _claveIndiceCiegoCache = null;
let _claveArchivosCache = null;
// Llaves derivadas de un mismo secreto maestro para el cifrado de datos
// sensibles del expediente (RFC/NSS/CURP y documentos adjuntos) — independientes
// de la llave de la base de datos completa: defensa en profundidad ante un
// respaldo (.db) o un volcado que de otra forma quedara legible en cuanto se
// abre con la llave de la base de datos. Cada uso (campo, índice ciego,
// archivo) tiene su propia sub-llave para no reutilizar una misma llave con
// distintos propósitos criptográficos.
function obtenerClavesCifradoCampos() {
    if (_claveCifradoCamposCache && _claveIndiceCiegoCache && _claveArchivosCache) {
        return { claveCifrado: _claveCifradoCamposCache, claveIndice: _claveIndiceCiegoCache, claveArchivos: _claveArchivosCache };
    }
    const maestra = obtenerOCrearSecretoSeguro('pii.key');
    _claveCifradoCamposCache = crypto.createHmac('sha256', maestra).update('campo-cifrado-v1').digest();
    _claveIndiceCiegoCache = crypto.createHmac('sha256', maestra).update('indice-ciego-v1').digest();
    _claveArchivosCache = crypto.createHmac('sha256', maestra).update('archivo-cifrado-v1').digest();
    return { claveCifrado: _claveCifradoCamposCache, claveIndice: _claveIndiceCiegoCache, claveArchivos: _claveArchivosCache };
}

// Cifra un valor sensible (RFC/NSS/CURP) con AES-256-GCM e IV aleatorio por
// valor — dos empleados con el mismo RFC producen cifrados distintos, así
// que la duplicidad se controla aparte con indiceCiegoCampo().
function cifrarCampoSensible(valorPlano) {
    const valor = String(valorPlano ?? '').trim();
    if (!valor) return null;
    const { claveCifrado } = obtenerClavesCifradoCampos();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', claveCifrado, iv);
    const cifrado = Buffer.concat([cipher.update(valor, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `encv1.${iv.toString('base64')}.${tag.toString('base64')}.${cifrado.toString('base64')}`;
}

function descifrarCampoSensible(valorCifrado) {
    if (!valorCifrado) return null;
    try {
        const partes = String(valorCifrado).split('.');
        if (partes.length !== 4 || partes[0] !== 'encv1') return null;
        const { claveCifrado } = obtenerClavesCifradoCampos();
        const iv = Buffer.from(partes[1], 'base64');
        const tag = Buffer.from(partes[2], 'base64');
        const cifrado = Buffer.from(partes[3], 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', claveCifrado, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
    } catch (error) {
        console.error('No se pudo descifrar un campo sensible:', error.message);
        return null;
    }
}

// Huella determinística (HMAC-SHA256) del valor normalizado: mismo RFC/NSS
// siempre produce la misma huella, lo que permite mantener la detección de
// duplicados y la búsqueda exacta sin exponer ni almacenar el valor real.
function indiceCiegoCampo(valorNormalizado) {
    const valor = String(valorNormalizado ?? '').trim();
    if (!valor) return null;
    const { claveIndice } = obtenerClavesCifradoCampos();
    return crypto.createHmac('sha256', claveIndice).update(valor).digest('hex');
}

// Aplica el descifrado de RFC/NSS/CURP sobre una fila de empleado ya leída de
// la BD (que trae las columnas *_enc). No falla si la fila no las trae.
function descifrarCamposEmpleado(fila) {
    if (!fila) return fila;
    if ('rfc_enc' in fila) fila.rfc = descifrarCampoSensible(fila.rfc_enc);
    if ('nss_enc' in fila) fila.nss = descifrarCampoSensible(fila.nss_enc);
    if ('curp_enc' in fila) fila.curp = descifrarCampoSensible(fila.curp_enc);
    return fila;
}

function descifrarCamposEmpleados(filas) {
    return (filas || []).map(descifrarCamposEmpleado);
}

// ==========================================
// CIFRADO DE ARCHIVOS DEL EXPEDIENTE (documentos_empleado)
// ==========================================
const CABECERA_ARCHIVO_CIFRADO = Buffer.from('EFC1', 'utf8');

function cifrarBufferArchivo(bufferOriginal) {
    const { claveArchivos } = obtenerClavesCifradoCampos();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', claveArchivos, iv);
    const cifrado = Buffer.concat([cipher.update(bufferOriginal), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([CABECERA_ARCHIVO_CIFRADO, iv, tag, cifrado]);
}

function descifrarBufferArchivo(bufferCifrado) {
    const cabecera = bufferCifrado.subarray(0, 4);
    if (!cabecera.equals(CABECERA_ARCHIVO_CIFRADO)) throw new Error('Formato de archivo cifrado no reconocido.');
    const iv = bufferCifrado.subarray(4, 16);
    const tag = bufferCifrado.subarray(16, 32);
    const cifrado = bufferCifrado.subarray(32);
    const { claveArchivos } = obtenerClavesCifradoCampos();
    const decipher = crypto.createDecipheriv('aes-256-gcm', claveArchivos, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cifrado), decipher.final()]);
}

function carpetaExpedienteEmpleado(empleadoId) {
    const dir = path.join(app.getPath('userData'), 'expedientes', String(empleadoId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Catálogo de tipos de documento del expediente digital. Los primeros cuatro
// se consideran obligatorios para el aviso de "expediente incompleto" del
// panorama laboral; el resto son informativos.
const DOCUMENTOS_REQUERIDOS_EXPEDIENTE = ['INE', 'ACTA_NACIMIENTO', 'COMPROBANTE_DOMICILIO', 'CONTRATO_FIRMADO'];
const CATALOGO_TIPOS_DOCUMENTO = {
    INE: 'Identificación oficial (INE)',
    ACTA_NACIMIENTO: 'Acta de nacimiento',
    COMPROBANTE_DOMICILIO: 'Comprobante de domicilio',
    CONTRATO_FIRMADO: 'Contrato firmado',
    RFC_DOC: 'Constancia de situación fiscal (RFC)',
    NSS_DOC: 'Constancia de afiliación IMSS (NSS)',
    CURP_DOC: 'CURP',
    OTRO: 'Otro documento'
};

function archivoEsSQLitePlano(ruta) {
    const fd = fs.openSync(ruta, 'r');
    try {
        const cabecera = Buffer.alloc(16);
        const leidos = fs.readSync(fd, cabecera, 0, 16, 0);
        if (leidos !== 16) return false;
        return cabecera.toString('utf8', 0, 15) === CABECERA_SQLITE_PLANO && cabecera[15] === 0;
    } finally {
        fs.closeSync(fd);
    }
}

function puedeLeerBaseDeDatos(instanciaDB) {
    try {
        instanciaDB.prepare('SELECT count(*) FROM sqlite_master').get();
        return true;
    } catch (_) {
        return false;
    }
}

function abrirDB() {
    dbPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'sistema_rrhh.db')
        : path.join(app.getPath('userData'), 'sistema_rrhh_dev.db');

    const claveNueva = obtenerClaveCifradoDB();
    const existiaArchivo = fs.existsSync(dbPath);
    const esLegacySinCifrar = existiaArchivo && archivoEsSQLitePlano(dbPath);

    if (esLegacySinCifrar) {
        const rutaBackup = `${dbPath}.sin-cifrar.bak`;
        fs.copyFileSync(dbPath, rutaBackup);
        console.log('DB legacy sin cifrar detectada. Backup creado en:', rutaBackup);
        db = new Database(dbPath);
        // SQLCipher no permite "rekey" en modo journal WAL; se hace en modo DELETE
        // (por defecto en una conexión nueva) y se cambia a WAL después, al final.
        db.pragma(`rekey='${claveNueva}'`);
        console.log('DB migrada a cifrado exitosamente (llave protegida por el sistema operativo).');
    } else if (existiaArchivo) {
        db = new Database(dbPath);
        db.pragma(`key='${claveNueva}'`);
        if (!puedeLeerBaseDeDatos(db)) {
            // La llave nueva (protegida por el SO) no abrió el archivo: es una BD
            // cifrada con la fórmula heredada v3 (derivada de datos no secretos de
            // la máquina). Se reintenta con esa fórmula y, si funciona, se re-cifra
            // de una vez con la llave nueva para dejar de depender de ella.
            db.close();
            const claveHeredada = obtenerClaveCifradoDBHeredada();
            db = new Database(dbPath);
            db.pragma(`key='${claveHeredada}'`);
            if (!puedeLeerBaseDeDatos(db)) {
                db.close();
                throw new Error('No fue posible abrir la base de datos: la llave de cifrado no coincide.');
            }
            // El archivo ya puede estar en modo WAL de una sesión anterior — SQLCipher
            // no permite "rekey" en ese modo, así que se cambia a DELETE antes de
            // recifrar (journal_mode = WAL se vuelve a fijar más abajo, al final).
            db.pragma('journal_mode = DELETE');
            db.pragma(`rekey='${claveNueva}'`);
            console.log('DB re-cifrada con la llave protegida por el sistema operativo (migración desde la fórmula heredada).');
        }
    } else {
        db = new Database(dbPath);
        db.pragma(`key='${claveNueva}'`);
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('Base de datos conectada (cifrada) en:', dbPath);
    return db;
}

const REGEX_SQL_ESCRITURA = /^\s*(INSERT|UPDATE|DELETE)\b/i;

function detectarTabla(sql) {
    if (!sql) return 'otros';
    const s = String(sql).toLowerCase();
    if (s.includes('empleados')) return 'empleados';
    if (s.includes('vacaciones')) return 'vacaciones';
    if (s.includes('incidencias')) return 'incidencias';
    if (s.includes('finiquitos') || s.includes('finiquitos_liquidaciones')) return 'finiquitos';
    if (s.includes('salarios') || s.includes('aguinaldos')) return 'salarios';
    return 'otros';
}

function notificarCambioDB(info) {
    const payload = (typeof info === 'string' || info == null)
        ? { tabla: info || null, origen: info || null, ts: Date.now() }
        : { tabla: info.tabla || null, origen: info.origen || null, ts: info.ts || Date.now() };
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('db:changed', payload);
    }
}

const dbRun = (sql, params = []) => {
    const info = db.prepare(sql).run(params);
    // Solo INSERT/UPDATE/DELETE notifican — evita ruido de CREATE TABLE/ALTER/PRAGMA
    // durante el arranque (crearTablas) y de los BEGIN/COMMIT/ROLLBACK manuales que
    // usan varios handlers junto con dbRun.
    if (REGEX_SQL_ESCRITURA.test(sql)) {
        try {
            notificarCambioDB({ tabla: detectarTabla(sql), origen: 'dbRun', ts: Date.now() });
        } catch (e) {
            console.warn('notificarCambioDB fail', e.message);
        }
    }
    return { lastID: info.lastInsertRowid, changes: info.changes };
};

const dbGet = (sql, params = []) => {
    return db.prepare(sql).get(params);
};

const dbAll = (sql, params = []) => {
    return db.prepare(sql).all(params);
};

// ==========================================
// 2. CREACIÓN DE TABLAS
// ==========================================

async function crearTablas() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS empresas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL UNIQUE,
            rfc TEXT
        );
    `);

    const totalEmpresas = await dbGet(`SELECT COUNT(*) as total FROM empresas`);
    if (totalEmpresas.total === 0) {
        await dbRun(`
            INSERT INTO empresas (nombre) VALUES 
            ('EYASA S DE RL DE CV'), 
            ('ONCE CERO NUEVE'), 
            ('QUALITY ROADS DE MEXICO');
        `);
    }

    await dbRun(`
        CREATE TABLE IF NOT EXISTS empleados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            num_empleado TEXT,
            nombre TEXT NOT NULL,
            apellido TEXT NOT NULL,
            puesto TEXT,
            fecha_ingreso TEXT NOT NULL,
            salario_diario REAL DEFAULT 0,
            salario_base REAL DEFAULT 0,
            curp TEXT,
            rfc TEXT,
            nss TEXT,
            ruta_contrato_pdf TEXT,
            activo INTEGER DEFAULT 1,
            fecha_baja TEXT,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT
        );
    `);

    // V25: fechas contractuales para control de vigencia.
    const columnasEmpleadosContrato = await dbAll(`PRAGMA table_info(empleados)`);
    const nombresEmpleadosContrato = new Set(columnasEmpleadosContrato.map(c => c.name));
    if (!nombresEmpleadosContrato.has('fecha_contrato')) {
        await dbRun(`ALTER TABLE empleados ADD COLUMN fecha_contrato TEXT`);
    }
    if (!nombresEmpleadosContrato.has('fecha_vencimiento_contrato')) {
        await dbRun(`ALTER TABLE empleados ADD COLUMN fecha_vencimiento_contrato TEXT`);
    }
    // V35: salario mínimo profesional (CONASAMI) aplicable al puesto del empleado,
    // capturado manualmente — se muestra como referencia en Integración de Salarios.
    if (!nombresEmpleadosContrato.has('salario_minimo_profesional')) {
        await dbRun(`ALTER TABLE empleados ADD COLUMN salario_minimo_profesional REAL`);
    }

    await dbRun(`
        CREATE INDEX IF NOT EXISTS idx_empleados_contrato_vencimiento
        ON empleados(fecha_vencimiento_contrato);

    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS saldos_vacaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            periodo INTEGER NOT NULL,
            dias_generados REAL NOT NULL,
            dias_restantes REAL NOT NULL,
            fecha_disponible TEXT NOT NULL,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
        );
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS isr_tabla_mensual (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ejercicio INTEGER NOT NULL,
            limite_inferior REAL NOT NULL,
            limite_superior REAL,
            cuota_fija REAL NOT NULL DEFAULT 0,
            porcentaje_excedente REAL NOT NULL DEFAULT 0,
            fuente TEXT,
            hoja TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS solicitudes_vacaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            fecha_inicio TEXT NOT NULL,
            fecha_fin TEXT NOT NULL,
            dias_solicitados REAL NOT NULL,
            estado TEXT DEFAULT 'Aprobada',
            observaciones TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
        );
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS movimientos_vacaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            tipo_movimiento TEXT NOT NULL,
            dias REAL NOT NULL,
            fecha_movimiento TEXT NOT NULL,
            monto_pagado REAL DEFAULT 0,
            observaciones TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
        );
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS detalle_movimientos_saldo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            movimiento_id INTEGER,
            solicitud_id INTEGER,
            saldo_id INTEGER NOT NULL,
            dias_descontados REAL NOT NULL,
            FOREIGN KEY (movimiento_id) REFERENCES movimientos_vacaciones(id) ON DELETE CASCADE,
            FOREIGN KEY (solicitud_id) REFERENCES solicitudes_vacaciones(id) ON DELETE CASCADE,
            FOREIGN KEY (saldo_id) REFERENCES saldos_vacaciones(id) ON DELETE CASCADE
        );
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS incidencias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            tipo_incidencia TEXT NOT NULL,
            fecha_inicio TEXT NOT NULL,
            fecha_fin TEXT NOT NULL,
            dias REAL NOT NULL,
            observaciones TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
        );
    `);

    // Migración de incidencias: folio, cancelación y días efectivamente descontados.
    const columnasIncidencias = await dbAll(`PRAGMA table_info(incidencias)`);
    const nombresIncidencias = new Set(columnasIncidencias.map(c => c.name));
    if (!nombresIncidencias.has('folio')) await dbRun(`ALTER TABLE incidencias ADD COLUMN folio TEXT`);
    if (!nombresIncidencias.has('cancelada')) await dbRun(`ALTER TABLE incidencias ADD COLUMN cancelada INTEGER DEFAULT 0`);
    if (!nombresIncidencias.has('cancelada_en')) await dbRun(`ALTER TABLE incidencias ADD COLUMN cancelada_en TEXT`);
    if (!nombresIncidencias.has('dias_descontados')) await dbRun(`ALTER TABLE incidencias ADD COLUMN dias_descontados REAL DEFAULT 0`);
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incidencias_folio ON incidencias(folio) WHERE folio IS NOT NULL`);
    const incidenciasSinFolio = await dbAll(`SELECT id FROM incidencias WHERE folio IS NULL OR TRIM(folio)=''`);
    for (const inc of incidenciasSinFolio) await dbRun(`UPDATE incidencias SET folio=? WHERE id=?`, [`INC-HIST-${String(inc.id).padStart(6,'0')}`, inc.id]);

    // V-fix: vínculo directo incidencia -> movimiento_vacaciones. Antes se buscaba
    // el movimiento con "observaciones LIKE '%Incidencia N%'", lo que también
    // coincidía con "Incidencia N0", "Incidencia N9", etc. Con 10+ incidencias por
    // empleado eso podía revertir el movimiento equivocado al cancelar. Se guarda
    // el id real desde el alta y se usa ese vínculo, no texto libre.
    if (!nombresIncidencias.has('movimiento_id')) {
        await dbRun(`ALTER TABLE incidencias ADD COLUMN movimiento_id INTEGER`);
        const incidenciasSinVinculo = await dbAll(`SELECT id, empleado_id FROM incidencias WHERE movimiento_id IS NULL`);
        for (const inc of incidenciasSinVinculo) {
            // Backfill con coincidencia anclada (no un simple "%...%") para no repetir
            // la misma colisión que se está corrigiendo, solo para los datos históricos.
            const mov = await dbGet(
                `SELECT id FROM movimientos_vacaciones WHERE empleado_id=? AND tipo_movimiento='INCIDENCIA' AND (observaciones = ? OR observaciones LIKE ?) ORDER BY id DESC LIMIT 1`,
                [inc.empleado_id, `Incidencia ${inc.id}`, `Incidencia ${inc.id} ·%`]
            );
            if (mov) await dbRun(`UPDATE incidencias SET movimiento_id=? WHERE id=?`, [mov.id, inc.id]);
        }
    }

    await dbRun(`
        CREATE TABLE IF NOT EXISTS finiquitos_liquidaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            tipo_baja TEXT NOT NULL,
            fecha_baja TEXT NOT NULL,
            salario_diario REAL NOT NULL,
            dias_trabajados_periodo REAL DEFAULT 0,
            monto_dias_trabajados REAL DEFAULT 0,
            monto_aguinaldo_proporcional REAL DEFAULT 0,
            monto_vacaciones_proporcional REAL DEFAULT 0,
            monto_prima_vacacional REAL DEFAULT 0,
            monto_indemnizacion REAL DEFAULT 0,
            monto_veinte_dias_ano REAL DEFAULT 0,
            monto_prima_antiguedad REAL DEFAULT 0,
            total_pagar REAL NOT NULL,
            observaciones TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE RESTRICT
        );


    `);

    // V23: campos adicionales para conservar el desglose fiscal/real del Excel.
    const columnasFiniquitoV23 = await dbAll(`PRAGMA table_info(finiquitos_liquidaciones)`);
    const nombresFiniquitoV23 = columnasFiniquitoV23.map(c => c.name);
    const agregarColumnaFiniquitoV23 = async (nombre, tipo) => {
        if (!nombresFiniquitoV23.includes(nombre)) {
            await dbRun(`ALTER TABLE finiquitos_liquidaciones ADD COLUMN ${nombre} ${tipo}`);
        }
    };
    await agregarColumnaFiniquitoV23('salario_fiscal', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('salario_real', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('isr_retenido', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('monto_sueldo_pendiente', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('total_fiscal_bruto', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('total_real_bruto', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('total_fiscal_neto', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('total_real_neto', 'REAL DEFAULT 0')
    await agregarColumnaFiniquitoV23('remanente_vacaciones', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('parte_exenta', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('parte_gravada', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('indemnizacion_90_incluida', 'INTEGER DEFAULT 0');
    await agregarColumnaFiniquitoV23('porcentaje_prima_antiguedad', 'REAL DEFAULT 100');
;
    await agregarColumnaFiniquitoV23('dias_vacaciones', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('anios_antiguedad', 'REAL DEFAULT 0');
    await agregarColumnaFiniquitoV23('incluir_prima_antiguedad', 'INTEGER DEFAULT 1');
    await agregarColumnaFiniquitoV23('hash_sha256', 'TEXT');


    await dbRun(`CREATE TABLE IF NOT EXISTS configuracion_sistema (clave TEXT PRIMARY KEY, valor TEXT);`);
    await dbRun(`CREATE TABLE IF NOT EXISTS usuarios_admin (id INTEGER PRIMARY KEY CHECK (id=1), usuario TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, debe_cambiar_password INTEGER DEFAULT 1, ultimo_acceso TEXT);`);
    await dbRun(`CREATE TABLE IF NOT EXISTS auditoria (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT DEFAULT CURRENT_TIMESTAMP, usuario TEXT NOT NULL, accion TEXT NOT NULL, modulo TEXT, detalle TEXT);`);
    const admin = await dbGet(`SELECT id FROM usuarios_admin WHERE id=1`);
    if (!admin) { const salt=crypto.randomBytes(16).toString('hex'); const hash=crypto.pbkdf2Sync('Admin123!',salt,120000,64,'sha512').toString('hex'); await dbRun(`INSERT INTO usuarios_admin (id,usuario,password_hash,salt,debe_cambiar_password) VALUES (1,?,?,?,1)`,['admin',hash,salt]); }


    // V22: actualizar el nombre legal de la primera empresa en bases existentes.
    await dbRun(`UPDATE empresas SET nombre = 'EYASA S DE RL DE CV' WHERE nombre = 'EYASA'`);

    // Migraciones compatibles con bases existentes
    const columnasEmpleados = await dbAll(`PRAGMA table_info(empleados)`);
    const nombresColumnas = new Set(columnasEmpleados.map(c => c.name));
    if (!nombresColumnas.has('edad')) {
        await dbRun(`ALTER TABLE empleados ADD COLUMN edad INTEGER`);
    }

    // Normalizar identificadores vacíos para permitir índices únicos parciales.
    await dbRun(`UPDATE empleados SET rfc = NULL WHERE TRIM(COALESCE(rfc,'')) = ''`);
    await dbRun(`UPDATE empleados SET nss = NULL WHERE TRIM(COALESCE(nss,'')) = ''`);

    try { await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_empleados_num_empresa_no_vacio ON empleados (empresa_id, UPPER(TRIM(num_empleado))) WHERE num_empleado IS NOT NULL AND TRIM(num_empleado) <> ''`); } catch (e) { console.warn('No se pudo crear índice único de número de empleado por duplicados históricos:', e.message); }

    // ==========================================
    // Cifrado por campo de RFC/NSS/CURP (expediente digital)
    // ==========================================
    // rfc/nss/curp dejan de guardarse en claro: se guarda su valor cifrado
    // (AES-256-GCM, IV aleatorio por valor) en *_enc, y para RFC/NSS además una
    // huella determinística (HMAC-SHA256) en *_idx que permite seguir
    // detectando duplicados y hacer búsquedas exactas sin exponer el valor real.
    if (!nombresColumnas.has('rfc_enc')) await dbRun(`ALTER TABLE empleados ADD COLUMN rfc_enc TEXT`);
    if (!nombresColumnas.has('rfc_idx')) await dbRun(`ALTER TABLE empleados ADD COLUMN rfc_idx TEXT`);
    if (!nombresColumnas.has('nss_enc')) await dbRun(`ALTER TABLE empleados ADD COLUMN nss_enc TEXT`);
    if (!nombresColumnas.has('nss_idx')) await dbRun(`ALTER TABLE empleados ADD COLUMN nss_idx TEXT`);
    if (!nombresColumnas.has('curp_enc')) await dbRun(`ALTER TABLE empleados ADD COLUMN curp_enc TEXT`);

    try { await dbRun(`DROP INDEX IF EXISTS ux_empleados_rfc_no_vacio`); } catch (_) {}
    try { await dbRun(`DROP INDEX IF EXISTS ux_empleados_nss_no_vacio`); } catch (_) {}

    // Migración única: cifra cualquier RFC/NSS/CURP que siga en claro (bases
    // creadas antes de este refuerzo) y limpia la columna original.
    const pendientesCifrado = await dbAll(`SELECT id, rfc, nss, curp FROM empleados WHERE (rfc IS NOT NULL AND TRIM(rfc) <> '') OR (nss IS NOT NULL AND TRIM(nss) <> '') OR (curp IS NOT NULL AND TRIM(curp) <> '')`);
    if (pendientesCifrado.length) {
        for (const fila of pendientesCifrado) {
            const rfcNorm = fila.rfc ? String(fila.rfc).trim().toUpperCase() : null;
            const nssNorm = fila.nss ? String(fila.nss).trim() : null;
            await dbRun(
                `UPDATE empleados SET rfc = NULL, rfc_enc = ?, rfc_idx = ?, nss = NULL, nss_enc = ?, nss_idx = ?, curp = NULL, curp_enc = ? WHERE id = ?`,
                [
                    rfcNorm ? cifrarCampoSensible(rfcNorm) : null,
                    rfcNorm ? indiceCiegoCampo(rfcNorm) : null,
                    nssNorm ? cifrarCampoSensible(nssNorm) : null,
                    nssNorm ? indiceCiegoCampo(nssNorm) : null,
                    fila.curp && String(fila.curp).trim() ? cifrarCampoSensible(String(fila.curp).trim().toUpperCase()) : null,
                    fila.id
                ]
            );
        }
        console.log(`Cifrado de expediente: ${pendientesCifrado.length} registro(s) de RFC/NSS/CURP migrado(s).`);
    }

    // Evita nuevos duplicados de RFC/NSS mediante su huella (no el valor cifrado,
    // que es distinto cada vez aunque el RFC/NSS real sea el mismo).
    try { await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_empleados_rfc_idx ON empleados (rfc_idx) WHERE rfc_idx IS NOT NULL`); } catch (e) { console.warn('No se pudo crear índice único de RFC cifrado por duplicados históricos:', e.message); }
    try { await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_empleados_nss_idx ON empleados (nss_idx) WHERE nss_idx IS NOT NULL`); } catch (e) { console.warn('No se pudo crear índice único de NSS cifrado por duplicados históricos:', e.message); }

    // Logotipo por empresa: usado en reportes/PDF; si una empresa no tiene uno propio
    // se usa el logotipo de la aplicación (logo.png) como valor por defecto.
    const columnasEmpresas = await dbAll(`PRAGMA table_info(empresas)`);
    const nombresColumnasEmpresas = new Set(columnasEmpresas.map(c => c.name));
    if (!nombresColumnasEmpresas.has('logo_path')) {
        await dbRun(`ALTER TABLE empresas ADD COLUMN logo_path TEXT`);
    }

    // Fecha de nacimiento: habilita las alertas de cumpleaños del panorama laboral
    // y se muestra/exporta junto con el resto de la ficha del empleado.
    if (!nombresColumnas.has('fecha_nacimiento')) {
        await dbRun(`ALTER TABLE empleados ADD COLUMN fecha_nacimiento TEXT`);
    }

    // Expediente digital: documentos adjuntos por empleado (INE, acta, comprobante
    // de domicilio, contrato firmado, etc.). El archivo se copia cifrado (AES-256-GCM)
    // a userData/expedientes — no se referencia la ubicación original del usuario.
    await dbRun(`
        CREATE TABLE IF NOT EXISTS documentos_empleado (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empleado_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            nombre_original TEXT,
            extension TEXT,
            archivo_cifrado TEXT NOT NULL,
            fecha_subida TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
        );
    `);
    try { await dbRun(`CREATE INDEX IF NOT EXISTS idx_documentos_empleado ON documentos_empleado(empleado_id)`); } catch (_) {}
}

// ==========================================
// 3. LÓGICA DE AUTOMATIZACIÓN Y FIFO VACACIONES
// ==========================================

async function generarSaldosVacacionesSiNoExisten(empleadoId, fechaIngreso, fechaReferencia = null) {
    const fechaIng = normalizarFecha(fechaIngreso);
    if (!fechaIng) return;
    const hoy = normalizarFecha(fechaReferencia) || normalizarFecha(obtenerFechaLocal());
    let aniosCumplidos = hoy.getFullYear() - fechaIng.getFullYear();
    if (hoy.getMonth() < fechaIng.getMonth() ||
        (hoy.getMonth() === fechaIng.getMonth() && hoy.getDate() < fechaIng.getDate())) aniosCumplidos--;

    // V32 FIX: "días disponibles" debe reflejar ÚNICAMENTE el periodo YA CUMPLIDO (actual) y
    // el periodo EN CURSO (vigente, bloqueado hasta el próximo aniversario laboral) — no se
    // acumulan periodos anteriores. Si el empleado lleva menos de 1 año de antigüedad, todavía
    // no existe un periodo disponible: únicamente el periodo 1, en curso y bloqueado.
    const periodos = aniosCumplidos < 1 ? [1] : [aniosCumplidos, aniosCumplidos + 1];

    const existentes = await dbAll(
        `SELECT id, periodo, dias_generados, dias_restantes FROM saldos_vacaciones WHERE empleado_id=? AND periodo IN (${periodos.map(()=>'?').join(',')})`,
        [empleadoId, ...periodos]
    );
    const mapa = new Map(existentes.map(x=>[Number(x.periodo),x]));

    for (const p of periodos) {
        const f=new Date(fechaIng.getFullYear()+p,fechaIng.getMonth(),fechaIng.getDate());
        const fechaDisp=`${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,'0')}-${String(f.getDate()).padStart(2,'0')}`;
        const diasGen=calcularDiasVacacionesLFT(p);
        const ex=mapa.get(p);
        if(!ex){
            await dbRun(`INSERT INTO saldos_vacaciones (empleado_id,periodo,dias_generados,dias_restantes,fecha_disponible) VALUES (?,?,?,?,?)`,
                [empleadoId,p,diasGen,diasGen,fechaDisp]);
        }else{
            const prevGen=Number(ex.dias_generados||diasGen), prevRest=Number(ex.dias_restantes||0);
            const consumidos=Math.max(0,prevGen-prevRest);
            await dbRun(`UPDATE saldos_vacaciones SET dias_generados=?,dias_restantes=?,fecha_disponible=? WHERE id=?`,
                [diasGen,Math.max(0,diasGen-consumidos),fechaDisp,ex.id]);
        }
    }
}

// V31 FIX DEFINITIVO: el módulo de Vacaciones y el módulo de Finiquitos/Liquidaciones
// usaban DOS implementaciones distintas para calcular el saldo disponible, y podían
// divergir entre sí (la de finiquitos llegó a devolver 0.00 en casos donde la de
// vacaciones sí mostraba el remanente correcto). A partir de ahora existe una ÚNICA
// función fuente de verdad (calcularSaldoVacacionesUnificado) y todos los handlers IPC
// (Vacaciones, Finiquitos, Ficha del Empleado) simplemente la invocan, por lo que
// siempre reportan exactamente el mismo número.
// V32 FIX: "días disponibles" ya NO acumula todos los periodos desde el ingreso; solo
// considera el periodo ACTUAL (ya cumplido, liberado) y el periodo VIGENTE (en curso,
// bloqueado hasta el próximo aniversario laboral). Esta es la misma función que usan
// Vacaciones y Finiquitos/Liquidaciones, así que ambos módulos siempre muestran
// exactamente el mismo número, calculado en vivo (otorgar vacaciones, pagar días,
// descontar por falta o registrar una incidencia se refleja de inmediato porque el
// consumo se recalcula contra detalle_movimientos_saldo en cada consulta).
// Declarada a nivel de módulo (no anidada dentro de registrarHandlersIPC) porque
// handlers como perfil:exportar-pdf se registran fuera de esa función y también
// necesitan esta misma fuente de verdad.
async function calcularSaldoVacacionesUnificado(empleadoId, fechaConsulta) {
    const fecha = fechaConsulta || obtenerFechaLocal();
    const empleado = await dbGet(`SELECT fecha_ingreso FROM empleados WHERE id = ?`, [empleadoId]);
    if (!empleado) return { totalUsable: 0, totalBloqueado: 0, liberados: [], bloqueados: [] };

    // Genera/asegura ÚNICAMENTE el periodo actual y el vigente (ver función).
    await generarSaldosVacacionesSiNoExisten(empleadoId, empleado.fecha_ingreso, fecha);

    const fechaIng = normalizarFecha(empleado.fecha_ingreso);
    const fechaConsultaReal = normalizarFecha(fecha) || normalizarFecha(obtenerFechaLocal());
    if (!fechaIng || !fechaConsultaReal) return { totalUsable: 0, totalBloqueado: 0, liberados: [], bloqueados: [] };

    // V-fix: antes solo se leían el periodo actual y el siguiente. Eso podía
    // dejar fuera del saldo MOSTRADO periodos más antiguos con días pendientes
    // (típico en migraciones desde Excel), aunque descontarSaldosFIFO sí los
    // consume primero (FIFO real). Ahora se leen TODOS los periodos del
    // empleado y el mismo criterio fecha_disponible<=fechaConsultaReal (más
    // abajo, liberados/bloqueados) decide cuáles ya están disponibles — el
    // mismo criterio que usa descontarSaldosFIFO, para que lo que se muestra
    // y lo que realmente se descuenta sean siempre el mismo número.
    const saldos = await dbAll(`
        SELECT sv.id, sv.periodo, sv.dias_generados, sv.dias_restantes, sv.fecha_disponible
        FROM saldos_vacaciones sv
        WHERE sv.empleado_id = ?
        ORDER BY sv.periodo ASC
    `, [empleadoId]);

    const conDatos = [];
    for (const s of saldos) {
        const f = normalizarFecha(s.fecha_disponible);
        if (!f) continue;
        const consumos = await dbGet(`
            SELECT COALESCE(SUM(dias_descontados),0) AS consumidos
            FROM detalle_movimientos_saldo dms
            WHERE dms.saldo_id = ?
        `, [s.id]);
        const generados = Math.max(0, Number(s.dias_generados || 0));
        const consumidosPorMovimiento = Math.max(0, Number(consumos?.consumidos || 0));

        // FUENTE ÚNICA DEL SALDO REAL PARA FINIQUITOS:
        // periodo liberado (dias_generados) - días efectivamente descontados.
        // NO se usa dias_restantes como fuente de verdad porque puede quedar
        // desincronizado en registros históricos y marcar 0 aunque el periodo
        // esté íntegramente disponible (12, 14, 16, etc.).
        const diasRestantes = Math.max(0, generados - consumidosPorMovimiento);

        if (diasRestantes <= 0) continue;
        conDatos.push({
            ...s,
            dias_restantes: diasRestantes,
            dias_disponibles: diasRestantes,
            dias_consumidos: consumidosPorMovimiento,
            _fecha: f
        });
    }

    const liberados = conDatos.filter(x => x._fecha <= fechaConsultaReal);
    const bloqueados = conDatos.filter(x => x._fecha > fechaConsultaReal);
    const totalUsable = liberados.reduce((acc, curr) => acc + Number(curr.dias_restantes || 0), 0);
    const totalBloqueado = bloqueados.reduce((acc, curr) => acc + Number(curr.dias_restantes || 0), 0);

    return { totalUsable, totalBloqueado, liberados, bloqueados };
}

async function descontarSaldosFIFO({ empleadoId, diasADescontar, fechaReferencia, solicitudId = null, movimientoId = null }) {
    const saldos = await dbAll(`
        SELECT id, periodo, dias_restantes 
        FROM saldos_vacaciones 
        WHERE empleado_id = ? 
          AND dias_restantes > 0
          AND fecha_disponible <= ?
        ORDER BY periodo ASC
    `, [empleadoId, fechaReferencia]);

    const totalDisponible = saldos.reduce((acc, curr) => acc + curr.dias_restantes, 0);

    if (totalDisponible < diasADescontar) {
        throw new Error(
            `Días insuficientes. El empleado cuenta con ${totalDisponible} día(s) liberado(s) ` +
            `a la fecha ${fechaReferencia}.`
        );
    }

    let pendientes = diasADescontar;

    for (const saldo of saldos) {
        if (pendientes === 0) break;

        let aDescontar = Math.min(saldo.dias_restantes, pendientes);

        await dbRun(`
            UPDATE saldos_vacaciones 
            SET dias_restantes = dias_restantes - ? 
            WHERE id = ?
        `, [aDescontar, saldo.id]);

        await dbRun(`
            INSERT INTO detalle_movimientos_saldo (movimiento_id, solicitud_id, saldo_id, dias_descontados)
            VALUES (?, ?, ?, ?)
        `, [movimientoId, solicitudId, saldo.id, aDescontar]);

        pendientes -= aDescontar;
    }

    return true;
}

// ==========================================
// LOGOTIPOS POR EMPRESA (reportes / PDF)
// ==========================================
const LOGO_APP_DEFAULT = path.join(__dirname, 'logo.png');
const EXTENSIONES_LOGO_VALIDAS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function mimeParaExtensionLogo(ext) {
    switch (ext) {
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        default: return 'image/png';
    }
}

function archivoAImagenDataUrl(rutaArchivo) {
    try {
        if (!rutaArchivo || !fs.existsSync(rutaArchivo)) return null;
        const ext = path.extname(rutaArchivo).toLowerCase();
        const buffer = fs.readFileSync(rutaArchivo);
        return `data:${mimeParaExtensionLogo(ext)};base64,${buffer.toString('base64')}`;
    } catch (_) {
        return null;
    }
}

// Logotipo efectivo de una empresa para uso en pantalla/reportes: el propio si existe,
// si no el de la aplicación (logo.png) como valor por defecto.
function obtenerLogoDataUrlPorEmpresaId(empresaId) {
    try {
        if (empresaId) {
            const empresa = db.prepare(`SELECT logo_path FROM empresas WHERE id = ?`).get(Number(empresaId));
            if (empresa && empresa.logo_path) {
                const dataUrl = archivoAImagenDataUrl(empresa.logo_path);
                if (dataUrl) return dataUrl;
            }
        }
    } catch (_) { /* se cae al logotipo por defecto */ }
    return archivoAImagenDataUrl(LOGO_APP_DEFAULT);
}

function carpetaLogosEmpresas() {
    const dir = path.join(app.getPath('userData'), 'logos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Copia el archivo seleccionado por el usuario al almacenamiento de la app (userData/logos)
// para no depender de que el archivo original siga existiendo en su ubicación de origen.
function guardarLogoEmpresa(empresaId, rutaOrigen) {
    try {
        if (!rutaOrigen || !fs.existsSync(rutaOrigen)) return null;
        const ext = path.extname(rutaOrigen).toLowerCase();
        if (!EXTENSIONES_LOGO_VALIDAS.has(ext)) return null;
        const destino = path.join(carpetaLogosEmpresas(), `empresa_${empresaId}${ext}`);
        for (const otraExt of EXTENSIONES_LOGO_VALIDAS) {
            const posible = path.join(carpetaLogosEmpresas(), `empresa_${empresaId}${otraExt}`);
            if (posible !== destino && fs.existsSync(posible)) {
                try { fs.unlinkSync(posible); } catch (_) {}
            }
        }
        fs.copyFileSync(rutaOrigen, destino);
        return destino;
    } catch (_) {
        return null;
    }
}

// ==========================================
// 4. HANDLERS IPC
// ==========================================

function hashPassword(password,salt){return crypto.pbkdf2Sync(String(password),salt,120000,64,'sha512').toString('hex');}
async function registrarAuditoria(accion,modulo,detalle=''){try{await dbRun(`INSERT INTO auditoria (usuario,accion,modulo,detalle) VALUES ('admin',?,?,?)`,[accion,modulo,detalle]);}catch(e){console.warn(e.message);}}


    ipcMain.handle('vacaciones:diagnostico-bd', async () => {
        try {
            const tablas = ['empresas','empleados','saldos_vacaciones','solicitudes_vacaciones','movimientos_vacaciones','detalle_movimientos_saldo','incidencias','finiquitos_liquidaciones'];
            const resultado = {};
            for (const tabla of tablas) {
                const row = await dbGet(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tabla]);
                resultado[tabla] = !!row;
            }
            return {ok:true, tablas:resultado};
        } catch(error) { return {ok:false,error:error.message}; }
    });

    ipcMain.handle('perfil:exportar-pdf', async (event,payload={})=>{
        try{
            const empleadoId=Number(payload.empleadoId||payload.id||0);if(!empleadoId)return{ok:false,error:'Seleccione un empleado.'};
            const emp=descifrarCamposEmpleado(await dbGet(`SELECT e.*,em.nombre AS empresa_nombre FROM empleados e LEFT JOIN empresas em ON em.id=e.empresa_id WHERE e.id=?`,[empleadoId]));
            if(!emp)return{ok:false,error:'Empleado no encontrado.'};
            // Misma fuente que Vacaciones/Finiquitos (calcularSaldoVacacionesUnificado),
            // no la columna cruda — evita que este PDF muestre un saldo distinto al
            // que ya ve el usuario en el resto del sistema.
            const saldoVac = await calcularSaldoVacacionesUnificado(empleadoId, obtenerFechaLocal());
            const dias = saldoVac.totalUsable;
            const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
            const nombre=`${emp.nombre||''} ${emp.apellido||''}`.trim();
            const logoDataUrl=obtenerLogoDataUrlPorEmpresaId(emp.empresa_id);

            const documentosAdjuntos = await dbAll(`SELECT * FROM documentos_empleado WHERE empleado_id = ? ORDER BY tipo ASC, fecha_subida ASC`, [empleadoId]);
            const tiposPresentes = new Set(documentosAdjuntos.map(d => d.tipo));
            const filasChecklist = Object.entries(CATALOGO_TIPOS_DOCUMENTO).map(([clave,etiqueta])=>{
                const presente = tiposPresentes.has(clave);
                const obligatorio = DOCUMENTOS_REQUERIDOS_EXPEDIENTE.includes(clave);
                return `<div class="item"><span class="label">${esc(etiqueta)}${obligatorio?' *':''}</span><span class="value" style="color:${presente?'#0f766e':'#b91c1c'}">${presente?'Adjunto':'Faltante'}</span></div>`;
            }).join('');

            const doc=`<!doctype html><html><head><meta charset="UTF-8"><style>body{font-family:Segoe UI,Arial,sans-serif;color:#172033;padding:28px}h1{margin:0 0 4px;font-size:24px}h2{font-size:16px;margin:24px 0 10px;border-bottom:2px solid #dbe3ee;padding-bottom:6px}.muted{color:#64748b}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.item{border:1px solid #dbe3ee;border-radius:8px;padding:10px}.label{display:block;color:#64748b;font-size:11px;text-transform:uppercase}.value{font-weight:600;margin-top:4px}.doc-header{display:flex;align-items:center;gap:14px;margin-bottom:10px}.doc-header img{width:56px;height:56px;object-fit:contain}.nota{color:#94a3b8;font-size:10px;margin-top:6px}</style></head><body><div class="doc-header">${logoDataUrl?`<img src="${logoDataUrl}" alt="Logotipo">`:''}<div><h1>Ficha profesional del empleado</h1><div class="muted">${esc(nombre)} · ${esc(obtenerFechaLocal())}</div></div></div><h2>Identificación</h2><div class="grid"><div class="item"><span class="label">Número de empleado</span><span class="value">${esc(emp.num_empleado)}</span></div><div class="item"><span class="label">Empresa</span><span class="value">${esc(emp.empresa_nombre)}</span></div><div class="item"><span class="label">Fecha de nacimiento</span><span class="value">${esc(emp.fecha_nacimiento||'No capturada')}</span></div><div class="item"><span class="label">Edad</span><span class="value">${emp.edad!==null&&emp.edad!==''?esc(emp.edad)+' años':'No capturada'}</span></div><div class="item"><span class="label">RFC</span><span class="value">${esc(emp.rfc||'No capturado')}</span></div><div class="item"><span class="label">NSS</span><span class="value">${esc(emp.nss||'No capturado')}</span></div><div class="item"><span class="label">CURP</span><span class="value">${esc(emp.curp||'No capturada')}</span></div></div><h2>Información laboral</h2><div class="grid"><div class="item"><span class="label">Puesto</span><span class="value">${esc(emp.puesto||'Sin puesto')}</span></div><div class="item"><span class="label">Fecha de ingreso</span><span class="value">${esc(emp.fecha_ingreso)}</span></div><div class="item"><span class="label">Salario diario</span><span class="value">$${Number(emp.salario_diario||0).toFixed(2)}</span></div><div class="item"><span class="label">SBC</span><span class="value">$${Number(emp.salario_base||0).toFixed(2)}</span></div><div class="item"><span class="label">Estatus</span><span class="value">${Number(emp.activo)===1?'Activo':('Inactivo'+(emp.fecha_baja?' desde '+esc(emp.fecha_baja):''))}</span></div><div class="item"><span class="label">Vacaciones disponibles</span><span class="value">${dias} día(s)</span></div></div><h2>Contrato</h2><div class="grid"><div class="item"><span class="label">Fecha de firma de contrato</span><span class="value">${esc(emp.fecha_contrato||'No capturada')}</span></div><div class="item"><span class="label">Vencimiento de contrato</span><span class="value">${esc(emp.fecha_vencimiento_contrato||'No aplica / indefinido')}</span></div><div class="item" style="grid-column:1/-1;"><span class="label">Contrato PDF</span><span class="value">${esc(emp.ruta_contrato_pdf||'No asociado')}</span></div></div><h2>Documentos del expediente</h2><div class="grid">${filasChecklist}</div><div class="nota">* Documento considerado obligatorio para el expediente. Los documentos adjuntos se incluyen a continuación de esta ficha.</div></body></html>`;
            const save=await dialog.showSaveDialog(mainWindow,{title:'Exportar ficha del empleado a PDF',defaultPath:`Ficha_${String(emp.num_empleado||emp.id).replace(/[^a-zA-Z0-9_-]/g,'_')}.pdf`,filters:[{name:'PDF',extensions:['pdf']}]});
            if(save.canceled||!save.filePath)return{ok:false,cancelado:true};
            const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
            await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(doc));
            const pdf=await win.webContents.printToPDF({printBackground:true,margins:{marginType:'default'}});
            win.destroy();

            // Fusiona la ficha con cada documento adjunto (PDF o imagen) en un solo
            // archivo final, con una página separadora antes de cada documento.
            const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
            const documentoFinal = await PDFDocument.create();
            const fichaCargada = await PDFDocument.load(pdf);
            (await documentoFinal.copyPages(fichaCargada, fichaCargada.getPageIndices())).forEach(p => documentoFinal.addPage(p));

            if (documentosAdjuntos.length) {
                const fuente = await documentoFinal.embedFont(StandardFonts.HelveticaBold);
                for (const docAdj of documentosAdjuntos) {
                    try {
                        const rutaCifrada = path.join(carpetaExpedienteEmpleado(empleadoId), docAdj.archivo_cifrado);
                        if (!fs.existsSync(rutaCifrada)) continue;
                        const bufferPlano = descifrarBufferArchivo(fs.readFileSync(rutaCifrada));

                        const separadora = documentoFinal.addPage([612, 792]);
                        separadora.drawText(CATALOGO_TIPOS_DOCUMENTO[docAdj.tipo] || docAdj.tipo, { x: 50, y: 700, size: 20, font: fuente, color: rgb(0.06,0.46,0.43) });
                        separadora.drawText(docAdj.nombre_original || '', { x: 50, y: 672, size: 11, color: rgb(0.4,0.46,0.55) });

                        const ext = String(docAdj.extension || '').toLowerCase();
                        if (ext === 'pdf') {
                            const cargado = await PDFDocument.load(bufferPlano);
                            (await documentoFinal.copyPages(cargado, cargado.getPageIndices())).forEach(p => documentoFinal.addPage(p));
                        } else if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
                            const imagen = ext === 'png' ? await documentoFinal.embedPng(bufferPlano) : await documentoFinal.embedJpg(bufferPlano);
                            const pagina = documentoFinal.addPage([imagen.width, imagen.height]);
                            pagina.drawImage(imagen, { x: 0, y: 0, width: imagen.width, height: imagen.height });
                        }
                    } catch (errDoc) {
                        console.warn('No se pudo incluir un documento del expediente en el PDF:', errDoc.message);
                    }
                }
            }

            fs.writeFileSync(save.filePath, await documentoFinal.save());
            return{ok:true,filePath:save.filePath};
        }catch(error){return{ok:false,error:error.message};}
    });

function registrarHandlersIPC() {
    ipcMain.handle('auth:login', async (event, d={}) => { try { const a=await dbGet(`SELECT * FROM usuarios_admin WHERE id=1`); const u=String(d.usuario||'').trim(); const pw=String(d.password||''); if(!a||u!==a.usuario||hashPassword(pw,a.salt)!==a.password_hash)return {ok:false,error:'Usuario o contraseña incorrectos.'}; await dbRun(`UPDATE usuarios_admin SET ultimo_acceso=CURRENT_TIMESTAMP WHERE id=1`); await registrarAuditoria('Inicio de sesión','Seguridad','Acceso correcto'); sesionIniciada = true; return {ok:true,usuario:a.usuario,debeCambiarPassword:!!a.debe_cambiar_password}; }catch(error){return {ok:false,error:error.message};} });
    ipcMain.handle('auth:cambiar-password', async (event,d={}) => { try { const a=await dbGet(`SELECT * FROM usuarios_admin WHERE id=1`); const actual=String(d.actual||''),nueva=String(d.nueva||''); if(nueva.length<8)return {ok:false,error:'La nueva contraseña debe tener al menos 8 caracteres.'}; if(!a||hashPassword(actual,a.salt)!==a.password_hash)return {ok:false,error:'La contraseña actual no es correcta.'}; const salt=crypto.randomBytes(16).toString('hex'); const hash=hashPassword(nueva,salt); await dbRun(`UPDATE usuarios_admin SET password_hash=?,salt=?,debe_cambiar_password=0 WHERE id=1`,[hash,salt]); await registrarAuditoria('Cambio de contraseña','Seguridad','Contraseña actualizada'); return {ok:true}; }catch(error){return {ok:false,error:error.message};} });
    ipcMain.handle('dashboard:resumen', async (event, empresaId) => {
        try {
            const w = empresaId ? 'WHERE e.empresa_id=? AND e.activo=1' : 'WHERE e.activo=1';
            const p = empresaId ? [empresaId] : [];
            const a = await dbGet(`SELECT COUNT(*) total FROM empleados e ${w}`, p);
            const b = await dbGet(`SELECT ROUND(IFNULL(SUM(s.dias_restantes),0),1) total FROM saldos_vacaciones s JOIN empleados e ON e.id=s.empleado_id ${w} AND s.fecha_disponible<=?`, [...p, obtenerFechaLocal()]);
            const c = await dbGet(`SELECT ROUND(IFNULL(SUM(s2.dias_solicitados),0),1) total FROM solicitudes_vacaciones s2 JOIN empleados e ON e.id=s2.empleado_id ${w} AND (s2.estado IS NULL OR s2.estado != 'Cancelada')`, p);
            const d = await dbGet(`SELECT COUNT(*) total FROM solicitudes_vacaciones s JOIN empleados e ON e.id=s.empleado_id ${w} AND s.estado='Pendiente'`, p);
            // Sin LIMIT: el renderer calcula la fecha más cercana (aniversario o
            // cumpleaños) de cada empleado y ordena por cercanía — limitarlo aquí
            // por fecha_ingreso dejaba fuera a empleados nuevos con cumpleaños o
            // aniversario próximos.
            const proximos = await dbAll(`SELECT e.id,e.nombre,e.apellido,e.num_empleado,e.fecha_ingreso,e.fecha_nacimiento FROM empleados e ${w} ORDER BY e.fecha_ingreso ASC`, p);

            // Expedientes incompletos: empleados activos a los que les falta al menos
            // uno de los documentos considerados obligatorios para el expediente.
            const tiposRequeridos = DOCUMENTOS_REQUERIDOS_EXPEDIENTE;
            const filasDocumentos = await dbAll(`
                SELECT e.id, e.nombre, e.apellido,
                    (SELECT COUNT(DISTINCT d.tipo) FROM documentos_empleado d WHERE d.empleado_id = e.id AND d.tipo IN (${tiposRequeridos.map(() => '?').join(',')})) AS tipos_presentes
                FROM empleados e ${w}
            `, [...p, ...tiposRequeridos]);
            const expedientesIncompletos = filasDocumentos.filter(f => Number(f.tipos_presentes || 0) < tiposRequeridos.length).length;

            return { ok: true, data: { empleados: a.total || 0, diasDisponibles: b.total || 0, diasOtorgados: c.total || 0, pendientes: d.total || 0, proximos, expedientesIncompletos } };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
    // V35 - admite filtro opcional por rango de fechas (día/semana/mes/personalizado
    // desde el panel de Administración). Sin rango se conserva el comportamiento previo
    // (últimos 200 movimientos) para no afectar a otras pantallas que ya usan este canal
    // (p.ej. el historial de CONTPAQi).
    ipcMain.handle('auditoria:listar', async (event, payload = {}) => {
        try {
            const fechaInicio = String((payload && payload.fechaInicio) || '').trim();
            const fechaFin = String((payload && payload.fechaFin) || '').trim();
            const where = [];
            const params = [];
            if (fechaInicio) { where.push('date(fecha) >= date(?)'); params.push(fechaInicio); }
            if (fechaFin) { where.push('date(fecha) <= date(?)'); params.push(fechaFin); }
            const limite = (fechaInicio || fechaFin) ? 5000 : 200;
            const data = await dbAll(`SELECT * FROM auditoria ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limite}`, params);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // V35 - Exporta la bitácora de auditoría a un PDF con membrete (logotipo del
    // sistema, igual criterio que reportes:guardar-pdf) para un rango de fechas dado
    // (día/semana/mes o personalizado, según lo arme el panel de Administración).
    ipcMain.handle('auditoria:exportar-pdf', async (event, payload = {}) => {
        let win = null;
        try {
            const fechaInicio = String((payload && payload.fechaInicio) || '').trim();
            const fechaFin = String((payload && payload.fechaFin) || '').trim();
            const etiquetaRango = String((payload && payload.etiquetaRango) || '').trim() || 'Personalizado';
            if (!fechaInicio || !fechaFin) {
                return { ok: false, error: 'Indica un rango de fechas (desde y hasta) antes de exportar.' };
            }

            const movimientos = await dbAll(
                `SELECT * FROM auditoria WHERE date(fecha) BETWEEN date(?) AND date(?) ORDER BY fecha ASC, id ASC`,
                [fechaInicio, fechaFin]
            );

            const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
                title: 'Guardar bitácora de auditoría en PDF',
                defaultPath: `Bitacora_Auditoria_${fechaInicio}_a_${fechaFin}.pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }]
            });
            if (canceled || !filePath) return { ok: false, cancelado: true };

            const logoDataUrl = obtenerLogoDataUrlPorEmpresaId(null);
            const generadoEl = new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
            const filasHtml = movimientos.map((m, i) => `
                <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
                    <td>${escaparHtmlPdf(m.fecha || '')}</td>
                    <td>${escaparHtmlPdf(m.usuario || '')}</td>
                    <td>${escaparHtmlPdf(m.accion || '')}</td>
                    <td>${escaparHtmlPdf(m.modulo || '')}</td>
                    <td>${escaparHtmlPdf(m.detalle || '')}</td>
                </tr>
            `).join('') || `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:18px;">Sin movimientos registrados en el rango seleccionado.</td></tr>`;

            const html = `<!doctype html><html><head><meta charset="utf-8"><style>
                body{font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;padding:32px;}
                .encabezado{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #0f766e;padding-bottom:14px;margin-bottom:18px;}
                .encabezado img{width:58px;height:58px;object-fit:contain;}
                .encabezado h1{font-size:20px;margin:0;color:#0f172a;}
                .encabezado p{margin:2px 0 0;font-size:12px;color:#64748b;}
                .meta{display:flex;justify-content:space-between;font-size:12px;color:#475569;margin-bottom:16px;flex-wrap:wrap;gap:6px;}
                .meta strong{color:#0f172a;}
                table{width:100%;border-collapse:collapse;font-size:11px;}
                th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;}
                th{background:#0f766e;color:#ffffff;font-weight:600;}
                tfoot td{border:none;padding-top:14px;font-size:10px;color:#94a3b8;text-align:center;}
            </style></head><body>
                <div class="encabezado">
                    <div>
                        <h1>Bitácora de Auditoría</h1>
                        <p>Sistema de Vacaciones · RRHH Control</p>
                    </div>
                    ${logoDataUrl ? `<img src="${logoDataUrl}" alt="Logotipo">` : ''}
                </div>
                <div class="meta">
                    <span>Rango: <strong>${escaparHtmlPdf(etiquetaRango)}</strong> (${escaparHtmlPdf(fechaInicio)} a ${escaparHtmlPdf(fechaFin)})</span>
                    <span>Movimientos: <strong>${movimientos.length}</strong></span>
                    <span>Generado el ${escaparHtmlPdf(generadoEl)}</span>
                </div>
                <table>
                    <thead><tr><th style="width:15%;">Fecha</th><th style="width:10%;">Usuario</th><th style="width:18%;">Acción</th><th style="width:15%;">Módulo</th><th>Detalle</th></tr></thead>
                    <tbody>${filasHtml}</tbody>
                    <tfoot><tr><td colspan="5">Documento generado automáticamente por el Sistema de Vacaciones — uso interno.</td></tr></tfoot>
                </table>
            </body></html>`;

            win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
            await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
            const pdf = await win.webContents.printToPDF({ printBackground: true, landscape: true });
            fs.writeFileSync(filePath, pdf);
            await registrarAuditoria('Exportación de bitácora', 'Auditoría', `${etiquetaRango} · ${fechaInicio} a ${fechaFin} · ${movimientos.length} movimiento(s) · ${filePath}`);
            return { ok: true, filePath };
        } catch (error) {
            return { ok: false, error: error.message };
        } finally {
            if (win && !win.isDestroyed()) win.close();
        }
    });
    ipcMain.handle('backup:crear',async()=>{try{const d=await dialog.showSaveDialog(mainWindow,{title:'Guardar respaldo de la base de datos',defaultPath:`RRHH_Control_backup_${new Date().toISOString().slice(0,10)}.db`,filters:[{name:'SQLite',extensions:['db']}]});if(d.canceled||!d.filePath)return {ok:false,cancelado:true};db.pragma('wal_checkpoint(TRUNCATE)');fs.copyFileSync(dbPath,d.filePath);await registrarAuditoria('Respaldo creado','Administración',d.filePath);return {ok:true,path:d.filePath};}catch(error){return {ok:false,error:error.message};}});
    ipcMain.handle('reportes:calendario-vacaciones',async(event,payload={})=>{try{const p=[];let w='';if(payload.empresaId){w='AND e.empresa_id=?';p.push(payload.empresaId);}const data=await dbAll(`SELECT s.id,s.empleado_id,s.fecha_inicio,s.fecha_fin,s.dias_solicitados,s.estado,e.nombre,e.apellido,e.num_empleado FROM solicitudes_vacaciones s JOIN empleados e ON e.id=s.empleado_id WHERE 1=1 ${w} ORDER BY s.fecha_inicio DESC`,p);return {ok:true,data};}catch(error){return {ok:false,error:error.message};}});


    // --- CARGA MASIVA DE EMPLEADOS (EXCEL) ---
    ipcMain.removeHandler('isr:obtener-tabla-mensual');
    ipcMain.handle('isr:obtener-tabla-mensual', async (event, ejercicio = 2026) => {
        try {
            const rows = await dbAll(`SELECT id, ejercicio, limite_inferior, limite_superior, cuota_fija, porcentaje_excedente, fuente, hoja FROM isr_tabla_mensual WHERE ejercicio=? ORDER BY limite_inferior ASC`, [Number(ejercicio)]);
            return {ok:true, data:rows};
        } catch (error) { return {ok:false,error:error.message,data:[]}; }
    });

    ipcMain.removeHandler('isr:importar-tabla-mensual');
    ipcMain.handle('isr:importar-tabla-mensual', async (event, ejercicio) => {
        try {
            const anio = Number(ejercicio) || new Date().getFullYear();
            const pick = await dialog.showOpenDialog(mainWindow, {
                title:`Importar Tabla ISR ${anio} - Pagos mensuales`,
                filters:[{name:'Excel',extensions:['xlsx','xls']}],
                properties:['openFile']
            });
            if (pick.canceled || !pick.filePaths?.[0]) return {ok:false,cancelado:true};
            const ruta=pick.filePaths[0], wb=XLSX.readFile(ruta,{cellDates:false});
            const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9%]+/g,' ' ).trim();
            const num=v=>{ if(typeof v==='number') return v; const n=Number(String(v??'').replace(/[$,%\s,]/g,'')); return Number.isFinite(n)?n:null; };
            let candidatos=[];
            for(const hoja of wb.SheetNames){
                const sh=wb.Sheets[hoja], matrix=XLSX.utils.sheet_to_json(sh,{header:1,defval:null,raw:false});
                for(let r=0;r<Math.min(matrix.length,25);r++){
                    const headers=(matrix[r]||[]).map(norm);
                    const li=headers.findIndex(x=>x.includes('limite inferior'));
                    const ls=headers.findIndex(x=>x.includes('limite superior'));
                    const cf=headers.findIndex(x=>x.includes('cuota fija'));
                    const pe=headers.findIndex(x=>x.includes('porcentaje')||x.includes('sobre excedente')||x.includes('% sobre'));
                    if(li>=0 && (ls>=0||cf>=0) && pe>=0){ candidatos.push({hoja,matrix,header:r,li,ls,cf,pe}); break; }
                }
            }
            if(!candidatos.length) throw new Error('No se encontró una tabla con las columnas Límite inferior, Límite superior, Cuota fija y Porcentaje sobre excedente.');
            const c=candidatos[0], rows=[];
            for(let r=c.header+1;r<c.matrix.length;r++){
                const row=c.matrix[r]||[];
                const li=num(row[c.li]), ls=c.ls>=0?num(row[c.ls]):null, cf=c.cf>=0?num(row[c.cf]):0, pe=num(row[c.pe]);
                if(li===null || pe===null) continue;
                let porcentaje=pe; if(porcentaje>1) porcentaje/=100;
                rows.push([anio,li,ls,cf,porcentaje,path.basename(ruta),c.hoja]);
            }
            if(!rows.length) throw new Error('La tabla encontrada no contiene renglones numéricos válidos.');
            await dbRun('BEGIN TRANSACTION');
            try {
                await dbRun('DELETE FROM isr_tabla_mensual WHERE ejercicio=?',[anio]);
                for(const row of rows) await dbRun(`INSERT INTO isr_tabla_mensual (ejercicio,limite_inferior,limite_superior,cuota_fija,porcentaje_excedente,fuente,hoja) VALUES (?,?,?,?,?,?,?)`,row);
                await dbRun('COMMIT');
            } catch(e){ await dbRun('ROLLBACK'); throw e; }
            await registrarAuditoria(`Importación Tabla ISR ${anio}`,'Finiquitos y Liquidaciones',`${path.basename(ruta)} / ${c.hoja} / ${rows.length} renglones`);
            return {ok:true,filas:rows.length,hoja:c.hoja,archivo:path.basename(ruta),ejercicio:anio};
        } catch(error){ console.error('[ISR import]',error); return {ok:false,error:error.message}; }
    });

    // Misma lista de alias usada tanto para escanear fechas ambiguas como
    // para procesar cada fila; evita que ambos pasos se desincronicen.
    function extraerFechaRawDeFila(row) {
        return row['Fecha Ingreso'] || row['FECHA_INGRESO'] || row['fecha_ingreso'] || row['Fecha'] || '';
    }

    ipcMain.removeHandler('cargar-empleados-excel');
    ipcMain.handle('cargar-empleados-excel', async (event, payload) => {
        try {
            const p = (payload && typeof payload === 'object') ? payload : { empresaId: payload };
            const empresaId = p.empresaId;
            const formatoFecha = p.formatoFecha || null;

            if (!empresaId) {
                return { ok: false, error: 'Debes seleccionar una empresa antes de cargar el archivo.' };
            }

            let rutaArchivo = p.filePath;
            if (!rutaArchivo) {
                const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                    title: 'Seleccionar archivo de empleados (.xls / .xlsx)',
                    filters: [{ name: 'Hojas de Cálculo', extensions: ['xls', 'xlsx'] }],
                    properties: ['openFile']
                });
                if (canceled || filePaths.length === 0) {
                    return { ok: false, mensaje: 'Carga cancelada.' };
                }
                rutaArchivo = filePaths[0];
            }

            const workbook = XLSX.readFile(rutaArchivo);
            const sheetName = workbook.SheetNames[0];
            const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

            if (rawData.length === 0) {
                return { ok: false, error: 'El archivo Excel está vacío.' };
            }

            // Antes de tocar la BD: si hay fechas de texto genuinamente ambiguas
            // y el usuario todavía no eligió un formato, se detiene aquí y se
            // le pregunta — nunca se adivina una interpretación en silencio.
            if (!formatoFecha) {
                const ejemplos = [];
                for (const row of rawData) {
                    const info = analizarFechaTexto(extraerFechaRawDeFila(row));
                    if (info.tipo === 'ambigua' && !ejemplos.includes(info.texto)) {
                        ejemplos.push(info.texto);
                        if (ejemplos.length >= 3) break;
                    }
                }
                if (ejemplos.length) {
                    return { ok: false, requiereFormatoFecha: true, filePath: rutaArchivo, ejemplos };
                }
            }

            let procesados = 0;
            let errores = [];

            await dbRun('BEGIN TRANSACTION;');

            try {
                for (let i = 0; i < rawData.length; i++) {
                    const row = rawData[i];

                    const num_empleado = String(row['Num'] || row['NUM'] || row['num_empleado'] || row['No'] || row['ID'] || '').trim();
                    const nombre = String(row['Nombre'] || row['NOMBRE'] || row['nombre'] || '').trim();
                    const apellido = String(row['Apellido'] || row['APELLIDO'] || row['apellido'] || row['Apellidos'] || '').trim();

                    if (!nombre) {
                        errores.push(`Fila ${i + 2}: Registro ignorado porque falta el Nombre.`);
                        continue;
                    }

                    const puesto = String(row['Puesto'] || row['PUESTO'] || row['puesto'] || 'General').trim();
                    const fechaRaw = extraerFechaRawDeFila(row);
                    const fecha_ingreso = resolverFechaConFormato(fechaRaw, formatoFecha);

                    const salario_diario = parseFloat(row['Salario Diario'] || row['SALARIO_DIARIO'] || row['salario_diario'] || row['SD'] || 0) || 0;
                    const salario_base = parseFloat(row['Salario Base'] || row['SALARIO_BASE'] || row['salario_base'] || row['SBC'] || 0) || 0;

                    const curp = String(row['CURP'] || row['curp'] || '').trim();
                    const rfc = String(row['RFC'] || row['rfc'] || '').trim().toUpperCase();
                    const nss = String(row['NSS'] || row['nss'] || '').trim();

                    if (!/^[A-Z0-9]{12,13}$/.test(rfc)) {
                        errores.push(`Fila ${i + 2}: RFC obligatorio inválido (debe tener 12 o 13 caracteres).`);
                        continue;
                    }
                    if (!/^\d{11}$/.test(nss)) {
                        errores.push(`Fila ${i + 2}: NSS obligatorio inválido (debe tener 11 dígitos).`);
                        continue;
                    }

                    const rfcIdx = indiceCiegoCampo(rfc);
                    const nssIdx = indiceCiegoCampo(nss);

                    const dupRFC = await dbGet(
                        `SELECT id, nombre, apellido FROM empleados WHERE rfc_idx = ? LIMIT 1`,
                        [rfcIdx]
                    );
                    if (dupRFC) {
                        errores.push(`Fila ${i + 2}: RFC ${rfc} ya pertenece a ${dupRFC.nombre} ${dupRFC.apellido}.`);
                        continue;
                    }

                    const dupNSS = await dbGet(
                        `SELECT id, nombre, apellido FROM empleados WHERE nss_idx = ? LIMIT 1`,
                        [nssIdx]
                    );
                    if (dupNSS) {
                        errores.push(`Fila ${i + 2}: NSS ${nss} ya pertenece a ${dupNSS.nombre} ${dupNSS.apellido}.`);
                        continue;
                    }

                    const dupNum = num_empleado
                        ? await dbGet(
                            `SELECT id, nombre, apellido FROM empleados WHERE empresa_id = ? AND UPPER(TRIM(num_empleado)) = ? LIMIT 1`,
                            [empresaId, num_empleado.toUpperCase()]
                          )
                        : null;
                    if (dupNum) {
                        errores.push(`Fila ${i + 2}: número de empleado ${num_empleado} ya existe en esta empresa.`);
                        continue;
                    }

                    const resEmp = await dbRun(`
                        INSERT INTO empleados (
                            empresa_id, num_empleado, nombre, apellido, puesto,
                            fecha_ingreso, salario_diario, salario_base, curp_enc, rfc_enc, rfc_idx, nss_enc, nss_idx, activo
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `, [
                        empresaId, num_empleado, nombre, apellido, puesto,
                        fecha_ingreso, salario_diario, salario_base, cifrarCampoSensible(curp), cifrarCampoSensible(rfc), rfcIdx, cifrarCampoSensible(nss), nssIdx
                    ]);

                    await generarSaldosVacacionesSiNoExisten(resEmp.lastID, fecha_ingreso);
                    procesados++;
                }

                await dbRun('COMMIT;');
            } catch (errTx) {
                await dbRun('ROLLBACK;');
                throw errTx;
            }

            return {
                ok: true,
                totalProcesados: procesados,
                totalErrores: errores.length,
                detallesErrores: errores
            };

        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // --- EMPRESAS ---
    ipcMain.removeHandler('empresas:obtener');
    ipcMain.handle('empresas:obtener', async () => {
        try {
            const data = await dbAll(`SELECT * FROM empresas ORDER BY nombre ASC`);
            const dataConLogo = data.map(e => ({
                ...e,
                logoDataUrl: obtenerLogoDataUrlPorEmpresaId(e.id),
                logoPersonalizado: !!e.logo_path
            }));
            return { ok: true, data: dataConLogo };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('empresas:obtener-logo-default');
    ipcMain.handle('empresas:obtener-logo-default', async () => {
        try {
            return { ok: true, dataUrl: archivoAImagenDataUrl(LOGO_APP_DEFAULT) };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('empresas:seleccionar-logo');
    ipcMain.handle('empresas:seleccionar-logo', async () => {
        try {
            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                title: 'Seleccionar logotipo de la empresa',
                filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
                properties: ['openFile']
            });
            if (canceled || !filePaths.length) return { ok: false };
            const rutaTemporal = filePaths[0];
            const previewDataUrl = archivoAImagenDataUrl(rutaTemporal);
            if (!previewDataUrl) return { ok: false, error: 'No fue posible leer la imagen seleccionada.' };
            return { ok: true, rutaTemporal, previewDataUrl };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('empresas:crear', async (event, payload = {}) => {
        try {
            const nombre = String(payload.nombre || '').trim();
            const rfc = String(payload.rfc || '').trim().toUpperCase();
            if (!nombre) return { ok: false, error: 'El nombre de la empresa es obligatorio.' };

            const dup = await dbGet(`SELECT id FROM empresas WHERE UPPER(TRIM(nombre)) = ?`, [nombre.toUpperCase()]);
            if (dup) return { ok: false, error: 'Ya existe una empresa con ese nombre.' };

            const res = await dbRun(`INSERT INTO empresas (nombre, rfc) VALUES (?, ?)`, [nombre, rfc]);
            const nuevoId = res.lastID;

            const rutaLogoOrigen = String(payload.logoRutaTemporal || '').trim();
            if (rutaLogoOrigen) {
                const rutaGuardada = guardarLogoEmpresa(nuevoId, rutaLogoOrigen);
                if (rutaGuardada) await dbRun(`UPDATE empresas SET logo_path = ? WHERE id = ?`, [rutaGuardada, nuevoId]);
            }

            await registrarAuditoria('Alta de empresa', 'Administración', `${nombre}${rfc ? ' · RFC ' + rfc : ''}`);
            return { ok: true, id: nuevoId };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('empresas:actualizar', async (event, payload = {}) => {
        try {
            const id = Number(payload.id || 0);
            const nombre = String(payload.nombre || '').trim();
            const rfc = String(payload.rfc || '').trim().toUpperCase();
            if (!id) return { ok: false, error: 'Empresa no especificada.' };
            if (!nombre) return { ok: false, error: 'El nombre de la empresa es obligatorio.' };

            const existente = await dbGet(`SELECT id, logo_path FROM empresas WHERE id = ?`, [id]);
            if (!existente) return { ok: false, error: 'La empresa no existe.' };

            const dup = await dbGet(`SELECT id FROM empresas WHERE UPPER(TRIM(nombre)) = ? AND id != ?`, [nombre.toUpperCase(), id]);
            if (dup) return { ok: false, error: 'Ya existe otra empresa con ese nombre.' };

            let nuevoLogoPath = existente.logo_path;
            const rutaLogoOrigen = String(payload.logoRutaTemporal || '').trim();
            if (rutaLogoOrigen) {
                const rutaGuardada = guardarLogoEmpresa(id, rutaLogoOrigen);
                if (rutaGuardada) nuevoLogoPath = rutaGuardada;
            } else if (payload.eliminarLogo) {
                if (existente.logo_path && fs.existsSync(existente.logo_path)) {
                    try { fs.unlinkSync(existente.logo_path); } catch (_) {}
                }
                nuevoLogoPath = null;
            }

            await dbRun(`UPDATE empresas SET nombre = ?, rfc = ?, logo_path = ? WHERE id = ?`, [nombre, rfc, nuevoLogoPath, id]);
            await registrarAuditoria('Edición de empresa', 'Administración', `ID ${id}: ${nombre}${rfc ? ' · RFC ' + rfc : ''}`);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('empresas:eliminar', async (event, payload) => {
        try {
            const id = Number(typeof payload === 'object' && payload !== null ? payload.id : payload);
            if (!id) return { ok: false, error: 'Empresa no especificada.' };

            const empresa = await dbGet(`SELECT id, nombre, logo_path FROM empresas WHERE id = ?`, [id]);
            if (!empresa) return { ok: false, error: 'La empresa no existe.' };

            const { total } = await dbGet(`SELECT COUNT(*) AS total FROM empleados WHERE empresa_id = ?`, [id]);
            if (total > 0) {
                return { ok: false, error: `No se puede eliminar "${empresa.nombre}": tiene ${total} empleado(s) registrados (activos o dados de baja). Reasígnalos a otra empresa o elimínalos primero.` };
            }

            if (empresa.logo_path && fs.existsSync(empresa.logo_path)) {
                try { fs.unlinkSync(empresa.logo_path); } catch (_) {}
            }

            await dbRun(`DELETE FROM empresas WHERE id = ?`, [id]);
            await registrarAuditoria('Eliminación de empresa', 'Administración', `ID ${id}: ${empresa.nombre}`);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // --- EXPEDIENTE DIGITAL ---
    ipcMain.removeHandler('empleados:obtener-por-empresa');
    ipcMain.handle('empleados:obtener-por-empresa', async (event, empresaId) => {
        try {
            const data = await dbAll(`
                SELECT e.*, emp.nombre as empresa_nombre 
                FROM empleados e
                INNER JOIN empresas emp ON e.empresa_id = emp.id
                WHERE e.empresa_id = ? AND e.activo = 1
                ORDER BY e.apellido ASC, e.nombre ASC
            `, [empresaId]);
            return { ok: true, data: descifrarCamposEmpleados(data) };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // --- BÚSQUEDA UNIFICADA DE EMPLEADOS (todos los módulos) ---
    ipcMain.removeHandler('empleados:buscar');
    ipcMain.handle('empleados:buscar', async (event, payload = {}) => {
        try {
            const p = (payload && typeof payload === 'object') ? payload : { busqueda: String(payload || '') };
            const empresaId = p.empresaId ? Number(p.empresaId) : null;
            const busqueda = String(p.busqueda || p.query || '').trim().toLowerCase();
            const estatus = String(p.estatus || 'ACTIVOS').toUpperCase();

            const condiciones = [];
            const params = [];
            if (empresaId) { condiciones.push('e.empresa_id = ?'); params.push(empresaId); }
            if (estatus === 'ACTIVOS') condiciones.push('e.activo = 1');
            else if (estatus === 'INACTIVOS') condiciones.push('e.activo = 0');

            if (busqueda) {
                const q = `%${busqueda}%`;
                condiciones.push(`(
                    LOWER(COALESCE(e.nombre,'')) LIKE ? OR
                    LOWER(COALESCE(e.apellido,'')) LIKE ? OR
                    LOWER(TRIM(COALESCE(e.nombre,'') || ' ' || COALESCE(e.apellido,''))) LIKE ? OR
                    LOWER(COALESCE(e.num_empleado,'')) LIKE ? OR
                    CAST(e.id AS TEXT) LIKE ? OR
                    LOWER(COALESCE(e.puesto,'')) LIKE ?
                )`);
                params.push(q,q,q,q,q,q);
            }

            const where = condiciones.length ? condiciones.join(' AND ') : '1=1';
            const data = await dbAll(`
                SELECT e.*, emp.nombre AS empresa_nombre
                FROM empleados e
                INNER JOIN empresas emp ON emp.id = e.empresa_id
                WHERE ${where}
                ORDER BY e.apellido ASC, e.nombre ASC
                LIMIT 50
            `, params);
            return { ok:true, data: descifrarCamposEmpleados(data) };
        } catch(error) {
            return { ok:false, error:error.message, data:[] };
        }
    });

    ipcMain.removeHandler('empleados:obtener-por-id');
    ipcMain.handle('empleados:obtener-por-id', async (event, payload) => {
        try {
            const id = (typeof payload === 'object' && payload !== null) ? (payload.id || payload.empleadoId) : payload;
            const data = await dbGet(`
                SELECT e.*, emp.nombre as empresa_nombre 
                FROM empleados e
                INNER JOIN empresas emp ON e.empresa_id = emp.id
                WHERE e.id = ?
            `, [id]);
            return { ok: true, data: descifrarCamposEmpleado(data) };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('empleados:crear');
    ipcMain.handle('empleados:crear', async (event, empleado) => {
        try {
            const {
                empresa_id, num_empleado, nombre, apellido, puesto,
                fecha_ingreso, salario_diario, salario_base, curp, rfc, nss, edad,
                fecha_contrato, fecha_vencimiento_contrato, ruta_contrato_pdf, fecha_nacimiento
            } = empleado;

            const rfcNorm = String(rfc || '').trim().toUpperCase();
            const nssNorm = String(nss || '').trim();
            const numNorm = String(num_empleado || '').trim().toUpperCase();
            const edadNum = Number(edad);

            // RFC obligatorio: 12 o 13 caracteres alfanuméricos.
            if (!rfcNorm || !/^[A-Z0-9]{12,13}$/.test(rfcNorm)) {
                return { ok:false, error:'El RFC es obligatorio y debe contener exactamente 12 o 13 caracteres alfanuméricos.' };
            }

            // NSS obligatorio: exactamente 11 dígitos numéricos.
            if (!/^\d{11}$/.test(nssNorm)) {
                return { ok:false, error:'El NSS es obligatorio y debe contener exactamente 11 dígitos.' };
            }

            if (!Number.isFinite(edadNum) || edadNum < 0 || edadNum > 120) {
                return { ok:false, error:'La edad debe estar entre 0 y 120 años.' };
            }
            const duplicadoExacto = await dbGet(`
                SELECT id, nombre, apellido FROM empleados
                WHERE empresa_id = ? AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))
                  AND UPPER(TRIM(apellido)) = UPPER(TRIM(?))
                  AND fecha_ingreso = ?
                LIMIT 1
            `, [empresa_id, nombre, apellido, fecha_ingreso]);
            if (duplicadoExacto) {
                return { ok:false, error:`Ya existe un registro igual para ${duplicadoExacto.nombre} ${duplicadoExacto.apellido} en esta empresa con la misma fecha de ingreso.` };
            }
            const rfcIdx = indiceCiegoCampo(rfcNorm);
            const nssIdx = indiceCiegoCampo(nssNorm);
            if (rfcNorm) {
                const dup = await dbGet(`SELECT id, nombre, apellido FROM empleados WHERE rfc_idx = ? LIMIT 1`, [rfcIdx]);
                if (dup) return { ok:false, error:`El RFC ${rfcNorm} ya está registrado para ${dup.nombre} ${dup.apellido}.` };
            }
            if (nssNorm) {
                const dup = await dbGet(`SELECT id, nombre, apellido FROM empleados WHERE nss_idx = ? LIMIT 1`, [nssIdx]);
                if (dup) return { ok:false, error:`El NSS ${nssNorm} ya está registrado para ${dup.nombre} ${dup.apellido}.` };
            }
            if (numNorm && empresa_id) {
                const dup = await dbGet(`SELECT id, nombre, apellido FROM empleados WHERE empresa_id = ? AND UPPER(TRIM(num_empleado)) = ? LIMIT 1`, [empresa_id, numNorm]);
                if (dup) return { ok:false, error:`El número de empleado ${numNorm} ya existe en esta empresa.` };
            }

            const res = await dbRun(`
                INSERT INTO empleados (
                    empresa_id, num_empleado, nombre, apellido, puesto,
                    fecha_ingreso, salario_diario, salario_base, curp_enc, rfc_enc, rfc_idx, nss_enc, nss_idx, edad,
                    fecha_contrato, fecha_vencimiento_contrato, ruta_contrato_pdf, fecha_nacimiento
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                empresa_id, num_empleado, nombre, apellido, puesto,
                fecha_ingreso, salario_diario || 0, salario_base || 0,
                cifrarCampoSensible(curp), cifrarCampoSensible(rfcNorm), rfcIdx, cifrarCampoSensible(nssNorm), nssIdx, edadNum,
                fecha_contrato || null, fecha_vencimiento_contrato || null,
                ruta_contrato_pdf || '', fecha_nacimiento || null
            ]);

            await generarSaldosVacacionesSiNoExisten(res.lastID, fecha_ingreso);

            await registrarAuditoria('Alta de empleado','Expediente', `Empleado ID ${res.lastID}`);
            return { ok: true, id: res.lastID };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('empleados:actualizar');
    ipcMain.handle('empleados:actualizar', async (event, empleado) => {
        try {
            const id = empleado?.id;
            if (!id) return { ok: false, error: 'ID de empleado no especificado.' };

            // Validación de identificadores únicos al editar.
            const rfcNuevo = Object.prototype.hasOwnProperty.call(empleado,'rfc') ? String(empleado.rfc || '').trim().toUpperCase() : null;
            const nssNuevo = Object.prototype.hasOwnProperty.call(empleado,'nss') ? String(empleado.nss || '').trim() : null;
            if (rfcNuevo) {
                const dup = await dbGet(`SELECT id, nombre, apellido FROM empleados WHERE id <> ? AND rfc_idx = ? LIMIT 1`, [id, indiceCiegoCampo(rfcNuevo)]);
                if (dup) return { ok:false, error:`El RFC ${rfcNuevo} ya está registrado para ${dup.nombre} ${dup.apellido}.` };
            }
            if (nssNuevo) {
                const dup = await dbGet(`SELECT id, nombre, apellido FROM empleados WHERE id <> ? AND nss_idx = ? LIMIT 1`, [id, indiceCiegoCampo(nssNuevo)]);
                if (dup) return { ok:false, error:`El NSS ${nssNuevo} ya está registrado para ${dup.nombre} ${dup.apellido}.` };
            }

            // Actualización parcial: permite cambiar solo el PDF sin enviar empresa_id = NULL.
            const camposPermitidos = {
                empresa_id: empleado.empresa_id,
                num_empleado: empleado.num_empleado,
                nombre: empleado.nombre,
                apellido: empleado.apellido,
                puesto: empleado.puesto,
                fecha_ingreso: empleado.fecha_ingreso,
                salario_diario: empleado.salario_diario,
                salario_base: empleado.salario_base,
                edad: empleado.edad,
                fecha_contrato: empleado.fecha_contrato,
                fecha_vencimiento_contrato: empleado.fecha_vencimiento_contrato,
                ruta_contrato_pdf: empleado.ruta_contrato_pdf,
                fecha_nacimiento: empleado.fecha_nacimiento,
                salario_minimo_profesional: empleado.salario_minimo_profesional
            };
            const sets=[]; const params=[];
            for (const [campo,valor] of Object.entries(camposPermitidos)) {
                if (Object.prototype.hasOwnProperty.call(empleado,campo)) {
                    sets.push(`${campo} = ?`); params.push(valor === undefined ? null : valor);
                }
            }
            if (Object.prototype.hasOwnProperty.call(empleado,'rfc')) {
                sets.push('rfc_enc = ?', 'rfc_idx = ?');
                params.push(rfcNuevo ? cifrarCampoSensible(rfcNuevo) : null, rfcNuevo ? indiceCiegoCampo(rfcNuevo) : null);
            }
            if (Object.prototype.hasOwnProperty.call(empleado,'nss')) {
                sets.push('nss_enc = ?', 'nss_idx = ?');
                params.push(nssNuevo ? cifrarCampoSensible(nssNuevo) : null, nssNuevo ? indiceCiegoCampo(nssNuevo) : null);
            }
            if (Object.prototype.hasOwnProperty.call(empleado,'curp')) {
                const curpNuevo = String(empleado.curp || '').trim().toUpperCase();
                sets.push('curp_enc = ?');
                params.push(curpNuevo ? cifrarCampoSensible(curpNuevo) : null);
            }
            if (!sets.length) return { ok: false, error: 'No hay campos para actualizar.' };
            params.push(id);
            const res=await dbRun(`UPDATE empleados SET ${sets.join(', ')} WHERE id = ?`, params);
            await registrarAuditoria('Actualización de empleado','Expediente',`Empleado ID ${id}`);
            return { ok:true, changes:res.changes };
        } catch(error) { return { ok:false,error:error.message }; }
    });


    // V22: eliminación física de un empleado.
    // Se borran primero los registros dependientes y finalmente la fila de empleados.
    // Si posteriormente se da de alta en otra empresa, INSERT crea un ID nuevo.
    ipcMain.removeHandler('empleados:eliminar');
    ipcMain.handle('empleados:eliminar', async (event, payload) => {
        try {
            const id = Number(typeof payload === 'object' && payload !== null
                ? (payload.id || payload.empleadoId)
                : payload);

            if (!Number.isInteger(id) || id <= 0) {
                return { ok:false, error:'ID de empleado no especificado.' };
            }

            const empleado = await dbGet(`
                SELECT id, empresa_id, nombre, apellido, ruta_contrato_pdf
                FROM empleados WHERE id = ?
            `, [id]);

            if (!empleado) {
                return { ok:false, error:'El empleado no existe.' };
            }

            await dbRun('BEGIN TRANSACTION');
            try {
                // Dependencias directas conocidas.
                await dbRun(`DELETE FROM detalle_movimientos_saldo
                             WHERE movimiento_id IN (SELECT id FROM movimientos_vacaciones WHERE empleado_id = ?)
                                OR solicitud_id IN (SELECT id FROM solicitudes_vacaciones WHERE empleado_id = ?)
                                OR saldo_id IN (SELECT id FROM saldos_vacaciones WHERE empleado_id = ?)`,
                    [id, id, id]);

                await dbRun(`DELETE FROM movimientos_vacaciones WHERE empleado_id = ?`, [id]);
                await dbRun(`DELETE FROM solicitudes_vacaciones WHERE empleado_id = ?`, [id]);
                await dbRun(`DELETE FROM saldos_vacaciones WHERE empleado_id = ?`, [id]);
                await dbRun(`DELETE FROM incidencias WHERE empleado_id = ?`, [id]);
                await dbRun(`DELETE FROM finiquitos_liquidaciones WHERE empleado_id = ?`, [id]);

                const result = await dbRun(`DELETE FROM empleados WHERE id = ?`, [id]);

                if (!result.changes) {
                    throw new Error('No fue posible eliminar el empleado.');
                }

                await dbRun('COMMIT');

                // El PDF pertenece al expediente eliminado; se intenta retirar
                // solo si existe y está dentro de una ruta de archivo válida.
                if (empleado.ruta_contrato_pdf && fs.existsSync(empleado.ruta_contrato_pdf)) {
                    try { fs.unlinkSync(empleado.ruta_contrato_pdf); } catch (_) {}
                }

                await registrarAuditoria(
                    'Baja/eliminación de empleado',
                    'Expediente',
                    `Empleado ID ${id}: ${empleado.nombre} ${empleado.apellido}`
                );

                return { ok:true, id, changes:result.changes };
            } catch (innerError) {
                await dbRun('ROLLBACK');
                throw innerError;
            }
        } catch (error) {
            return { ok:false, error:error.message };
        }
    });

    // V25: resumen contractual. Se calcula directamente desde empleados.
    ipcMain.removeHandler('contratos:obtener-resumen');
    ipcMain.handle('contratos:obtener-resumen', async (event, empresaId) => {
        try {
            const params = [];
            let where = '';
            if (empresaId !== undefined && empresaId !== null && Number(empresaId) > 0) {
                where = 'WHERE e.empresa_id = ?';
                params.push(Number(empresaId));
            }

            const empleados = await dbAll(`
                SELECT
                    e.id,
                    e.empresa_id,
                    e.num_empleado,
                    e.nombre,
                    e.apellido,
                    e.puesto,
                    e.fecha_ingreso,
                    e.fecha_contrato,
                    e.fecha_vencimiento_contrato,
                    e.ruta_contrato_pdf,
                    e.activo,
                    emp.nombre AS empresa_nombre
                FROM empleados e
                LEFT JOIN empresas emp ON emp.id = e.empresa_id
                ${where}
                ORDER BY
                    CASE
                        WHEN e.fecha_vencimiento_contrato IS NULL OR TRIM(e.fecha_vencimiento_contrato) = '' THEN 1
                        ELSE 0
                    END,
                    e.fecha_vencimiento_contrato ASC,
                    e.apellido ASC,
                    e.nombre ASC
            `, params);

            const hoy = new Date();
            hoy.setHours(0,0,0,0);
            const limite = new Date(hoy);
            limite.setDate(limite.getDate() + 60);

            const parseFecha = valor => {
                if (!valor) return null;
                const d = new Date(`${String(valor).slice(0,10)}T00:00:00`);
                return Number.isNaN(d.getTime()) ? null : d;
            };

            const data = empleados.map(e => {
                const fechaContrato = parseFecha(e.fecha_contrato);
                const vencimiento = parseFecha(e.fecha_vencimiento_contrato);
                const tieneContrato = Boolean(
                    String(e.ruta_contrato_pdf || '').trim() ||
                    String(e.fecha_contrato || '').trim() ||
                    String(e.fecha_vencimiento_contrato || '').trim()
                );

                let estado = 'SIN_CONTRATO';
                let diasParaVencer = null;

                if (tieneContrato) {
                    if (vencimiento) {
                        diasParaVencer = Math.ceil((vencimiento - hoy) / 86400000);
                        if (diasParaVencer < 0) estado = 'VENCIDO';
                        else if (vencimiento <= limite) estado = 'POR_VENCER';
                        else estado = 'ACTIVO';
                    } else {
                        // Tiene contrato registrado pero no se capturó vencimiento:
                        // no se inventa una fecha; queda activo sin fecha de vencimiento.
                        estado = 'ACTIVO_SIN_VENCIMIENTO';
                    }
                }

                return {
                    ...e,
                    fecha_contrato: e.fecha_contrato || '',
                    fecha_vencimiento_contrato: e.fecha_vencimiento_contrato || '',
                    tiene_contrato: tieneContrato,
                    estado,
                    dias_para_vencer: diasParaVencer
                };
            });

            return {
                ok: true,
                data,
                resumen: {
                    total: data.length,
                    activos: data.filter(x => x.estado === 'ACTIVO' || x.estado === 'ACTIVO_SIN_VENCIMIENTO').length,
                    porVencer: data.filter(x => x.estado === 'POR_VENCER').length,
                    vencidos: data.filter(x => x.estado === 'VENCIDO').length,
                    sinContrato: data.filter(x => x.estado === 'SIN_CONTRATO').length
                }
            };
        } catch (error) {
            return { ok:false, error:error.message };
        }
    });

    // ==========================================
    // EXPEDIENTE DIGITAL: documentos adjuntos por empleado
    // ==========================================
    ipcMain.removeHandler('documentos:catalogo-tipos');
    ipcMain.handle('documentos:catalogo-tipos', async () => {
        return { ok: true, data: CATALOGO_TIPOS_DOCUMENTO, requeridos: DOCUMENTOS_REQUERIDOS_EXPEDIENTE };
    });

    ipcMain.removeHandler('documentos:listar');
    ipcMain.handle('documentos:listar', async (event, empleadoId) => {
        try {
            const id = Number(empleadoId);
            if (!id) return { ok: false, error: 'Empleado no especificado.', data: [] };
            const data = await dbAll(`SELECT id, empleado_id, tipo, nombre_original, extension, fecha_subida FROM documentos_empleado WHERE empleado_id = ? ORDER BY fecha_subida DESC`, [id]);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message, data: [] };
        }
    });

    ipcMain.removeHandler('documentos:subir');
    ipcMain.handle('documentos:subir', async (event, payload = {}) => {
        try {
            const empleadoId = Number(payload.empleadoId);
            const tipo = String(payload.tipo || '').trim().toUpperCase();
            if (!empleadoId) return { ok: false, error: 'Empleado no especificado.' };
            if (!CATALOGO_TIPOS_DOCUMENTO[tipo]) return { ok: false, error: 'Tipo de documento no reconocido.' };

            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                title: `Seleccionar documento: ${CATALOGO_TIPOS_DOCUMENTO[tipo]}`,
                filters: [{ name: 'Documentos', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }],
                properties: ['openFile']
            });
            if (canceled || !filePaths.length) return { ok: false, cancelado: true };

            const rutaOrigen = filePaths[0];
            const extension = path.extname(rutaOrigen).toLowerCase().replace('.', '');
            if (!['pdf', 'jpg', 'jpeg', 'png'].includes(extension)) {
                return { ok: false, error: 'Formato no soportado. Usa PDF, JPG o PNG.' };
            }

            const bufferOriginal = fs.readFileSync(rutaOrigen);
            const bufferCifrado = cifrarBufferArchivo(bufferOriginal);
            const nombreArchivo = `${crypto.randomUUID()}.enc`;
            fs.writeFileSync(path.join(carpetaExpedienteEmpleado(empleadoId), nombreArchivo), bufferCifrado);

            const res = await dbRun(
                `INSERT INTO documentos_empleado (empleado_id, tipo, nombre_original, extension, archivo_cifrado) VALUES (?, ?, ?, ?, ?)`,
                [empleadoId, tipo, path.basename(rutaOrigen), extension, nombreArchivo]
            );
            await registrarAuditoria('Documento agregado al expediente', 'Expediente', `Empleado ID ${empleadoId} · ${CATALOGO_TIPOS_DOCUMENTO[tipo]}`);
            return { ok: true, id: res.lastID };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('documentos:abrir');
    ipcMain.handle('documentos:abrir', async (event, documentoId) => {
        try {
            const doc = await dbGet(`SELECT * FROM documentos_empleado WHERE id = ?`, [Number(documentoId)]);
            if (!doc) return { ok: false, error: 'Documento no encontrado.' };
            const rutaCifrada = path.join(carpetaExpedienteEmpleado(doc.empleado_id), doc.archivo_cifrado);
            if (!fs.existsSync(rutaCifrada)) return { ok: false, error: 'El archivo ya no existe en el equipo.' };
            const bufferPlano = descifrarBufferArchivo(fs.readFileSync(rutaCifrada));

            const dirTemp = path.join(os.tmpdir(), 'rrhh-control-expedientes');
            fs.mkdirSync(dirTemp, { recursive: true });
            const rutaTemp = path.join(dirTemp, `${crypto.randomUUID()}.${doc.extension || 'pdf'}`);
            fs.writeFileSync(rutaTemp, bufferPlano);
            await shell.openPath(rutaTemp);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('documentos:eliminar');
    ipcMain.handle('documentos:eliminar', async (event, documentoId) => {
        try {
            const doc = await dbGet(`SELECT * FROM documentos_empleado WHERE id = ?`, [Number(documentoId)]);
            if (!doc) return { ok: false, error: 'Documento no encontrado.' };
            const rutaCifrada = path.join(carpetaExpedienteEmpleado(doc.empleado_id), doc.archivo_cifrado);
            if (fs.existsSync(rutaCifrada)) { try { fs.unlinkSync(rutaCifrada); } catch (_) {} }
            await dbRun(`DELETE FROM documentos_empleado WHERE id = ?`, [doc.id]);
            await registrarAuditoria('Documento eliminado del expediente', 'Expediente', `Empleado ID ${doc.empleado_id} · ${CATALOGO_TIPOS_DOCUMENTO[doc.tipo] || doc.tipo}`);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('empleados:seleccionar-pdf-contrato');
    ipcMain.handle('empleados:seleccionar-pdf-contrato', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Seleccionar Contrato en PDF',
            filters: [{ name: 'Archivos PDF', extensions: ['pdf'] }],
            properties: ['openFile']
        });

        if (canceled || filePaths.length === 0) {
            return { ok: false };
        }

        return { ok: true, rutaPdf: filePaths[0] };
    });

    ipcMain.removeHandler('empleados:abrir-pdf-contrato');
    ipcMain.handle('empleados:abrir-pdf-contrato', async (event, rutaPdf) => {
        if (rutaPdf && fs.existsSync(rutaPdf) && path.extname(rutaPdf).toLowerCase() === '.pdf') {
            await shell.openPath(rutaPdf);
            return { ok: true };
        } else {
            return { ok: false, error: 'El archivo no existe o no es un PDF válido.' };
        }
    });

// ==========================================
    // 2. MÓDULO DE VACACIONES
    // ==========================================


    // V29/V31: remanente de vacaciones para finiquitos. Usa la MISMA fuente que el
    // módulo de vacaciones (calcularSaldoVacacionesUnificado) para garantizar consistencia.
    ipcMain.handle('vacaciones:obtener-remanente-finiquito', async (event, payload = {}) => {
        try {
            const empleadoId = Number(payload.empleadoId || payload.id || 0);
            const fechaConsulta = payload.fechaConsulta || obtenerFechaLocal();
            if (!empleadoId) return {ok:false,error:'ID de empleado no especificado.'};

            const empleado = await dbGet(`SELECT fecha_ingreso FROM empleados WHERE id=?`, [empleadoId]);
            if (!empleado) return {ok:false,error:'Empleado no encontrado.'};

            const saldo = await calcularSaldoVacacionesUnificado(empleadoId, fechaConsulta);
            return {
                ok:true,
                saldo:{
                    ...saldo,
                    remanente: Number(saldo.totalUsable || 0),
                    diasDisponibles: Number(saldo.totalUsable || 0)
                }
            };
        }catch(error){
            console.error('[IPC vacaciones:obtener-remanente-finiquito]',error);
            return {ok:false,error:error.message};
        }
    });

    ipcMain.handle('vacaciones:obtener-saldo', async (event, payload) => {
        try {
            let empleadoId;
            let fechaConsulta;

            if (typeof payload === 'object' && payload !== null) {
                empleadoId = payload.empleadoId || payload.id;
                fechaConsulta = payload.fechaConsulta;
            } else {
                empleadoId = payload;
            }

            if (!empleadoId) {
                return { ok: false, error: 'ID de empleado no especificado.' };
            }

            const saldo = await calcularSaldoVacacionesUnificado(empleadoId, fechaConsulta);
            return { ok: true, saldo };
        } catch (error) {
            console.error('[IPC vacaciones:obtener-saldo] Error:', error.message);
            return { ok: false, error: error.message };
        }
    });

    ipcMain.removeHandler('vacaciones:obtener-historial');
    ipcMain.handle('vacaciones:obtener-historial', async (event, payload = {}) => {
        try {
            // V21: garantizar las tablas que alimentan el historial antes de consultar.
            await dbRun(`
                CREATE TABLE IF NOT EXISTS solicitudes_vacaciones (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    empleado_id INTEGER NOT NULL,
                    fecha_inicio TEXT NOT NULL,
                    fecha_fin TEXT NOT NULL,
                    dias_solicitados REAL NOT NULL,
                    estado TEXT DEFAULT 'Aprobada',
                    observaciones TEXT,
                    creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
                );
            `);
            await dbRun(`
                CREATE TABLE IF NOT EXISTS movimientos_vacaciones (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    empleado_id INTEGER NOT NULL,
                    tipo_movimiento TEXT NOT NULL,
                    dias REAL NOT NULL,
                    fecha_movimiento TEXT NOT NULL,
                    monto_pagado REAL DEFAULT 0,
                    observaciones TEXT,
                    creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
                );
            `);
            const datos = (typeof payload === 'object' && payload !== null) ? payload : { empresaId: payload };
            const empresaId = datos.empresaId || null;
            const empleadoId = datos.empleadoId || datos.id || null;
            const texto = String(datos.texto || '').trim().toLowerCase();
            const estatus = String(datos.estatus || 'TODOS').toUpperCase();
            const fechaInicio = String(datos.fechaInicio || '').trim();
            const fechaFin = String(datos.fechaFin || '').trim();

            const baseCondiciones = [];
            const baseParams = [];
            if (empleadoId) {
                baseCondiciones.push('e.id = ?');
                baseParams.push(empleadoId);
            } else if (empresaId) {
                baseCondiciones.push('e.empresa_id = ?');
                baseParams.push(empresaId);
            }

            const construirSolicitud = () => {
                const condiciones = [...baseCondiciones];
                const params = [...baseParams];
                if (texto) {
                    const q = `%${texto}%`;
                    condiciones.push(`(LOWER(COALESCE(e.num_empleado, '')) LIKE ? OR LOWER(COALESCE(e.nombre, '')) LIKE ? OR LOWER(COALESCE(e.apellido, '')) LIKE ? OR LOWER(TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, ''))) LIKE ? OR LOWER(COALESCE(s.observaciones, '')) LIKE ? OR CAST(s.id AS TEXT) LIKE ?)`);
                    params.push(q, q, q, q, q, q);
                }
                if (estatus === 'APROBADO') condiciones.push(`UPPER(COALESCE(s.estado, '')) IN ('APROBADA', 'APROBADO', 'APLICADO')`);
                else if (estatus === 'PENDIENTE') condiciones.push(`UPPER(COALESCE(s.estado, '')) = 'PENDIENTE'`);
                else if (estatus === 'RECHAZADO') condiciones.push(`UPPER(COALESCE(s.estado, '')) IN ('CANCELADA', 'CANCELADO', 'RECHAZADA', 'RECHAZADO')`);
                if (fechaInicio) { condiciones.push('s.fecha_inicio >= ?'); params.push(fechaInicio); }
                if (fechaFin) { condiciones.push('s.fecha_inicio <= ?'); params.push(fechaFin); }
                return { condiciones, params };
            };

            const construirMovimiento = () => {
                const condiciones = [...baseCondiciones];
                const params = [...baseParams];
                if (texto) {
                    const q = `%${texto}%`;
                    condiciones.push(`(LOWER(COALESCE(e.num_empleado, '')) LIKE ? OR LOWER(COALESCE(e.nombre, '')) LIKE ? OR LOWER(COALESCE(e.apellido, '')) LIKE ? OR LOWER(TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, ''))) LIKE ? OR LOWER(COALESCE(m.observaciones, '')) LIKE ? OR CAST(m.id AS TEXT) LIKE ?)`);
                    params.push(q, q, q, q, q, q);
                }
                if (estatus === 'PENDIENTE' || estatus === 'RECHAZADO') condiciones.push('1 = 0');
                if (fechaInicio) { condiciones.push('m.fecha_movimiento >= ?'); params.push(fechaInicio); }
                if (fechaFin) { condiciones.push('m.fecha_movimiento <= ?'); params.push(fechaFin); }
                return { condiciones, params };
            };

            const solicitud = construirSolicitud();
            const movimiento = construirMovimiento();

            const querySolicitudes = `
                SELECT s.id, 'GOCE' AS tipo, s.empleado_id, e.nombre,
                       COALESCE(e.apellido, '') AS apellido,
                       TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, '')) AS nombre_completo,
                       e.num_empleado, s.fecha_inicio, s.fecha_fin,
                       s.dias_solicitados AS dias, s.estado, s.observaciones, s.creado_en
                FROM solicitudes_vacaciones s
                INNER JOIN empleados e ON s.empleado_id = e.id
                WHERE ${solicitud.condiciones.length ? solicitud.condiciones.join(' AND ') : '1=1'}
            `;
            const queryMovimientos = `
                SELECT m.id, m.tipo_movimiento AS tipo, m.empleado_id, e.nombre,
                       COALESCE(e.apellido, '') AS apellido,
                       TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, '')) AS nombre_completo,
                       e.num_empleado, m.fecha_movimiento AS fecha_inicio, '' AS fecha_fin,
                       m.dias, 'Aplicado' AS estado, m.observaciones, m.creado_en
                FROM movimientos_vacaciones m
                INNER JOIN empleados e ON m.empleado_id = e.id
                WHERE ${movimiento.condiciones.length ? movimiento.condiciones.join(' AND ') : '1=1'}
            `;

            const solicitudes = await dbAll(querySolicitudes, solicitud.params);
            const movimientos = await dbAll(queryMovimientos, movimiento.params);
            const historial = [...solicitudes, ...movimientos].sort((a, b) => {
                const fa = new Date(a.creado_en || a.fecha_inicio || 0).getTime();
                const fb = new Date(b.creado_en || b.fecha_inicio || 0).getTime();
                return fb - fa;
            });
            return { ok: true, data: historial };
        } catch (error) {
            console.error('[IPC vacaciones:obtener-historial] Error:', error);
            return { ok: false, error: error.message, data: [] };
        }
    });

    ipcMain.handle('vacaciones:solicitar-goce', async (event, datos) => {
        try {
            const empleadoId = datos.empleadoId || datos.empleado_id;
            const fechaInicio = datos.fechaInicio || datos.fecha_inicio;
            const fechaFin = datos.fechaFin || datos.fecha_fin;
            const dias = datos.dias || datos.dias_solicitados;
            const observaciones = datos.observaciones || '';

            if (!empleadoId || !fechaInicio || !fechaFin) {
                return { ok: false, error: 'Datos incompletos para registrar la solicitud.' };
            }

            const solicitudExistente = await dbGet(`
                SELECT id FROM solicitudes_vacaciones 
                WHERE empleado_id = ? 
                  AND (estado IS NULL OR estado != 'Cancelada')
                  AND (
                      (fecha_inicio <= ? AND fecha_fin >= ?) OR
                      (fecha_inicio <= ? AND fecha_fin >= ?) OR
                      (? <= fecha_inicio AND ? >= fecha_fin)
                  )
            `, [empleadoId, fechaFin, fechaInicio, fechaFin, fechaInicio, fechaInicio, fechaFin]);

            if (solicitudExistente) {
                return { 
                    ok: false, 
                    error: 'El empleado ya cuenta con una solicitud activa en el rango de fechas seleccionado.' 
                };
            }

            await dbRun('BEGIN TRANSACTION;');

            try {
                const resSolicitud = await dbRun(`
                    INSERT INTO solicitudes_vacaciones (empleado_id, fecha_inicio, fecha_fin, dias_solicitados, estado, observaciones)
                    VALUES (?, ?, ?, ?, 'Aprobada', ?)
                `, [empleadoId, fechaInicio, fechaFin, dias, observaciones]);

                await descontarSaldosFIFO({
                    empleadoId,
                    diasADescontar: dias,
                    fechaReferencia: fechaInicio,
                    solicitudId: resSolicitud.lastID
                });

                await dbRun('COMMIT;');
                await registrarAuditoria('Otorgación de vacaciones','Vacaciones', `Solicitud ${resSolicitud.lastID} · Empleado ${empleadoId} · ${dias} día(s)`);
                return { ok: true, solicitudId: resSolicitud.lastID };
            } catch (err) {
                await dbRun('ROLLBACK;');
                return { ok: false, error: err.message };
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('vacaciones:cancelar-solicitud', async (event, solicitudId) => {
        try {
            if (!solicitudId) {
                return { ok: false, error: 'ID de solicitud no especificado.' };
            }

            const solicitud = await dbGet(`SELECT * FROM solicitudes_vacaciones WHERE id = ?`, [solicitudId]);

            if (!solicitud) {
                return { ok: false, error: 'La solicitud no existe.' };
            }

            if (solicitud.estado === 'Cancelada') {
                return { ok: false, error: 'La solicitud ya se encuentra cancelada.' };
            }

            await dbRun('BEGIN TRANSACTION;');

            try {
                const consumos = await dbAll(`
                    SELECT saldo_id, dias_descontados 
                    FROM detalle_movimientos_saldo 
                    WHERE solicitud_id = ?
                `, [solicitudId]);

                for (const consumo of consumos) {
                    await dbRun(`
                        UPDATE saldos_vacaciones 
                        SET dias_restantes = dias_restantes + ? 
                        WHERE id = ?
                    `, [consumo.dias_descontados, consumo.saldo_id]);
                }

                await dbRun(`DELETE FROM detalle_movimientos_saldo WHERE solicitud_id = ?`, [solicitudId]);
                await dbRun(`UPDATE solicitudes_vacaciones SET estado = 'Cancelada' WHERE id = ?`, [solicitudId]);

                await dbRun('COMMIT;');
                await registrarAuditoria('Cancelación de vacaciones','Vacaciones', `Solicitud ${solicitudId}`);
                return { ok: true };
            } catch (err) {
                await dbRun('ROLLBACK;');
                return { ok: false, error: err.message };
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('vacaciones:pagar-dias', async (event, datos) => {
        try {
            const empleadoId = datos.empleadoId || datos.empleado_id;
            const dias = datos.dias;
            const fecha = datos.fecha || obtenerFechaLocal();
            const monto = datos.monto || 0;
            const observaciones = datos.observaciones || '';

            await dbRun('BEGIN TRANSACTION;');

            try {
                const resMov = await dbRun(`
                    INSERT INTO movimientos_vacaciones (empleado_id, tipo_movimiento, dias, fecha_movimiento, monto_pagado, observaciones)
                    VALUES (?, 'PAGO', ?, ?, ?, ?)
                `, [empleadoId, dias, fecha, monto, observaciones]);

                await descontarSaldosFIFO({
                    empleadoId,
                    diasADescontar: dias,
                    fechaReferencia: fecha,
                    movimientoId: resMov.lastID
                });

                await dbRun('COMMIT;');
                await registrarAuditoria('Pago de días','Vacaciones', `Movimiento ${resMov.lastID} · Empleado ${empleadoId}`);
                return { ok: true, movimientoId: resMov.lastID };
            } catch (err) {
                await dbRun('ROLLBACK;');
                return { ok: false, error: err.message };
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('vacaciones:descontar-falta', async (event, datos) => {
        try {
            const empleadoId = datos.empleadoId || datos.empleado_id;
            const dias = datos.dias;
            const fecha = datos.fecha || obtenerFechaLocal();
            const observaciones = datos.observaciones || '';

            await dbRun('BEGIN TRANSACTION;');

            try {
                const resMov = await dbRun(`
                    INSERT INTO movimientos_vacaciones (empleado_id, tipo_movimiento, dias, fecha_movimiento, monto_pagado, observaciones)
                    VALUES (?, 'DESCUENTO_FALTA', ?, ?, 0, ?)
                `, [empleadoId, dias, fecha, observaciones]);

                await descontarSaldosFIFO({
                    empleadoId,
                    diasADescontar: dias,
                    fechaReferencia: fecha,
                    movimientoId: resMov.lastID
                });

                await dbRun('COMMIT;');
                await registrarAuditoria('Descuento por falta','Vacaciones', `Movimiento ${resMov.lastID} · Empleado ${empleadoId}`);
                return { ok: true, movimientoId: resMov.lastID };
            } catch (err) {
                await dbRun('ROLLBACK;');
                return { ok: false, error: err.message };
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
   // =========================================================
    // --- INCIDENCIAS (A CUENTA DE VACACIONES) ---
    // =========================================================
    ipcMain.handle('incidencias:registrar', async (event, incidencia = {}) => {
        try {
            const empleadoId = Number(incidencia.empleado_id || incidencia.empleadoId || 0);
            const fecha = String(incidencia.fecha || incidencia.fecha_inicio || obtenerFechaLocal()).slice(0, 10);
            const fechaFin = String(incidencia.fecha_fin || fecha).slice(0, 10);
            const dias = Number(incidencia.dias || 1);
            const tipo = String(incidencia.tipo || incidencia.tipo_incidencia || 'INCIDENCIA_A_CUENTA_VACACIONES').trim();
            const observaciones = String(incidencia.observaciones || '').trim();
            if (!empleadoId) return { ok:false, error:'Seleccione un empleado.' };
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { ok:false, error:'Indique una fecha válida.' };
            if (!Number.isFinite(dias) || dias <= 0) return { ok:false, error:'Los días de la incidencia deben ser mayores que cero.' };

            const empleado = await dbGet(`SELECT e.id,e.nombre,e.apellido,e.empresa_id,em.nombre AS empresa_nombre FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.id=? AND e.activo=1`, [empleadoId]);
            if (!empleado) return { ok:false, error:'El empleado no existe o está inactivo.' };

            const saldos = await dbAll(`SELECT id,dias_restantes FROM saldos_vacaciones WHERE empleado_id=? AND dias_restantes>0 AND fecha_disponible<=? ORDER BY periodo ASC`, [empleadoId,fecha]);
            const disponible=saldos.reduce((s,x)=>s+Number(x.dias_restantes||0),0);
            if(disponible<dias) return {ok:false,sinSaldo:true,error:`El empleado no cuenta con días disponibles suficientes. Disponible: ${disponible}; solicitado: ${dias}.`};

            await dbRun('BEGIN TRANSACTION;');
            try {
                const res=await dbRun(`INSERT INTO incidencias (empleado_id,tipo_incidencia,fecha_inicio,fecha_fin,dias,observaciones,cancelada,dias_descontados) VALUES (?,?,?,?,?,?,0,0)`,[empleadoId,tipo,fecha,fechaFin,dias,observaciones]);
                const mov=await dbRun(`INSERT INTO movimientos_vacaciones (empleado_id,tipo_movimiento,dias,fecha_movimiento,monto_pagado,observaciones) VALUES (?,'INCIDENCIA',?, ?,0,?)`,[empleadoId,dias,fecha,`Incidencia ${res.lastID}${observaciones?' · '+observaciones:''}`]);
                await descontarSaldosFIFO({empleadoId,diasADescontar:dias,fechaReferencia:fecha,movimientoId:mov.lastID});
                const folio=`INC-${new Date().getFullYear()}-${String(res.lastID).padStart(6,'0')}`;
                await dbRun(`UPDATE incidencias SET folio=?,dias_descontados=?,movimiento_id=? WHERE id=?`,[folio,dias,mov.lastID,res.lastID]);
                await dbRun('COMMIT;');
                await registrarAuditoria('Alta de incidencia a cuenta de vacaciones','Incidencias',`${folio} · Empleado ${empleadoId} · ${dias} día(s)`);
                return {ok:true,id:res.lastID,folio,diasDescontados:dias};
            }catch(e){await dbRun('ROLLBACK;');throw e;}
        }catch(error){return{ok:false,error:error.message};}
    });

    
    ipcMain.handle('incidencias:obtener-todas', async (event, payload = {}) => {
        try {
            const p = (payload && typeof payload === 'object') ? payload : { busqueda: String(payload || '') };
            const busqueda = String(p.busqueda || '').trim().toLowerCase();
            const empleadoId = Number(p.empleadoId || 0);

            const condiciones = [];
            const params = [];

            if (empleadoId > 0) {
                condiciones.push('i.empleado_id = ?');
                params.push(empleadoId);
            }

            if (busqueda) {
                const q = `%${busqueda}%`;
                condiciones.push(`(
                    LOWER(COALESCE(e.nombre,'')) LIKE ? OR
                    LOWER(COALESCE(e.apellido,'')) LIKE ? OR
                    LOWER(TRIM(COALESCE(e.nombre,'') || ' ' || COALESCE(e.apellido,''))) LIKE ? OR
                    LOWER(COALESCE(i.folio,'')) LIKE ? OR
                    LOWER(COALESCE(em.nombre,'')) LIKE ?
                )`);
                params.push(q, q, q, q, q);
            }

            const where = condiciones.length ? condiciones.join(' AND ') : '1=1';

            const data = await dbAll(`
                SELECT
                    i.id,
                    i.folio,
                    i.empleado_id,
                    i.tipo_incidencia,
                    i.fecha_inicio,
                    i.fecha_fin,
                    i.dias,
                    i.observaciones,
                    i.cancelada,
                    i.cancelada_en,
                    i.dias_descontados,
                    e.nombre,
                    e.apellido,
                    e.num_empleado,
                    em.nombre AS empresa_nombre
                FROM incidencias i
                JOIN empleados e ON e.id = i.empleado_id
                LEFT JOIN empresas em ON em.id = e.empresa_id
                WHERE ${where}
                ORDER BY i.fecha_inicio DESC, i.id DESC
            `, params);

            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

ipcMain.handle('incidencias:obtener-por-empleado', async (event,payload)=>{
        try{
            const empleadoId=Number((typeof payload==='object'&&payload!==null)?(payload.empleadoId||payload.id):payload);
            if(!empleadoId)return{ok:false,error:'ID de empleado no especificado.'};
            const data=await dbAll(`SELECT i.id,i.folio,i.empleado_id,i.tipo_incidencia,i.fecha_inicio,i.fecha_fin,i.dias,i.observaciones,i.cancelada,i.cancelada_en,i.dias_descontados,e.nombre,e.apellido,e.num_empleado,em.nombre AS empresa_nombre FROM incidencias i JOIN empleados e ON e.id=i.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE i.empleado_id=? ORDER BY i.fecha_inicio DESC,i.id DESC`,[empleadoId]);
            return{ok:true,data};
        }catch(error){return{ok:false,error:error.message};}
    });

    ipcMain.handle('incidencias:cancelar', async(event,incidenciaId)=>{
        try{
            const id=Number(incidenciaId||0);if(!id)return{ok:false,error:'ID de incidencia no especificado.'};
            const inc=await dbGet(`SELECT * FROM incidencias WHERE id=?`,[id]);
            if(!inc)return{ok:false,error:'La incidencia no existe.'};
            if(Number(inc.cancelada)===1)return{ok:false,error:'La incidencia ya está cancelada.'};
            await dbRun('BEGIN TRANSACTION;');
            try{
                // Vínculo directo por movimiento_id (columna V-fix). Antes se buscaba por
                // texto ("observaciones LIKE '%Incidencia N%'"), que también coincidía con
                // "Incidencia N0", "N9", etc. y podía revertir el movimiento equivocado.
                const mov = inc.movimiento_id
                    ? await dbGet(`SELECT id FROM movimientos_vacaciones WHERE id=?`, [inc.movimiento_id])
                    : await dbGet(
                        `SELECT id FROM movimientos_vacaciones WHERE empleado_id=? AND tipo_movimiento='INCIDENCIA' AND (observaciones = ? OR observaciones LIKE ?) ORDER BY id DESC LIMIT 1`,
                        [inc.empleado_id, `Incidencia ${id}`, `Incidencia ${id} ·%`]
                      );
                if(mov){
                    const consumos=await dbAll(`SELECT saldo_id,dias_descontados FROM detalle_movimientos_saldo WHERE movimiento_id=?`,[mov.id]);
                    for(const c of consumos) await dbRun(`UPDATE saldos_vacaciones SET dias_restantes=dias_restantes+? WHERE id=?`,[Number(c.dias_descontados||0),c.saldo_id]);
                    await dbRun(`DELETE FROM detalle_movimientos_saldo WHERE movimiento_id=?`,[mov.id]);
                    await dbRun(`DELETE FROM movimientos_vacaciones WHERE id=?`,[mov.id]);
                }
                await dbRun(`UPDATE incidencias SET cancelada=1,cancelada_en=CURRENT_TIMESTAMP,dias_descontados=0 WHERE id=?`,[id]);
                await dbRun('COMMIT;');
                await registrarAuditoria('Cancelación de incidencia','Incidencias',`${inc.folio||'INC-'+id} · Empleado ${inc.empleado_id}`);
                return{ok:true};
            }catch(e){await dbRun('ROLLBACK;');throw e;}
        }catch(error){return{ok:false,error:error.message};}
    });

   // =========================================================
    // --- FINIQUITOS Y LIQUIDACIONES ---
    // Cálculo íntegro en main (nada en el renderer). Mismas fórmulas que la
    // simulación V23 original, solo relocadas aquí para que el renderer no
    // pueda falsificar montos/ISR antes de guardar.
    // =========================================================

    const ISR_TABLA_DEFAULT_2026 = [
        [.01,844.59,0,.0192],[844.60,7168.51,16.22,.064],[7168.52,12598.02,420.95,.1088],
        [12598.03,14644.64,1011.68,.16],[14644.65,17533.64,1339.14,.1792],[17533.65,35362.83,1856.84,.2136],
        [35362.84,55736.68,5665.16,.2352],[55736.69,106410.50,10457.09,.30],[106410.51,141880.66,25659.23,.32],
        [141880.67,425641.99,37009.69,.34],[425642,Infinity,133488.54,.35]
    ];

    async function obtenerTablaISRParaCalculoFiniquito(ejercicio) {
        const filas = await dbAll(`SELECT limite_inferior, limite_superior, cuota_fija, porcentaje_excedente FROM isr_tabla_mensual WHERE ejercicio=? ORDER BY limite_inferior ASC`, [Number(ejercicio)]);
        const tabla = (filas && filas.length)
            ? filas.map(x => [Number(x.limite_inferior), x.limite_superior == null ? Infinity : Number(x.limite_superior), Number(x.cuota_fija || 0), Number(x.porcentaje_excedente || 0)])
            : ISR_TABLA_DEFAULT_2026;
        return tabla.slice().sort((a, b) => a[0] - b[0]);
    }

    function aniosCumplidosFiniquitoV23(ingreso, baja) {
        let anios = baja.getFullYear() - ingreso.getFullYear();
        const aniversario = new Date(baja.getFullYear(), ingreso.getMonth(), ingreso.getDate());
        if (baja < aniversario) anios--;
        return Math.max(0, anios);
    }

    function diasEntreFechasFiniquitoV23(inicio, fin) {
        const ms = 86400000;
        return Math.max(0, Math.floor((fin - inicio) / ms) + 1);
    }

    function calcularFiniquitoV23({ empleadoId, tipoBaja, fechaBaja, ingreso, baja, salarioFiscal, salarioReal, diasSueldo, porcentajePA, incluir90, diasVac, salarioBaseDb, tablaISR, ejercicioISR }) {
        const diasAntiguedadCompletos = aniosCumplidosFiniquitoV23(ingreso, baja);
        const aniosCalculo = diasAntiguedadCompletos + 1;
        const inicioEj = new Date(baja.getFullYear(), 0, 1), inicioAgu = ingreso > inicioEj ? ingreso : inicioEj;
        const diasAguinaldo = diasEntreFechasFiniquitoV23(inicioAgu, baja);
        const aguinaldoFiscal = 15/365*diasAguinaldo*salarioFiscal, aguinaldoReal = 15/365*diasAguinaldo*salarioReal;
        const vacacionesFiscal = diasVac*salarioFiscal, vacacionesReal = diasVac*salarioReal;
        const primaVacFiscal = vacacionesFiscal*.25, primaVacReal = vacacionesReal*.25;
        const topeF = Math.min(salarioFiscal,248.93*2), topeR = Math.min(salarioReal,248.93*2);
        const aplicaPA = tipoBaja==='LIQUIDACION' || (tipoBaja==='FINIQUITO' && diasAntiguedadCompletos>=15);
        const primaAF = aplicaPA?12*aniosCalculo*topeF*(porcentajePA/100):0, primaAR = aplicaPA?12*aniosCalculo*topeR*(porcentajePA/100):0;
        const integradoF = Number(salarioBaseDb || salarioFiscal), integradoR = salarioReal;
        const indemnF = (tipoBaja==='LIQUIDACION'&&incluir90)?90*integradoF:0;
        const indemnR = (tipoBaja==='LIQUIDACION'&&incluir90)?90*integradoR:0;
        const sueldoF = diasSueldo*salarioFiscal, sueldoR = diasSueldo*salarioReal;
        const calcularISR = base => { const t = tablaISR.find(x=>base>=x[0]&&base<=x[1]) || tablaISR[tablaISR.length-1]; return Math.max(0,(base-t[0])*t[3]+t[2]); };
        const UMA=113.14, SM=278.80;
        const exRetF = Math.min(indemnF+primaAF, 90*UMA*Math.max(1,diasAntiguedadCompletos));
        const exRetR = Math.min(indemnR+primaAR, 90*UMA*Math.max(1,diasAntiguedadCompletos));
        const exAguF = Math.min(aguinaldoFiscal,30*UMA), exAguR = Math.min(aguinaldoReal,30*UMA);
        const exPVF = Math.min(primaVacFiscal,15*SM), exPVR = Math.min(primaVacReal,15*SM);
        const brutoF = sueldoF+aguinaldoFiscal+vacacionesFiscal+primaVacFiscal+primaAF+indemnF;
        const brutoR = sueldoR+aguinaldoReal+vacacionesReal+primaVacReal+primaAR+indemnR;
        const gravF = Math.max(0,brutoF-exRetF-exAguF-exPVF), gravR = Math.max(0,brutoR-exRetR-exAguR-exPVR);
        const baseMensualF = Math.max(0,salarioFiscal*30.04), baseMensualR = Math.max(0,salarioReal*30.04);
        const isrMensualF = calcularISR(baseMensualF), isrMensualR = calcularISR(baseMensualR);
        // Procedimiento de tasa (Art. 174 RLISR) para ingresos por separación: la tarifa NO
        // se aplica directamente sobre la base gravada del finiquito (eso sobre-retiene, al
        // empujar un monto grande a un tramo marginal alto). Se deriva primero la tasa
        // efectiva del ISR sobre el sueldo mensual ordinario y esa tasa es la que se aplica
        // a la base gravada. Mismo método que usan las hojas "ISR ..." del papel de trabajo
        // real (tasa = ISR del sueldo mensual / sueldo mensual; ISR a retener = base gravada × tasa).
        const tasaF = baseMensualF > 0 ? isrMensualF / baseMensualF : 0;
        const tasaR = baseMensualR > 0 ? isrMensualR / baseMensualR : 0;
        const isrF = Math.max(0, gravF * tasaF), isrR = Math.max(0, gravR * tasaR);

        return {
            empleado_id: empleadoId, tipo_baja: tipoBaja, fecha_baja: fechaBaja,
            salario_diario: salarioFiscal, salario_base: +integradoF.toFixed(2),
            dias_sueldo_pendiente: diasSueldo,
            sueldo_pendiente_fiscal: +sueldoF.toFixed(2), sueldo_pendiente_real: +sueldoR.toFixed(2),
            dias_aguinaldo: diasAguinaldo,
            aguinaldo_fiscal: +aguinaldoFiscal.toFixed(2), aguinaldo_real: +aguinaldoReal,
            dias_vacaciones: +diasVac.toFixed(2),
            vacaciones_fiscal: +vacacionesFiscal.toFixed(2), vacaciones_real: +vacacionesReal,
            prima_vacacional_fiscal: +primaVacFiscal.toFixed(2), prima_vacacional_real: +primaVacReal,
            prima_vacacional_porcentaje: 25,
            anios_antiguedad: diasAntiguedadCompletos, anios_calculo: aniosCalculo,
            porcentaje_prima_antiguedad: porcentajePA,
            prima_antiguedad_fiscal: +primaAF.toFixed(2), prima_antiguedad_real: +primaAR.toFixed(2),
            indemnizacion_incluida: indemnF>0, indemnizacion_90_opcional: tipoBaja==='LIQUIDACION',
            indemnizacion_fiscal: +indemnF.toFixed(2), indemnizacion_real: +indemnR.toFixed(2),
            exento_retiro_fiscal: +exRetF.toFixed(2), exento_retiro_real: +exRetR.toFixed(2),
            exento_aguinaldo_fiscal: +exAguF.toFixed(2), exento_aguinaldo_real: +exAguR.toFixed(2),
            exento_prima_vacacional_fiscal: +exPVF.toFixed(2), exento_prima_vacacional_real: +exPVR.toFixed(2),
            percepcion_gravada_fiscal: +gravF.toFixed(2), percepcion_gravada_real: +gravR.toFixed(2),
            parte_exenta: +Math.max(0,brutoF-gravF).toFixed(2), parte_gravada: +gravF.toFixed(2),
            parte_exenta_fiscal: +Math.max(0,brutoF-gravF).toFixed(2), parte_exenta_real: +Math.max(0,brutoR-gravR).toFixed(2),
            parte_gravada_fiscal: +gravF.toFixed(2), parte_gravada_real: +gravR.toFixed(2),
            isr_mensual_fiscal: +isrMensualF.toFixed(2), isr_mensual_real: +isrMensualR.toFixed(2),
            tasa_isr_fiscal: +(tasaF*100).toFixed(4), tasa_isr_real: +(tasaR*100).toFixed(4),
            isr_retenido: +isrF.toFixed(2), isr_retenido_fiscal: +isrF.toFixed(2), isr_retenido_real: +isrR.toFixed(2),
            tabla_isr_ejercicio: ejercicioISR,
            total_fiscal_bruto: +brutoF.toFixed(2), total_real_bruto: +brutoR.toFixed(2),
            total_fiscal_neto: +Math.max(0,brutoF-isrF).toFixed(2), total_real_neto: +Math.max(0,brutoR-isrR).toFixed(2)
        };
    }

    // Huella de integridad del finiquito guardado: SHA256 sobre los campos
    // identificatorios y financieros del cálculo, en orden fijo. Permite
    // detectar si un registro fue alterado directamente en la BD después de
    // guardado (recalculando el hash desde sus propias columnas y comparando).
    function calcularHashFiniquito(sim) {
        const payload = JSON.stringify({
            empleado_id: sim.empleado_id,
            tipo_baja: sim.tipo_baja,
            fecha_baja: sim.fecha_baja,
            salario_diario: sim.salario_diario,
            dias_sueldo_pendiente: sim.dias_sueldo_pendiente,
            dias_aguinaldo: sim.dias_aguinaldo,
            dias_vacaciones: sim.dias_vacaciones,
            anios_antiguedad: sim.anios_antiguedad,
            porcentaje_prima_antiguedad: sim.porcentaje_prima_antiguedad,
            indemnizacion_incluida: sim.indemnizacion_incluida,
            isr_retenido_fiscal: sim.isr_retenido_fiscal,
            isr_retenido_real: sim.isr_retenido_real,
            total_fiscal_bruto: sim.total_fiscal_bruto,
            total_real_bruto: sim.total_real_bruto,
            total_fiscal_neto: sim.total_fiscal_neto,
            total_real_neto: sim.total_real_neto
        });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    async function prepararSimulacionFiniquito(payload) {
        const p = payload || {};
        const empleadoId = Number(p.empleado_id || p.empleadoId || 0);
        const fechaBaja = String(p.fecha_baja || '').trim();
        if (!empleadoId || !fechaBaja) throw new Error('Selecciona un empleado y una fecha de baja.');
        const tipoBaja = p.tipo_baja === 'LIQUIDACION' ? 'LIQUIDACION' : 'FINIQUITO';

        const empleado = await dbGet(`SELECT id, fecha_ingreso, salario_diario, salario_base FROM empleados WHERE id=?`, [empleadoId]);
        if (!empleado) throw new Error('Empleado no encontrado.');
        if (!empleado.fecha_ingreso) throw new Error('El empleado no tiene una fecha de ingreso válida.');

        const ingreso = new Date(`${empleado.fecha_ingreso}T00:00:00`);
        const baja = new Date(`${fechaBaja}T00:00:00`);
        if (Number.isNaN(ingreso.getTime()) || Number.isNaN(baja.getTime()) || baja < ingreso) {
            throw new Error('La fecha de baja no puede ser anterior a la fecha de ingreso.');
        }

        const salarioFiscal = Number(p.salario_fiscal || empleado.salario_diario || 0);
        const salarioReal = Number(p.salario_real || salarioFiscal || 0);
        if (!(salarioFiscal > 0)) throw new Error('El Salario Diario Fiscal debe ser mayor que cero.');
        const diasSueldo = Math.max(0, Number(p.dias_sueldo_pendiente || 0));
        let porcentajePA = Number(p.porcentaje_prima_antiguedad ?? 100);
        if (!Number.isFinite(porcentajePA)) porcentajePA = 100;
        porcentajePA = Math.min(100, Math.max(40, porcentajePA));
        const incluir90 = tipoBaja === 'LIQUIDACION' ? Boolean(p.incluir_indemnizacion_90) : false;

        // V32/V33: mismo criterio que el módulo de Vacaciones — remanente = días
        // disponibles liberados a la fecha de HOY, no a la fecha de baja (permite
        // capturar bajas históricas de migración usando el saldo vigente).
        const fechaCorteVacaciones = obtenerFechaLocal();
        const saldo = await calcularSaldoVacacionesUnificado(empleadoId, fechaCorteVacaciones);
        const diasVac = Math.max(0, Number(saldo?.totalUsable || 0));

        // El ejercicio de la tabla ISR debe ser el del año en que ocurre la baja
        // (el ISR se retiene con la tarifa vigente ese año), no un año fijo.
        const ejercicioISR = baja.getFullYear();
        const tablaISR = await obtenerTablaISRParaCalculoFiniquito(ejercicioISR);

        return calcularFiniquitoV23({
            empleadoId, tipoBaja, fechaBaja, ingreso, baja,
            salarioFiscal, salarioReal, diasSueldo, porcentajePA, incluir90,
            diasVac, salarioBaseDb: empleado.salario_base, tablaISR, ejercicioISR
        });
    }

    ipcMain.handle('finiquitos:simular', async (event, payload) => {
        try {
            const sim = await prepararSimulacionFiniquito(payload);
            return { ok: true, data: sim };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('finiquitos:guardar', async (event, payload) => {
        try {
            const sim = await prepararSimulacionFiniquito(payload);

            const ejecutarGuardadoFiniquito = db.transaction((d) => {
                const hash = calcularHashFiniquito(d);
                const info = db.prepare(`
                    INSERT INTO finiquitos_liquidaciones (
                        empleado_id, tipo_baja, fecha_baja, salario_diario,
                        salario_fiscal, salario_real, isr_retenido,
                        dias_trabajados_periodo, monto_dias_trabajados,
                        monto_sueldo_pendiente, monto_aguinaldo_proporcional,
                        monto_vacaciones_proporcional, monto_prima_vacacional,
                        monto_indemnizacion, monto_veinte_dias_ano,
                        monto_prima_antiguedad, total_pagar, observaciones,
                        total_fiscal_bruto, total_real_bruto,
                        total_fiscal_neto, total_real_neto,
                        dias_vacaciones, anios_antiguedad, incluir_prima_antiguedad,
                        remanente_vacaciones, parte_exenta, parte_gravada,
                        indemnizacion_90_incluida, porcentaje_prima_antiguedad,
                        hash_sha256
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `).run(
                    d.empleado_id, d.tipo_baja, d.fecha_baja, Number(d.salario_diario || 0),
                    Number(d.salario_diario || 0), Number(d.salario_real || 0), Number(d.isr_retenido || 0),
                    Number(d.dias_aguinaldo || 0),
                    0, Number(d.sueldo_pendiente_fiscal || 0),
                    Number(d.aguinaldo_fiscal || 0),
                    Number(d.vacaciones_fiscal || 0),
                    Number(d.prima_vacacional_fiscal || 0),
                    Number(d.indemnizacion_fiscal || 0),
                    0,
                    Number(d.prima_antiguedad_fiscal || 0),
                    Number(d.total_fiscal_neto || 0),
                    d.observaciones || '',
                    Number(d.total_fiscal_bruto || 0), Number(d.total_real_bruto || 0),
                    Number(d.total_fiscal_neto || 0), Number(d.total_real_neto || 0),
                    Number(d.dias_vacaciones || 0), Number(d.anios_antiguedad || 0),
                    d.indemnizacion_90_opcional ? 1 : 0,
                    Number(d.dias_vacaciones ?? 0),
                    Number(d.parte_exenta ?? 0),
                    Number(d.parte_gravada ?? 0),
                    d.indemnizacion_incluida ? 1 : 0,
                    Number(d.porcentaje_prima_antiguedad ?? 100),
                    hash
                );

                db.prepare(`UPDATE empleados SET activo=0, fecha_baja=? WHERE id=?`).run(d.fecha_baja, d.empleado_id);

                return { id: info.lastInsertRowid, hash };
            });

            const { id: nuevoId, hash } = ejecutarGuardadoFiniquito(sim);
            // La transacción tocó dos tablas (INSERT en finiquitos_liquidaciones +
            // UPDATE en empleados para la baja); se notifican ambas para que cualquier
            // vista que dependa de alguna de las dos se refresque sin F5.
            notificarCambioDB({ tabla: 'finiquitos', origen: 'finiquitos:guardar', ts: Date.now() });
            notificarCambioDB({ tabla: 'empleados', origen: 'finiquitos:guardar', ts: Date.now() });
            return { ok: true, id: nuevoId, hash_sha256: hash };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('finiquitos:obtener-por-empleado', async (event, payload) => {
        try {
            const empleadoId = (typeof payload === 'object' && payload !== null) ? (payload.empleadoId || payload.id) : payload;
            const data = await dbGet(`
                SELECT * FROM finiquitos_liquidaciones 
                WHERE empleado_id = ? 
                ORDER BY id DESC LIMIT 1
            `, [empleadoId]);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });


    ipcMain.handle('finiquitos:obtener-historial', async (event, payload={}) => {
        try {
            const p=payload||{};
            const busqueda=String(p.busqueda||'').trim().toLowerCase();
            const tipo=String(p.tipo||'').trim().toUpperCase();
            const desde=String(p.desde||'').trim();
            const hasta=String(p.hasta||'').trim();
            const where=[]; const params=[];
            if(busqueda){
                const q=`%${busqueda}%`;
                where.push(`(
                    LOWER(COALESCE(e.nombre,'')) LIKE ? OR
                    LOWER(COALESCE(e.apellido,'')) LIKE ? OR
                    LOWER(TRIM(COALESCE(e.nombre,'')||' '||COALESCE(e.apellido,''))) LIKE ? OR
                    LOWER(COALESCE(e.num_empleado,'')) LIKE ? OR
                    LOWER(COALESCE(em.nombre,'')) LIKE ? OR
                    LOWER(COALESCE(fl.tipo_baja,'')) LIKE ?
                )`);
                params.push(q,q,q,q,q,q);
            }
            if(tipo){where.push('UPPER(fl.tipo_baja)=?');params.push(tipo);}
            if(desde){where.push('date(fl.fecha_baja)>=date(?)');params.push(desde);}
            if(hasta){where.push('date(fl.fecha_baja)<=date(?)');params.push(hasta);}
            const data=await dbAll(`
                SELECT fl.*, e.nombre, e.apellido, e.num_empleado, em.nombre AS empresa_nombre
                FROM finiquitos_liquidaciones fl
                JOIN empleados e ON e.id=fl.empleado_id
                LEFT JOIN empresas em ON em.id=e.empresa_id
                ${where.length?'WHERE '+where.join(' AND '):''}
                ORDER BY date(fl.fecha_baja) DESC, fl.id DESC
            `,params);
            return {ok:true,data};
        }catch(error){return {ok:false,error:error.message,data:[]};}
    });

    // =========================================================
    // --- REPORTES GENERALES ---
    // =========================================================
    ipcMain.handle('reportes:guardar-excel', async (event, payload={}) => {
        try {
            const nombre = String(payload.nombre || 'Reporte_RRHH').replace(/[^a-zA-Z0-9_-]/g,'_');
            const datos = Array.isArray(payload.datos) ? payload.datos : [];
            const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title:'Guardar reporte Excel', defaultPath:`${nombre}.xlsx`, filters:[{name:'Excel',extensions:['xlsx']}] });
            if (canceled || !filePath) return {ok:false,cancelado:true};
            const ws=XLSX.utils.json_to_sheet(datos); const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Reporte'); XLSX.writeFile(wb,filePath);
            await registrarAuditoria('Exportación Excel','Reportes',filePath); return {ok:true,filePath};
        } catch(error){ return {ok:false,error:error.message}; }
    });

    ipcMain.handle('reportes:guardar-pdf', async (event, payload={}) => {
        let win=null;
        try {
            const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title:'Guardar reporte PDF', defaultPath:`${String(payload.nombre||'Reporte_RRHH').replace(/[^a-zA-Z0-9_-]/g,'_')}.pdf`, filters:[{name:'PDF',extensions:['pdf']}] });
            if(canceled || !filePath) return {ok:false,cancelado:true};
            win=new BrowserWindow({show:false,webPreferences:{offscreen:true}});
            const html=String(payload.html||'');
            const logoDataUrl=obtenerLogoDataUrlPorEmpresaId(payload.empresaId);
            const encabezadoLogo=logoDataUrl?`<div style="text-align:right;margin-bottom:10px;"><img src="${logoDataUrl}" alt="Logotipo" style="width:56px;height:56px;object-fit:contain;"></div>`:'';
            await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Segoe UI,Arial,sans-serif;padding:28px;color:#1e293b}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left}th{background:#f1f5f9}</style></head><body>${encabezadoLogo}${html}</body></html>`));
            const pdf=await win.webContents.printToPDF({printBackground:true}); fs.writeFileSync(filePath,pdf);
            await registrarAuditoria('Exportación PDF','Reportes',filePath); return {ok:true,filePath};
        } catch(error){ return {ok:false,error:error.message}; }
        finally { if(win && !win.isDestroyed()) win.close(); }
    });

    ipcMain.handle('reportes:obtener-resumen-empresa', async (event, empresaId) => {
        try {
            const empleados = await dbAll(`
                SELECT e.id, e.num_empleado, e.nombre, 
                       COALESCE(e.apellido, '') as apellido, 
                       e.puesto, e.fecha_ingreso,
                       IFNULL(SUM(s.dias_restantes), 0) as dias_vacaciones_pendientes
                FROM empleados e
                LEFT JOIN saldos_vacaciones s ON e.id = s.empleado_id
                WHERE e.empresa_id = ? AND e.activo = 1
                GROUP BY e.id
                ORDER BY COALESCE(e.apellido, '') ASC
            `, [empresaId]);

            return { ok: true, data: empleados };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
    // V35 - Configuración general del módulo de Integración de Salarios: ejercicio
    // (año) sobre el que se calcula, salario mínimo del año anterior y % de incremento
    // de referencia (equivalentes a las celdas fijas "SM 2025" / "SM 2026 EN %" del
    // Excel "INTEGRADOS DEFINITIVOS"), editables porque cambian cada año. Se guardan en
    // configuracion_sistema como clave/valor; se migran automáticamente las claves
    // legadas sm_2025/sm_2026_pct de instalaciones previas al primer arranque.
    const CONFIG_SALARIOS_DEFAULT = { ejercicio: new Date().getFullYear(), sm_base: 278.80, incremento_pct: 13 };
    async function obtenerConfigSalariosInterno() {
        const filas = await dbAll(`SELECT clave, valor FROM configuracion_sistema WHERE clave IN ('salarios_ejercicio','salarios_sm_base','salarios_incremento_pct','sm_2025','sm_2026_pct')`);
        const mapa = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
        const ejercicioLegado = mapa.sm_2026_pct !== undefined ? 2026 : undefined;
        const ejercicio = Number.isFinite(Number(mapa.salarios_ejercicio)) ? Number(mapa.salarios_ejercicio)
            : (ejercicioLegado || CONFIG_SALARIOS_DEFAULT.ejercicio);
        const smBase = Number.isFinite(Number(mapa.salarios_sm_base)) ? Number(mapa.salarios_sm_base)
            : (Number.isFinite(Number(mapa.sm_2025)) ? Number(mapa.sm_2025) : CONFIG_SALARIOS_DEFAULT.sm_base);
        const incrementoPct = Number.isFinite(Number(mapa.salarios_incremento_pct)) ? Number(mapa.salarios_incremento_pct)
            : (Number.isFinite(Number(mapa.sm_2026_pct)) ? Number(mapa.sm_2026_pct) : CONFIG_SALARIOS_DEFAULT.incremento_pct);
        return { ejercicio, sm_base: smBase, incremento_pct: incrementoPct };
    }

    ipcMain.handle('salarios:obtener-config', async () => {
        try { return { ok: true, data: await obtenerConfigSalariosInterno() }; }
        catch (error) { return { ok: false, error: error.message }; }
    });

    ipcMain.handle('salarios:guardar-config', async (event, payload = {}) => {
        try {
            const actual = await obtenerConfigSalariosInterno();
            const ejercicio = payload.ejercicio !== undefined ? Number(payload.ejercicio) : actual.ejercicio;
            const smBase = payload.sm_base !== undefined ? Number(payload.sm_base) : actual.sm_base;
            const incrementoPct = payload.incremento_pct !== undefined ? Number(payload.incremento_pct) : actual.incremento_pct;
            if (!Number.isInteger(ejercicio) || ejercicio < 2000 || ejercicio > 2100) return { ok: false, error: 'El ejercicio no es válido.' };
            if (!Number.isFinite(smBase) || smBase < 0) return { ok: false, error: 'El salario mínimo no es válido.' };
            if (!Number.isFinite(incrementoPct)) return { ok: false, error: 'El % de incremento no es válido.' };
            await dbRun(`INSERT INTO configuracion_sistema (clave, valor) VALUES ('salarios_ejercicio', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [String(ejercicio)]);
            await dbRun(`INSERT INTO configuracion_sistema (clave, valor) VALUES ('salarios_sm_base', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [String(smBase)]);
            await dbRun(`INSERT INTO configuracion_sistema (clave, valor) VALUES ('salarios_incremento_pct', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [String(incrementoPct)]);
            await registrarAuditoria('Actualización de configuración', 'Integración de Salarios', `Ejercicio = ${ejercicio}, SM base = ${smBase}, incremento = ${incrementoPct}%`);
            return { ok: true, data: { ejercicio, sm_base: smBase, incremento_pct: incrementoPct } };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // V34 - Plantilla del módulo de Integración de Salarios: para cada empleado calcula,
    // igual que el Excel "INTEGRADOS DEFINITIVOS" / CONTPAQi, el Salario Diario Integrado
    // (SDI) a partir del Salario Diario (SD) y el factor de integración según antigüedad
    // (ver calcularFactorIntegracionSDI). El SDI guardado en empleados.salario_base (si
    // existe y es mayor a 0) se muestra como "SDI actual"; el calculado con la fórmula
    // legal se muestra como referencia para aplicar o corregir.
    ipcMain.handle('salarios:obtener-plantilla', async (event, payload = {}) => {
        try {
            const empresaId = payload && typeof payload === 'object' ? Number(payload.empresaId || 0) : Number(payload || 0);
            const where = ['e.activo = 1'];
            const params = [];
            if (empresaId) { where.push('e.empresa_id = ?'); params.push(empresaId); }
            const rows = await dbAll(`
                SELECT e.*, em.nombre AS empresa_nombre
                FROM empleados e
                LEFT JOIN empresas em ON em.id = e.empresa_id
                WHERE ${where.join(' AND ')}
                ORDER BY e.apellido ASC, e.nombre ASC
            `, params);
            const hoy = obtenerFechaLocal();
            const configSalarios = await obtenerConfigSalariosInterno();
            const data = descifrarCamposEmpleados(rows).map(emp => {
                const { aniosAntiguedad, diasVacaciones, primaVacacionalDias, factor } = calcularFactorIntegracionSDI(emp.fecha_ingreso, hoy);
                const salarioDiario = Number(emp.salario_diario || 0);
                const sdiActual = Number(emp.salario_base || 0);
                return {
                    ...emp,
                    anios_antiguedad_sdi: aniosAntiguedad,
                    dias_vacaciones_sdi: diasVacaciones,
                    dias_anio_sdi: 365,
                    dias_aguinaldo_sdi: SDI_DIAS_AGUINALDO,
                    prima_vacacional_dias_sdi: +primaVacacionalDias.toFixed(2),
                    factor_integracion: +factor.toFixed(4),
                    sdi_calculado: +(salarioDiario * factor).toFixed(2),
                    sdi_actual: sdiActual,
                    ejercicio: configSalarios.ejercicio,
                    sm_base: configSalarios.sm_base,
                    incremento_pct: configSalarios.incremento_pct,
                    salario_minimo_profesional: emp.salario_minimo_profesional != null ? Number(emp.salario_minimo_profesional) : null
                };
            });
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // V31/V34 - INTEGRACIÓN DE SALARIOS: aplica un incremento (o decremento) porcentual
    // sobre el salario diario fiscal de uno o varios empleados en una sola operación
    // transaccional, y actualiza también su Salario Diario Integrado (SDI/SBC) según el
    // factor de integración por antigüedad. El nuevo salario_diario/salario_base queda
    // disponible de inmediato para finiquitos, liquidaciones, aguinaldos, etc., porque
    // todos esos cálculos leen esas columnas de empleados.
    ipcMain.handle('salarios:aplicar-incremento', async (event, payload = {}) => {
        try {
            const cambios = Array.isArray(payload.cambios) ? payload.cambios : [];
            const porcentaje = Number(payload.porcentaje || 0);
            if (!cambios.length) return { ok: false, error: 'No hay empleados seleccionados.' };

            await dbRun('BEGIN TRANSACTION');
            try {
                let aplicados = 0;
                const porcentajesAplicados = [];
                for (const c of cambios) {
                    const id = Number(c.id);
                    const nuevoSalario = Number(c.nuevoSalario);
                    if (!id || !Number.isFinite(nuevoSalario) || nuevoSalario < 0) continue;
                    let nuevoSDI = Number(c.nuevoSDI);
                    if (!Number.isFinite(nuevoSDI) || nuevoSDI < 0) {
                        const empleado = await dbGet(`SELECT fecha_ingreso FROM empleados WHERE id=?`, [id]);
                        const { factor } = calcularFactorIntegracionSDI(empleado && empleado.fecha_ingreso, obtenerFechaLocal());
                        nuevoSDI = +(nuevoSalario * factor).toFixed(2);
                    }
                    const res = await dbRun(`UPDATE empleados SET salario_diario = ?, salario_base = ? WHERE id = ?`, [nuevoSalario, nuevoSDI, id]);
                    if (res.changes > 0) {
                        aplicados++;
                        const pctFila = Number(c.porcentaje);
                        if (Number.isFinite(pctFila)) porcentajesAplicados.push(pctFila);
                    }
                }
                await dbRun('COMMIT');
                // V34 - cada empleado puede llevar un % distinto (criterio del cliente,
                // p.ej. quienes ya ganan por encima del mínimo reciben un % menor), así
                // que la bitácora reporta el rango real aplicado en vez de un único %.
                let detallePct = `${porcentaje > 0 ? '+' : ''}${porcentaje}%`;
                if (porcentajesAplicados.length) {
                    const minPct = Math.min(...porcentajesAplicados), maxPct = Math.max(...porcentajesAplicados);
                    detallePct = minPct === maxPct ? `${minPct > 0 ? '+' : ''}${minPct}%` : `individual por empleado (${minPct}% a ${maxPct}%)`;
                }
                await registrarAuditoria('Incremento salarial aplicado', 'Integración de Salarios', `${aplicados} empleado(s) · ${detallePct} sobre salario diario y salario diario integrado`);
                return { ok: true, aplicados };
            } catch (errInner) {
                await dbRun('ROLLBACK');
                throw errInner;
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    // =========================================================
    // --- COMPLEMENTO CONTPAQI NÓMINAS ---
    // Exporta/importa datos de este sistema en Excel con encabezados
    // claros en español, pensados para mapearse en el asistente de
    // importación de CONTPAQi Nóminas (no existe un layout fijo oficial
    // que replicar, así que no se inventa una plantilla de posiciones).
    // =========================================================
    ipcMain.handle('contpaqi:datos-empleados', async (event, payload = {}) => {
        try {
            const empresaId = payload && payload.empresaId ? Number(payload.empresaId) : null;
            const where = ['e.activo = 1'];
            const params = [];
            if (empresaId) { where.push('e.empresa_id = ?'); params.push(empresaId); }
            const rows = await dbAll(`
                SELECT e.num_empleado, e.nombre, e.apellido, e.rfc_enc, e.curp_enc, e.nss_enc, e.puesto,
                       e.fecha_ingreso, e.salario_diario, em.nombre AS empresa_nombre
                FROM empleados e
                LEFT JOIN empresas em ON em.id = e.empresa_id
                WHERE ${where.join(' AND ')}
                ORDER BY e.apellido ASC, e.nombre ASC
            `, params);
            const data = rows.map(r => ({
                'Código': r.num_empleado || '',
                'Nombre(s)': r.nombre || '',
                'Apellidos': r.apellido || '',
                'RFC': descifrarCampoSensible(r.rfc_enc) || '',
                'CURP': descifrarCampoSensible(r.curp_enc) || '',
                'NSS': descifrarCampoSensible(r.nss_enc) || '',
                'Puesto': r.puesto || '',
                'Fecha Ingreso': r.fecha_ingreso || '',
                'Salario Diario': Number(r.salario_diario || 0),
                'Empresa': r.empresa_nombre || ''
            }));
            await registrarAuditoria('Exportación CONTPAQi', 'CONTPAQi', `Catálogo de empleados · ${data.length} registro(s)`);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message, data: [] };
        }
    });

    ipcMain.handle('contpaqi:datos-movimientos', async (event, payload = {}) => {
        try {
            const empresaId = payload && payload.empresaId ? Number(payload.empresaId) : null;
            const fechaInicio = String((payload && payload.fechaInicio) || '').trim();
            const fechaFin = String((payload && payload.fechaFin) || '').trim();
            if (!fechaInicio || !fechaFin) {
                return { ok: false, error: 'Indica un rango de fechas (inicio y fin) antes de exportar.', data: [] };
            }

            const whereInc = ['(i.cancelada IS NULL OR i.cancelada = 0)', 'date(i.fecha_inicio) <= date(?)', 'date(i.fecha_fin) >= date(?)'];
            const paramsInc = [fechaFin, fechaInicio];
            if (empresaId) { whereInc.push('e.empresa_id = ?'); paramsInc.push(empresaId); }

            const whereMov = ["date(m.fecha_movimiento) BETWEEN date(?) AND date(?)"];
            const paramsMov = [fechaInicio, fechaFin];
            if (empresaId) { whereMov.push('e.empresa_id = ?'); paramsMov.push(empresaId); }

            // V-fix: faltaba unir solicitudes_vacaciones (los goces de vacaciones
            // aprobados) — sin esto el export "omitía" el tipo de movimiento más
            // común para nómina: los días de vacaciones realmente tomados.
            const whereSol = ["(s.estado IS NULL OR s.estado != 'Cancelada')", 'date(s.fecha_inicio) <= date(?)', 'date(s.fecha_fin) >= date(?)'];
            const paramsSol = [fechaFin, fechaInicio];
            if (empresaId) { whereSol.push('e.empresa_id = ?'); paramsSol.push(empresaId); }

            const rows = await dbAll(`
                SELECT e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre,
                       i.tipo_incidencia AS tipo, i.fecha_inicio, i.fecha_fin, i.dias,
                       NULL AS monto, i.observaciones, i.folio
                FROM incidencias i
                JOIN empleados e ON e.id = i.empleado_id
                WHERE ${whereInc.join(' AND ')}

                UNION ALL

                SELECT e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre,
                       m.tipo_movimiento AS tipo, m.fecha_movimiento AS fecha_inicio, m.fecha_movimiento AS fecha_fin, m.dias,
                       m.monto_pagado AS monto, m.observaciones, NULL AS folio
                FROM movimientos_vacaciones m
                JOIN empleados e ON e.id = m.empleado_id
                WHERE ${whereMov.join(' AND ')}

                UNION ALL

                SELECT e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre,
                       'GOCE' AS tipo, s.fecha_inicio, s.fecha_fin, s.dias_solicitados AS dias,
                       NULL AS monto, s.observaciones, NULL AS folio
                FROM solicitudes_vacaciones s
                JOIN empleados e ON e.id = s.empleado_id
                WHERE ${whereSol.join(' AND ')}

                ORDER BY fecha_inicio ASC
            `, [...paramsInc, ...paramsMov, ...paramsSol]);

            const data = rows.map(r => ({
                'Código Empleado': r.num_empleado || '',
                'Nombre': r.nombre || '',
                'Tipo de Movimiento': r.tipo || '',
                'Fecha Inicio': r.fecha_inicio || '',
                'Fecha Fin': r.fecha_fin || '',
                'Días': Number(r.dias || 0),
                'Monto': r.monto != null ? Number(r.monto) : '',
                'Observaciones': r.observaciones || '',
                'Folio': r.folio || ''
            }));
            await registrarAuditoria('Exportación CONTPAQi', 'CONTPAQi', `Movimientos/incidencias ${fechaInicio} a ${fechaFin} · ${data.length} registro(s)`);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message, data: [] };
        }
    });

    ipcMain.handle('contpaqi:datos-finiquitos', async (event, payload = {}) => {
        try {
            const empresaId = payload && payload.empresaId ? Number(payload.empresaId) : null;
            const fechaInicio = String((payload && payload.fechaInicio) || '').trim();
            const fechaFin = String((payload && payload.fechaFin) || '').trim();
            const where = [];
            const params = [];
            if (empresaId) { where.push('e.empresa_id = ?'); params.push(empresaId); }
            if (fechaInicio) { where.push('date(fl.fecha_baja) >= date(?)'); params.push(fechaInicio); }
            if (fechaFin) { where.push('date(fl.fecha_baja) <= date(?)'); params.push(fechaFin); }
            const rows = await dbAll(`
                SELECT fl.*, e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre
                FROM finiquitos_liquidaciones fl
                JOIN empleados e ON e.id = fl.empleado_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY date(fl.fecha_baja) DESC, fl.id DESC
            `, params);
            const data = rows.map(r => ({
                'Código Empleado': r.num_empleado || '',
                'Nombre': r.nombre || '',
                'Fecha Baja': r.fecha_baja || '',
                'Tipo de Baja': r.tipo_baja || '',
                'Sueldo Pendiente': Number(r.monto_sueldo_pendiente || 0),
                'Aguinaldo Proporcional': Number(r.monto_aguinaldo_proporcional || 0),
                'Vacaciones Proporcionales': Number(r.monto_vacaciones_proporcional || 0),
                'Prima Vacacional': Number(r.monto_prima_vacacional || 0),
                'Prima de Antigüedad': Number(r.monto_prima_antiguedad || 0),
                'Indemnización': Number(r.monto_indemnizacion || 0),
                'ISR Retenido': Number(r.isr_retenido || 0),
                'Total Neto (Fiscal)': Number(r.total_fiscal_neto || r.total_pagar || 0),
                'Total Neto (Real)': Number(r.total_real_neto || 0)
            }));
            await registrarAuditoria('Exportación CONTPAQi', 'CONTPAQi', `Finiquitos/liquidaciones · ${data.length} registro(s)`);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message, data: [] };
        }
    });

    ipcMain.handle('contpaqi:datos-movimientos-imss', async (event, payload = {}) => {
        try {
            const empresaId = payload && payload.empresaId ? Number(payload.empresaId) : null;
            const fechaInicio = String((payload && payload.fechaInicio) || '').trim();
            const fechaFin = String((payload && payload.fechaFin) || '').trim();
            if (!fechaInicio || !fechaFin) {
                return { ok: false, error: 'Indica un rango de fechas (inicio y fin) antes de exportar.', data: [] };
            }

            const whereAlta = ['date(e.fecha_ingreso) BETWEEN date(?) AND date(?)'];
            const paramsAlta = [fechaInicio, fechaFin];
            if (empresaId) { whereAlta.push('e.empresa_id = ?'); paramsAlta.push(empresaId); }

            const whereBaja = ["e.fecha_baja IS NOT NULL", 'date(e.fecha_baja) BETWEEN date(?) AND date(?)'];
            const paramsBaja = [fechaInicio, fechaFin];
            if (empresaId) { whereBaja.push('e.empresa_id = ?'); paramsBaja.push(empresaId); }

            const rows = await dbAll(`
                SELECT e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre, e.rfc_enc, e.nss_enc, e.puesto,
                       e.salario_diario, 'ALTA' AS tipo, e.fecha_ingreso AS fecha
                FROM empleados e
                WHERE ${whereAlta.join(' AND ')}

                UNION ALL

                SELECT e.num_empleado, (e.nombre || ' ' || e.apellido) AS nombre, e.rfc_enc, e.nss_enc, e.puesto,
                       e.salario_diario, 'BAJA' AS tipo, e.fecha_baja AS fecha
                FROM empleados e
                WHERE ${whereBaja.join(' AND ')}

                ORDER BY fecha ASC
            `, [...paramsAlta, ...paramsBaja]);

            const data = rows.map(r => ({
                'Código': r.num_empleado || '',
                'Nombre': r.nombre || '',
                'RFC': descifrarCampoSensible(r.rfc_enc) || '',
                'NSS': descifrarCampoSensible(r.nss_enc) || '',
                'Puesto': r.puesto || '',
                'Movimiento': r.tipo,
                'Fecha': r.fecha || '',
                'Salario Diario': Number(r.salario_diario || 0)
            }));
            await registrarAuditoria('Exportación CONTPAQi', 'CONTPAQi', `Altas/bajas IMSS ${fechaInicio} a ${fechaFin} · ${data.length} registro(s)`);
            return { ok: true, data };
        } catch (error) {
            return { ok: false, error: error.message, data: [] };
        }
    });

    // Validación de RFC/CURP/NSS: mismos criterios que ya usa cargar-empleados-excel,
    // pero aquí solo advierten (no bloquean) porque, a diferencia del alta masiva,
    // aquí también se actualizan empleados existentes con datos parciales.
    const RFC_REGEX = /^[A-Z0-9]{12,13}$/;
    const NSS_REGEX = /^\d{11}$/;

    // Parsea el Excel de catálogo de empleados de CONTPAQi con detección flexible
    // de columnas (igual criterio que isr:importar-tabla-mensual) y clasifica cada
    // fila como ALTA/ACTUALIZACIÓN/INVÁLIDA sin tocar la base de datos todavía.
    async function leerYClasificarEmpleadosContpaqi(filePath, empId, formatoFecha) {
        const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        const num = v => {
            if (v == null || v === '') return 0;
            const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
            return Number.isFinite(n) ? n : 0;
        };

        const ALIAS = {
            codigo: ['codigo', 'cod', 'no', 'num', 'num empleado', 'numero de empleado', 'clave'],
            nombre: ['nombre', 'nombres', 'nombre(s)'],
            apellido: ['apellido', 'apellidos'],
            rfc: ['rfc'],
            curp: ['curp'],
            nss: ['nss', 'numero de seguridad social'],
            puesto: ['puesto', 'cargo'],
            fechaIngreso: ['fecha ingreso', 'fecha de ingreso', 'fecha alta', 'fecha de alta'],
            salario: ['salario diario', 'sueldo diario', 'salario', 'sueldo']
        };
        const detectarColumna = (headerRow, aliases) => {
            for (let i = 0; i < headerRow.length; i++) {
                const h = norm(headerRow[i]);
                if (aliases.some(a => h === a)) return i;
            }
            return -1;
        };

        const workbook = XLSX.readFile(filePath);
        let filas = [];
        for (const sheetName of workbook.SheetNames) {
            const matriz = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: false });
            let headerIdx = -1, cols = null;
            for (let i = 0; i < Math.min(matriz.length, 25); i++) {
                const fila = matriz[i] || [];
                const idxNombre = detectarColumna(fila, ALIAS.nombre);
                const idxRfc = detectarColumna(fila, ALIAS.rfc);
                if (idxNombre !== -1 || idxRfc !== -1) {
                    headerIdx = i;
                    cols = {
                        codigo: detectarColumna(fila, ALIAS.codigo),
                        nombre: idxNombre,
                        apellido: detectarColumna(fila, ALIAS.apellido),
                        rfc: idxRfc,
                        curp: detectarColumna(fila, ALIAS.curp),
                        nss: detectarColumna(fila, ALIAS.nss),
                        puesto: detectarColumna(fila, ALIAS.puesto),
                        fechaIngreso: detectarColumna(fila, ALIAS.fechaIngreso),
                        salario: detectarColumna(fila, ALIAS.salario)
                    };
                    break;
                }
            }
            if (headerIdx === -1) continue;
            for (let i = headerIdx + 1; i < matriz.length; i++) {
                const fila = matriz[i] || [];
                if (fila.every(c => c == null || String(c).trim() === '')) continue;
                filas.push({
                    codigo: cols.codigo !== -1 ? String(fila[cols.codigo] || '').trim() : '',
                    nombre: cols.nombre !== -1 ? String(fila[cols.nombre] || '').trim() : '',
                    apellido: cols.apellido !== -1 ? String(fila[cols.apellido] || '').trim() : '',
                    rfc: cols.rfc !== -1 ? String(fila[cols.rfc] || '').trim().toUpperCase() : '',
                    curp: cols.curp !== -1 ? String(fila[cols.curp] || '').trim() : '',
                    nss: cols.nss !== -1 ? String(fila[cols.nss] || '').trim() : '',
                    puesto: cols.puesto !== -1 ? String(fila[cols.puesto] || '').trim() : '',
                    fechaIngresoRaw: cols.fechaIngreso !== -1 ? fila[cols.fechaIngreso] : null,
                    fechaIngreso: '',
                    salario: cols.salario !== -1 ? num(fila[cols.salario]) : 0
                });
            }
        }

        // Antes de resolver fechas o consultar la BD: si hay texto genuinamente
        // ambiguo y no se indicó el formato, se detiene aquí para preguntarlo.
        if (!formatoFecha) {
            const ejemplosFecha = [];
            for (const f of filas) {
                const info = analizarFechaTexto(f.fechaIngresoRaw);
                if (info.tipo === 'ambigua' && !ejemplosFecha.includes(info.texto)) {
                    ejemplosFecha.push(info.texto);
                    if (ejemplosFecha.length >= 3) break;
                }
            }
            if (ejemplosFecha.length) {
                return { requiereFormatoFecha: true, ejemplos: ejemplosFecha };
            }
        }

        for (const f of filas) {
            f.fechaIngreso = f.fechaIngresoRaw != null ? resolverFechaConFormato(f.fechaIngresoRaw, formatoFecha) : '';
            delete f.fechaIngresoRaw;
        }

        for (const f of filas) {
            const avisos = [];
            if (f.rfc && !RFC_REGEX.test(f.rfc)) avisos.push('RFC con formato inusual');
            if (f.nss && !NSS_REGEX.test(f.nss)) avisos.push('NSS con formato inusual (debe tener 11 dígitos)');

            if (!f.nombre && !f.rfc) {
                f.accion = 'INVALIDA';
                f.motivo = 'Sin nombre ni RFC.';
                continue;
            }

            let existente = null;
            if (f.rfc) existente = await dbGet(`SELECT id FROM empleados WHERE rfc_idx = ? LIMIT 1`, [indiceCiegoCampo(f.rfc)]);
            if (!existente && f.codigo) existente = await dbGet(`SELECT id FROM empleados WHERE empresa_id = ? AND UPPER(TRIM(num_empleado)) = ? LIMIT 1`, [empId, f.codigo.toUpperCase()]);

            if (existente) {
                f.accion = 'ACTUALIZACION';
                f.empleadoId = existente.id;
            } else if (!f.nombre) {
                f.accion = 'INVALIDA';
                f.motivo = 'Falta el nombre para dar de alta al empleado.';
            } else {
                f.accion = 'ALTA';
            }
            if (avisos.length) f.motivo = avisos.join(' · ');
        }

        return filas;
    }

    ipcMain.handle('contpaqi:leer-empleados-excel', async (event, payload) => {
        try {
            const p = (payload && typeof payload === 'object') ? payload : { empresaId: payload };
            const empId = Number(p.empresaId || 0);
            const formatoFecha = p.formatoFecha || null;
            if (!empId) {
                return { ok: false, error: 'Debes seleccionar una empresa antes de importar.' };
            }

            let rutaArchivo = p.filePath;
            if (!rutaArchivo) {
                const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                    title: 'Seleccionar catálogo de empleados de CONTPAQi (.xls / .xlsx)',
                    filters: [{ name: 'Hojas de Cálculo', extensions: ['xls', 'xlsx'] }],
                    properties: ['openFile']
                });
                if (canceled || filePaths.length === 0) {
                    return { ok: false, cancelado: true };
                }
                rutaArchivo = filePaths[0];
            }

            const resultado = await leerYClasificarEmpleadosContpaqi(rutaArchivo, empId, formatoFecha);
            if (!Array.isArray(resultado)) {
                // Señal de fecha ambigua: se detiene antes de clasificar/consultar la BD.
                return { ok: false, requiereFormatoFecha: true, filePath: rutaArchivo, ejemplos: resultado.ejemplos };
            }

            const filas = resultado;
            if (filas.length === 0) {
                return { ok: false, error: 'No se reconoció ninguna fila de empleados en el archivo (revisa que tenga columnas de Nombre y/o RFC).' };
            }

            const resumen = {
                altas: filas.filter(f => f.accion === 'ALTA').length,
                actualizaciones: filas.filter(f => f.accion === 'ACTUALIZACION').length,
                invalidas: filas.filter(f => f.accion === 'INVALIDA').length
            };
            return { ok: true, archivo: rutaArchivo, filas, resumen };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('contpaqi:confirmar-importacion-empleados', async (event, payload = {}) => {
        try {
            const empId = Number(payload.empresaId || 0);
            const filas = Array.isArray(payload.filas) ? payload.filas : [];
            if (!empId) return { ok: false, error: 'Falta la empresa de destino.' };
            if (!filas.length) return { ok: false, error: 'No hay filas para importar.' };

            let creados = 0, actualizados = 0, sinCambios = 0;
            const errores = [];

            await dbRun('BEGIN TRANSACTION;');
            try {
                for (let i = 0; i < filas.length; i++) {
                    const f = filas[i];
                    if (!f.nombre && !f.rfc) {
                        errores.push(`Fila ${i + 1}: sin nombre ni RFC, se omitió.`);
                        continue;
                    }

                    let existente = null;
                    if (f.rfc) existente = await dbGet(`SELECT * FROM empleados WHERE rfc_idx = ? LIMIT 1`, [indiceCiegoCampo(f.rfc)]);
                    if (!existente && f.codigo) existente = await dbGet(`SELECT * FROM empleados WHERE empresa_id = ? AND UPPER(TRIM(num_empleado)) = ? LIMIT 1`, [empId, f.codigo.toUpperCase()]);

                    if (existente) {
                        const cambios = {};
                        if (f.nombre) cambios.nombre = f.nombre;
                        if (f.apellido) cambios.apellido = f.apellido;
                        if (f.curp) cambios.curp_enc = cifrarCampoSensible(f.curp);
                        if (f.nss) { cambios.nss_enc = cifrarCampoSensible(f.nss); cambios.nss_idx = indiceCiegoCampo(f.nss); }
                        if (f.puesto) cambios.puesto = f.puesto;
                        if (f.fechaIngreso) cambios.fecha_ingreso = f.fechaIngreso;
                        if (f.salario > 0) cambios.salario_diario = f.salario;
                        if (f.codigo) cambios.num_empleado = f.codigo;

                        const campos = Object.keys(cambios);
                        if (campos.length === 0) { sinCambios++; continue; }
                        await dbRun(
                            `UPDATE empleados SET ${campos.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
                            [...campos.map(c => cambios[c]), existente.id]
                        );
                        actualizados++;
                    } else {
                        if (!f.nombre) {
                            errores.push(`Fila ${i + 1}: falta el nombre para dar de alta al empleado.`);
                            continue;
                        }
                        const fechaIngreso = f.fechaIngreso || obtenerFechaLocal();
                        const resEmp = await dbRun(`
                            INSERT INTO empleados (empresa_id, num_empleado, nombre, apellido, puesto, fecha_ingreso, salario_diario, curp_enc, rfc_enc, rfc_idx, nss_enc, nss_idx, activo)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                        `, [empId, f.codigo, f.nombre, f.apellido, f.puesto || 'General', fechaIngreso, f.salario, cifrarCampoSensible(f.curp), cifrarCampoSensible(f.rfc), indiceCiegoCampo(f.rfc), cifrarCampoSensible(f.nss), indiceCiegoCampo(f.nss)]);
                        await generarSaldosVacacionesSiNoExisten(resEmp.lastID, fechaIngreso);
                        creados++;
                    }
                }
                await dbRun('COMMIT;');
            } catch (errTx) {
                await dbRun('ROLLBACK;');
                throw errTx;
            }

            await registrarAuditoria('Importación CONTPAQi', 'CONTPAQi', `${payload.archivo || 'catálogo'} · ${creados} alta(s), ${actualizados} actualización(es)`);
            return { ok: true, creados, actualizados, sinCambios, totalErrores: errores.length, detallesErrores: errores };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

}
// ==========================================
// ACTUALIZACIONES AUTOMÁTICAS (GitHub Releases)
// ==========================================
// El repositorio de GitHub es público, así que electron-updater puede consultar
// y descargar los releases sin necesitar credenciales. La configuración del feed
// (owner/repo) viaja empaquetada en app-update.yml gracias a la sección "publish"
// de package.json — no hace falta indicarla de nuevo aquí.
function formatearNotasVersion(releaseNotes) {
    if (!releaseNotes) return '';
    if (typeof releaseNotes === 'string') return releaseNotes;
    if (Array.isArray(releaseNotes)) {
        return releaseNotes.map(n => `• ${n.note || ''}`.trim()).filter(Boolean).join('\n');
    }
    return '';
}

function configurarActualizacionesAutomaticas() {
    if (!app.isPackaged) return; // En desarrollo no hay artefactos publicados que consultar.

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', async (info) => {
        const notas = formatearNotasVersion(info.releaseNotes);
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Actualización disponible',
            message: 'Actualización Disponible, cambios implementados',
            detail: `Nueva versión: ${info.version}${notas ? `\n\n${notas}` : ''}\n\n¿Deseas descargarla e instalarla ahora? La aplicación se cerrará y se reiniciará automáticamente al terminar.`,
            buttons: ['Descargar e instalar', 'Más tarde'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (response === 0) {
            autoUpdater.downloadUpdate().catch(error => {
                dialog.showErrorBox('Error al descargar la actualización', error.message);
            });
        }
    });

    autoUpdater.on('update-downloaded', () => {
        autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', (error) => {
        console.error('Error al buscar actualizaciones:', error.message);
    });

    autoUpdater.checkForUpdates().catch(error => {
        console.error('No se pudo consultar actualizaciones:', error.message);
    });
}

// ==========================================
// 5. VENTANA PRINCIPAL Y CICLO DE VIDA
// ==========================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 600,
        title: "Sistema Integrado de RRHH - Control Multi-Empresa",
        icon: LOGO_APP_DEFAULT,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
    try {
        abrirDB();
        await crearTablas();
        registrarHandlersIPC();
        createWindow();
        configurarActualizacionesAutomaticas();
    } catch (error) {
        console.error('Error crítico al iniciar la aplicación:', error);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (db) db.close();
        app.quit();
    }
});
ipcMain.handle('incidencias:obtener-pdf', async (event, id) => {
  try {
    const row = db.prepare(`
      SELECT i.*, e.nombre, e.apellido, e.num_empleado, e.rfc_enc, e.nss_enc,
             em.nombre AS empresa_nombre
      FROM incidencias i
      JOIN empleados e ON e.id=i.empleado_id
      JOIN empresas em ON em.id=e.empresa_id
      WHERE i.id=?
    `).get(id);
    if (!row) throw new Error('Incidencia no encontrada');
    row.rfc = descifrarCampoSensible(row.rfc_enc);
    row.nss = descifrarCampoSensible(row.nss_enc);
    const saldos = db.prepare(`
      SELECT ciclo,dias_otorgados,dias_consumidos,dias_disponibles,fecha_disponible
      FROM saldos_vacaciones WHERE empleado_id=? ORDER BY fecha_disponible,ciclo
    `).all(row.empleado_id);
    const {BrowserWindow,dialog}=require('electron');
    const {writeFile,mkdir}=require('fs').promises;
    const {join}=require('path'); const {tmpdir}=require('os');
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const now=new Date();
    const disp=saldos.filter(s=>!s.fecha_disponible||new Date(s.fecha_disponible)<=now);
    const bloq=saldos.filter(s=>s.fecha_disponible&&new Date(s.fecha_disponible)>now);
    const total=a=>a.reduce((x,s)=>x+Number(s.dias_disponibles||0),0);
    const rows=a=>a.map(s=>`<tr><td>${esc(s.ciclo)}</td><td>${esc(s.dias_otorgados)}</td><td>${esc(s.dias_consumidos)}</td><td>${esc(s.dias_disponibles)}</td><td>${esc(s.fecha_disponible||'')}</td></tr>`).join('');
    const doc=`<!doctype html><html><meta charset="utf-8"><style>
      body{font-family:Arial;padding:28px}h1{font-size:22px}h2{font-size:16px;margin-top:22px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.box{border:1px solid #ddd;padding:10px;border-radius:6px}
      table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #ddd;padding:6px;font-size:10px}th{background:#eee}
      </style><h1>Incidencia ${esc(row.folio||row.id)}</h1>
      <div class="grid"><div class="box"><b>Empleado</b><br>${esc(row.nombre)} ${esc(row.apellido)}</div>
      <div class="box"><b>Número</b><br>${esc(row.num_empleado)}</div><div class="box"><b>Empresa</b><br>${esc(row.empresa_nombre)}</div>
      <div class="box"><b>RFC / NSS</b><br>${esc(row.rfc)} / ${esc(row.nss)}</div>
      <div class="box"><b>Fecha inicio</b><br>${esc(row.fecha_inicio)}</div><div class="box"><b>Fecha fin</b><br>${esc(row.fecha_fin||row.fecha_inicio)}</div>
      <div class="box"><b>Días</b><br>${esc(row.dias)}</div><div class="box"><b>Estado</b><br>${row.cancelada?'Cancelada':'Activa'}</div></div>
      <h2>Motivo</h2><div class="box">${esc(row.motivo)}</div>
      <h2>Saldo posterior a la incidencia</h2><p><b>Disponibles:</b> ${total(disp)} &nbsp;&nbsp; <b>Bloqueados:</b> ${total(bloq)}</p>
      <h2>Ciclos disponibles</h2><table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha</th></tr>${rows(disp)}</table>
      <h2>Ciclos bloqueados</h2><table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha</th></tr>${rows(bloq)}</table>`;
    const dir=join(tmpdir(),'rrhh-control'); await mkdir(dir,{recursive:true});
    const f=join(dir,`incidencia_${row.id}.html`); await writeFile(f,doc,'utf8');
    const win=new BrowserWindow({show:false}); await win.loadFile(f);
    const pdf=await win.webContents.printToPDF({printBackground:true,pageSize:'A4'}); win.destroy();
    const save=await dialog.showSaveDialog({title:'Guardar incidencia en PDF',defaultPath:`Incidencia_${row.folio||row.id}.pdf`,filters:[{name:'PDF',extensions:['pdf']}]});
    if(save.canceled) return {ok:false,canceled:true}; await writeFile(save.filePath,pdf); return {ok:true,filePath:save.filePath};
  } catch(e){ return {ok:false,error:e.message}; }
});

/* V8 - exportación PDF de incidencia con relación de saldo */
ipcMain.handle('incidencias:obtener-pdf-v8', async (event, id) => {
  try {
    const incidencia = db.prepare(`
      SELECT i.*, e.nombre, e.apellido, e.num_empleado, e.rfc_enc, e.nss_enc,
             em.nombre AS empresa_nombre
      FROM incidencias i
      JOIN empleados e ON e.id = i.empleado_id
      JOIN empresas em ON em.id = e.empresa_id
      WHERE i.id = ?
    `).get(id);
    if (!incidencia) throw new Error('Incidencia no encontrada.');
    incidencia.rfc = descifrarCampoSensible(incidencia.rfc_enc);
    incidencia.nss = descifrarCampoSensible(incidencia.nss_enc);

    const saldos = db.prepare(`
      SELECT ciclo, dias_otorgados, dias_consumidos, dias_disponibles, fecha_disponible
      FROM saldos_vacaciones
      WHERE empleado_id = ?
      ORDER BY fecha_disponible ASC, ciclo ASC
    `).all(incidencia.empleado_id);

    const { BrowserWindow, dialog } = require('electron');
    const { promises: fs } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));

    const hoy = new Date();
    const disponibles = saldos.filter(s => !s.fecha_disponible || new Date(s.fecha_disponible) <= hoy);
    const bloqueados = saldos.filter(s => s.fecha_disponible && new Date(s.fecha_disponible) > hoy);
    const suma = arr => arr.reduce((n,s) => n + Number(s.dias_disponibles || 0), 0);
    const filas = arr => arr.map(s => `
      <tr>
        <td>${esc(s.ciclo)}</td><td>${esc(s.dias_otorgados)}</td>
        <td>${esc(s.dias_consumidos)}</td><td>${esc(s.dias_disponibles)}</td>
        <td>${esc(s.fecha_disponible || '')}</td>
      </tr>`).join('');

    const documento = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      body{font-family:Arial,sans-serif;padding:28px;color:#222}
      h1{font-size:22px}h2{font-size:16px;margin-top:22px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
      .box{border:1px solid #ddd;border-radius:7px;padding:10px}
      .totales{display:flex;gap:10px}.total{flex:1;border:1px solid #ddd;padding:12px;text-align:center;border-radius:7px}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th,td{border:1px solid #ddd;padding:6px;font-size:10px;text-align:left}
      th{background:#f2f2f2}
    </style></head><body>
      <h1>Incidencia ${esc(incidencia.folio || incidencia.id)}</h1>
      <div class="grid">
        <div class="box"><b>Empleado</b><br>${esc(incidencia.nombre)} ${esc(incidencia.apellido)}</div>
        <div class="box"><b>Número de empleado</b><br>${esc(incidencia.num_empleado)}</div>
        <div class="box"><b>Empresa</b><br>${esc(incidencia.empresa_nombre)}</div>
        <div class="box"><b>RFC / NSS</b><br>${esc(incidencia.rfc)} / ${esc(incidencia.nss)}</div>
        <div class="box"><b>Fecha inicial</b><br>${esc(incidencia.fecha_inicio)}</div>
        <div class="box"><b>Fecha final</b><br>${esc(incidencia.fecha_fin || incidencia.fecha_inicio)}</div>
        <div class="box"><b>Días descontados</b><br>${esc(incidencia.dias)}</div>
        <div class="box"><b>Estado</b><br>${incidencia.cancelada ? 'Cancelada' : 'Activa'}</div>
      </div>
      <h2>Motivo</h2><div class="box">${esc(incidencia.motivo)}</div>
      <h2>Saldo posterior a la incidencia</h2>
      <div class="totales">
        <div class="total"><b>Días disponibles</b><br>${suma(disponibles)}</div>
        <div class="total"><b>Días bloqueados</b><br>${suma(bloqueados)}</div>
      </div>
      <h2>Detalle de días disponibles</h2>
      <table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha disponible</th></tr>
      ${filas(disponibles)}</table>
      <h2>Detalle de días bloqueados</h2>
      <table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha disponible</th></tr>
      ${filas(bloqueados)}</table>
    </body></html>`;

    const dir = join(tmpdir(), 'rrhh-control');
    await fs.mkdir(dir, {recursive:true});
    const temp = join(dir, `incidencia_${incidencia.id}_v8.html`);
    await fs.writeFile(temp, documento, 'utf8');

    const win = new BrowserWindow({show:false});
    await win.loadFile(temp);
    const pdf = await win.webContents.printToPDF({printBackground:true, pageSize:'A4'});
    win.destroy();

    const save = await dialog.showSaveDialog({
      title:'Guardar incidencia en PDF',
      defaultPath:`Incidencia_${incidencia.folio || incidencia.id}.pdf`,
      filters:[{name:'PDF', extensions:['pdf']}]
    });
    if (save.canceled || !save.filePath) return {ok:false,canceled:true};
    await fs.writeFile(save.filePath, pdf);
    return {ok:true,filePath:save.filePath};
  } catch (error) {
    return {ok:false,error:error.message};
  }
});

/* V11 - exportación PDF de incidencia */
ipcMain.handle('incidencias:exportar-pdf-v11', async (event, incidenciaId) => {
  try {
    const id = Number(incidenciaId);
    if (!Number.isInteger(id)) throw new Error('ID de incidencia inválido.');

    const info = db.prepare(`
      SELECT i.*,
             e.nombre AS empleado_nombre,
             e.apellido AS empleado_apellido,
             e.num_empleado,
             e.rfc_enc,
             e.nss_enc,
             em.id AS empresa_id_logo,
             em.nombre AS empresa_nombre
      FROM incidencias i
      LEFT JOIN empleados e ON e.id = i.empleado_id
      LEFT JOIN empresas em ON em.id = e.empresa_id
      WHERE i.id = ?
    `).get(id);

    if (!info) throw new Error('No se encontró la incidencia seleccionada.');
    info.rfc = descifrarCampoSensible(info.rfc_enc);
    info.nss = descifrarCampoSensible(info.nss_enc);

    let saldos = [];
    try {
      saldos = db.prepare(`
        SELECT ciclo, dias_otorgados, dias_consumidos, dias_disponibles, fecha_disponible
        FROM saldos_vacaciones
        WHERE empleado_id = ?
        ORDER BY fecha_disponible ASC, ciclo ASC
      `).all(info.empleado_id);
    } catch (_) {
      // Compatibilidad si la versión instalada utiliza otra estructura de saldos.
      saldos = [];
    }

    const { BrowserWindow, dialog } = require('electron');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));

    const disponibles = saldos.filter(s => !s.fecha_disponible || new Date(s.fecha_disponible) <= new Date());
    const bloqueados = saldos.filter(s => s.fecha_disponible && new Date(s.fecha_disponible) > new Date());
    const total = a => a.reduce((n,s) => n + Number(s.dias_disponibles || 0), 0);

    const filas = a => a.length
      ? a.map(s => `<tr><td>${esc(s.ciclo)}</td><td>${esc(s.dias_otorgados)}</td><td>${esc(s.dias_consumidos)}</td><td>${esc(s.dias_disponibles)}</td><td>${esc(s.fecha_disponible || '')}</td></tr>`).join('')
      : '<tr><td colspan="5">Sin registros</td></tr>';

    const logoDataUrl = obtenerLogoDataUrlPorEmpresaId(info.empresa_id_logo);

    const htmlPdf = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;padding:28px;color:#222}
h1{font-size:22px;margin-bottom:20px}h2{font-size:16px;margin-top:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.box{border:1px solid #d7d7d7;border-radius:7px;padding:10px}
.saldos{display:flex;gap:12px;margin:10px 0 18px}
.saldo{flex:1;border:1px solid #d7d7d7;border-radius:7px;padding:12px;text-align:center}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #ddd;padding:7px;font-size:10px}
th{background:#f0f0f0}
.doc-header{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.doc-header img{width:48px;height:48px;object-fit:contain}
</style></head><body>
<div class="doc-header">${logoDataUrl ? `<img src="${logoDataUrl}" alt="Logotipo">` : ''}<h1 style="margin:0;">Incidencia ${esc(info.folio || info.id)}</h1></div>
<div class="grid">
<div class="box"><b>Empleado</b><br>${esc(info.empleado_nombre)} ${esc(info.empleado_apellido)}</div>
<div class="box"><b>Número de empleado</b><br>${esc(info.num_empleado)}</div>
<div class="box"><b>Empresa</b><br>${esc(info.empresa_nombre)}</div>
<div class="box"><b>RFC / NSS</b><br>${esc(info.rfc)} / ${esc(info.nss)}</div>
<div class="box"><b>Fecha de incidencia</b><br>${esc(info.fecha_inicio || info.fecha_incidencia || '')}</div>
<div class="box"><b>Fecha final</b><br>${esc(info.fecha_fin || info.fecha_inicio || '')}</div>
<div class="box"><b>Días descontados</b><br>${esc(info.dias)}</div>
<div class="box"><b>Estado</b><br>${info.cancelada ? 'Cancelada' : 'Activa'}</div>
</div>
<h2>Motivo</h2><div class="box">${esc(info.motivo || '')}</div>
<h2>Saldo</h2>
<div class="saldos">
<div class="saldo"><b>Días disponibles</b><br>${total(disponibles)}</div>
<div class="saldo"><b>Días bloqueados</b><br>${total(bloqueados)}</div>
</div>
<h2>Detalle de días disponibles</h2>
<table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha disponible</th></tr>${filas(disponibles)}</table>
<h2>Detalle de días bloqueados</h2>
<table><tr><th>Ciclo</th><th>Otorgados</th><th>Consumidos</th><th>Disponibles</th><th>Fecha disponible</th></tr>${filas(bloqueados)}</table>
</body></html>`;

    const dir = path.join(os.tmpdir(), 'rrhh-control');
    fs.mkdirSync(dir, {recursive:true});
    const tmp = path.join(dir, `incidencia_${id}_v11.html`);
    fs.writeFileSync(tmp, htmlPdf, 'utf8');

    const win = new BrowserWindow({show:false, webPreferences:{contextIsolation:true}});
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({printBackground:true, pageSize:'A4'});
    win.destroy();

    const result = await dialog.showSaveDialog({
      title:'Guardar incidencia en PDF',
      defaultPath:`Incidencia_${info.folio || id}.pdf`,
      filters:[{name:'Documento PDF', extensions:['pdf']}]
    });
    if (result.canceled || !result.filePath) return {ok:false,canceled:true};

    fs.writeFileSync(result.filePath, pdf);
    return {ok:true,filePath:result.filePath};
  } catch (error) {
    return {ok:false,error:error.message};
  }
});
