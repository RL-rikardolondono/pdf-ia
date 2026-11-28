/* PDF-IA · Escanear documento · SkyNet Genesis (basado en Escaner-IA)
   Fotos de documentos a PDF, todo dentro del celular.
   Base open source: jscanify (MIT) + OpenCV.js (Apache 2.0) + jsPDF (MIT). */
'use strict';

/* ================= CONFIGURACIÓN ================= */
// Dentro de la app de Google Play la compra se hace con la facturación de Google (en la página principal)
const PLAY = (() => { try { if (document.referrer.indexOf('android-app://com.skynetgenesis.pdfia') === 0) sessionStorage.setItem('pdfia.play', '1'); return sessionStorage.getItem('pdfia.play') === '1'; } catch (e) { return false; } })();
const CFG = {
  version: '1.0.1',
  precio: PLAY ? 11400 : 9900,        // pago único, en pesos (Google Play: +15 %)
  gratis: 3,                          // documentos gratis antes de pedir la compra
  plan: 'pdf-ia:licencia',        // plan del firmador central de Bold
  firmador: 'https://skynetgenesis.com/bold-firma.php',
  verificador: 'https://skynetgenesis.com/bold-verificar.php',
  app: 'pdf-ia',
  volver: 'https://pdf-ia.skynetgenesis.com/escanear/',
  wa: 'https://wa.me/573044375758',
  pieDoc: 'Escaneado con PDF-IA de SkyNet Genesis · skynetgenesis.com · contacto@skynetgenesis.com · WhatsApp 304 437 5758',
  maxOrig: 2400,      // lado mayor de la foto guardada
  maxProc: 2000,      // lado mayor de la página procesada
  maxDetect: 900,     // lado mayor para detectar la hoja (rápido)
  // OpenCV (9 MB) se sirve desde jsDelivr en producción: GitHub no deja subir archivos tan grandes por la web
  opencvCDN: 'https://cdn.jsdelivr.net/npm/jscanify@1.4.3/src/opencv.js'
};
const PRODUCCION = /(^|\.)skynetgenesis\.com$/i.test(location.hostname);
const IDB_NOMBRE = 'pdf-ia-escanear';

/* ================= UTILIDADES ================= */
const $ = s => document.querySelector(s);
const fmt = n => '$' + n.toLocaleString('es-CO');
const espera = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
let toastT;
function toast(msg, ms = 5500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('ver');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('ver'), ms);
}
function cargando(on, txt = 'Un momento…', sub = '') {
  $('#cargando').classList.toggle('ver', on);
  $('#txtCargando').textContent = txt; $('#subCargando').textContent = sub;
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem('escaner.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('escaner.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('escaner.' + k); } catch (e) {} }
};
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function canvasBlob(cv, tipo = 'image/jpeg', q = 0.9) {
  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('No se pudo crear la imagen')), tipo, q));
}
function blobImagen(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob); const im = new Image();
    im.onload = () => { res(im); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('La imagen no se pudo abrir')); };
    im.src = url;
  });
}
function escalar(src, maxLado) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const k = Math.min(1, maxLado / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function rotar90(src, veces) {
  veces = ((veces % 4) + 4) % 4;
  if (!veces) return src;
  const c = document.createElement('canvas');
  const w = src.width, h = src.height;
  c.width = veces % 2 ? h : w; c.height = veces % 2 ? w : h;
  const x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2); x.rotate(veces * Math.PI / 2); x.drawImage(src, -w / 2, -h / 2);
  return c;
}

/* Pregunta dentro de la página (los cuadros del navegador no funcionan en todos lados) */
function pregunta(texto, si = 'Sí', no = 'Cancelar') {
  return new Promise(res => {
    $('#txtPreg').textContent = texto; $('#btnPregSi').textContent = si; $('#btnPregNo').textContent = no;
    const M = $('#modalPreg');
    const fin = v => { M.classList.remove('ver'); $('#btnPregSi').onclick = $('#btnPregNo').onclick = M.onclick = null; res(v); };
    $('#btnPregSi').onclick = () => fin(true); $('#btnPregNo').onclick = () => fin(false);
    M.onclick = ev => { if (ev.target === M) fin(false); };
    clearTimeout(toastT); $('#toast').classList.remove('ver');
    M.classList.add('ver'); $('#btnPregSi').focus();
  });
}

/* ================= ALMACÉN (IndexedDB) ================= */
const DB = {
  db: null,
  abrir() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let r; try { r = indexedDB.open(IDB_NOMBRE, 1); } catch (e) { return rej(e); }
      r.onupgradeneeded = () => r.result.createObjectStore('paginas', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async op(modo, fn) {
    const db = await this.abrir();
    return new Promise((res, rej) => {
      const tx = db.transaction('paginas', modo); const st = tx.objectStore('paginas');
      const q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error);
    });
  },
  poner(p) { return this.op('readwrite', s => s.put(p)); },
  quitar(id) { return this.op('readwrite', s => s.delete(id)); },
  todas() { return this.op('readonly', s => s.getAll()); },
  vaciar() { return this.op('readwrite', s => s.clear()); }
};
/* Si IndexedDB no está disponible (navegación privada), se trabaja en memoria. */
let sinDB = false;
const memoria = new Map();
async function guardarPagina(p) { if (sinDB) { memoria.set(p.id, p); return; } try { await DB.poner(p); } catch (e) { sinDB = true; memoria.set(p.id, p); } }
async function borrarPagina(id) { memoria.delete(id); if (!sinDB) try { await DB.quitar(id); } catch (e) {} }
async function leerPaginas() {
  let arr = [];
  if (!sinDB) { try { arr = await DB.todas(); } catch (e) { sinDB = true; } }
  if (sinDB) arr = [...memoria.values()];
  const orden = ls.get('orden', []);
  arr.sort((a, b) => (orden.indexOf(a.id) + 1 || 9e9) - (orden.indexOf(b.id) + 1 || 9e9));
  return arr;
}
async function vaciarPaginas() { memoria.clear(); if (!sinDB) try { await DB.vaciar(); } catch (e) {} ls.del('orden'); ls.del('docId'); }

/* ================= OPENCV ================= */
let cvListo = null;
function cargarCV() {
  if (cvListo) return cvListo;
  cvListo = new Promise((res) => {
    const fin = ok => { clearTimeout(lim); res(ok); };
    const lim = setTimeout(() => fin(false), 60000);
    const s = document.createElement('script');
    s.src = PRODUCCION ? CFG.opencvCDN : 'libs/opencv.js'; s.async = true;
    s.onload = () => {
      // OJO: el módulo de OpenCV es "thenable" y se resuelve a sí mismo; NO usar await (bloquea la página).
      const t0 = Date.now();
      const mirar = () => {
        if (window.cv && window.cv.Mat) return fin(true);
        if (Date.now() - t0 > 55000) return fin(false);
        setTimeout(mirar, 150);
      };
      mirar();
    };
    s.onerror = () => fin(false);
    document.head.appendChild(s);
  });
  return cvListo;
}
const hayCV = () => !!(window.cv && window.cv.Mat);

/* ---- Detección de la hoja ---- */
function ordenarEsquinas(pts) {
  // tl, tr, br, bl
  const s = pts.map(p => p.x + p.y), d = pts.map(p => p.y - p.x);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.min(...d))], bl = pts[d.indexOf(Math.max(...d))];
  const out = [tl, tr, br, bl];
  return new Set(out).size === 4 ? out : null;
}
function areaPoli(p) { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; } return Math.abs(a) / 2; }
function esquinasPorDefecto() { const m = 0.05; return [{ x: m, y: m }, { x: 1 - m, y: m }, { x: 1 - m, y: 1 - m }, { x: m, y: 1 - m }]; }

function detectarHoja(canvas) {
  if (!hayCV()) return null;
  const cv = window.cv;
  const peq = escalar(canvas, CFG.maxDetect);
  const W = peq.width, H = peq.height, areaImg = W * H;
  const src = cv.imread(peq), gris = new cv.Mat(), borr = new cv.Mat(), bordes = new cv.Mat();
  let mejor = null;
  const probar = (umbral1, umbral2) => {
    cv.Canny(borr, bordes, umbral1, umbral2);
    const k = cv.Mat.ones(3, 3, cv.CV_8U); cv.dilate(bordes, bordes, k); k.delete();
    const conts = new cv.MatVector(), jer = new cv.Mat();
    cv.findContours(bordes, conts, jer, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const lista = [];
    for (let i = 0; i < conts.size(); i++) { const c = conts.get(i); lista.push({ c, a: cv.contourArea(c) }); }
    lista.sort((a, b) => b.a - a.a);
    for (const { c, a } of lista.slice(0, 10)) {
      if (a < areaImg * 0.15) break;
      const per = cv.arcLength(c, true);
      for (const eps of [0.02, 0.03, 0.05]) {
        const ap = new cv.Mat(); cv.approxPolyDP(c, ap, eps * per, true);
        if (ap.rows === 4 && cv.isContourConvex(ap)) {
          const pts = []; for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
          const o = ordenarEsquinas(pts); ap.delete();
          if (o && (!mejor || areaPoli(o) > mejor.a)) mejor = { pts: o, a: areaPoli(o) };
          break;
        }
        ap.delete();
      }
      if (mejor) break;
    }
    lista.forEach(x => x.c.delete()); conts.delete(); jer.delete();
  };
  try {
    cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gris, borr, new cv.Size(5, 5), 0);
    probar(30, 110);
    if (!mejor) probar(10, 60);
    if (!mejor && window.jscanify) {
      // Respaldo: método original de jscanify (contorno mayor + esquinas por cuadrante)
      const sc = new window.jscanify(); const c = sc.findPaperContour(src);
      if (c) {
        const e = sc.getCornerPoints(c, src);
        const pts = [e.topLeftCorner, e.topRightCorner, e.bottomRightCorner, e.bottomLeftCorner];
        if (pts.every(Boolean) && areaPoli(pts) > areaImg * 0.15) mejor = { pts, a: areaPoli(pts) };
        c.delete();
      }
    }
  } catch (e) { console.warn('detección', e); mejor = null; }
  finally { src.delete(); gris.delete(); borr.delete(); bordes.delete(); }
  return mejor ? mejor.pts.map(p => ({ x: p.x / W, y: p.y / H })) : null;
}

/* ---- Enderezar (perspectiva) ---- */
function medidasSalida(esq, w, h) {
  const P = esq.map(p => ({ x: p.x * w, y: p.y * h }));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let ow = Math.max(d(P[0], P[1]), d(P[3], P[2])), oh = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  const k = Math.min(1, CFG.maxProc / Math.max(ow, oh));
  return { P, ow: Math.max(10, Math.round(ow * k)), oh: Math.max(10, Math.round(oh * k)) };
}
function enderezar(canvas, esq) {
  return recortarOrilla(enderezarBase(canvas, esq));
}
/* quita una franja finita del borde (evita la línea oscura de la mesa en la orilla) */
function recortarOrilla(c) {
  const m = Math.round(Math.min(c.width, c.height) * 0.007); if (m < 1) return c;
  const o = document.createElement('canvas'); o.width = c.width - 2 * m; o.height = c.height - 2 * m;
  o.getContext('2d').drawImage(c, m, m, o.width, o.height, 0, 0, o.width, o.height); return o;
}
function enderezarBase(canvas, esq) {
  const { P, ow, oh } = medidasSalida(esq, canvas.width, canvas.height);
  if (hayCV()) {
    const cv = window.cv;
    const src = cv.imread(canvas), dst = new cv.Mat();
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, [P[0].x, P[0].y, P[1].x, P[1].y, P[2].x, P[2].y, P[3].x, P[3].y]);
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow, 0, ow, oh, 0, oh]);
    const M = cv.getPerspectiveTransform(a, b);
    cv.warpPerspective(src, dst, M, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const out = document.createElement('canvas'); cv.imshow(out, dst);
    src.delete(); dst.delete(); a.delete(); b.delete(); M.delete();
    return out;
  }
  return enderezarJS(canvas, P, ow, oh);
}
/* Respaldo sin OpenCV: homografía calculada en JavaScript */
function homografia(de, a) {
  // resuelve H tal que a = H·de (8 incógnitas)
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = de[i], X = a[i].x, Y = a[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); B.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); B.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]]; [B[c], B[m]] = [B[m], B[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
  }
  const h = B.map((v, i) => v / A[i][i]); h.push(1); return h;
}
function enderezarJS(canvas, P, ow, oh) {
  const H = homografia([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], P);
  const sw = canvas.width, sh = canvas.height;
  const sd = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas'); out.width = ow; out.height = oh;
  const ox = out.getContext('2d'); const id = ox.createImageData(ow, oh); const d = id.data;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const z = H[6] * x + H[7] * y + 1;
    let sx = Math.round((H[0] * x + H[1] * y + H[2]) / z), sy = Math.round((H[3] * x + H[4] * y + H[5]) / z);
    sx = Math.min(sw - 1, Math.max(0, sx)); sy = Math.min(sh - 1, Math.max(0, sy));
    const i = (y * ow + x) * 4, j = (sy * sw + sx) * 4;
    d[i] = sd[j]; d[i + 1] = sd[j + 1]; d[i + 2] = sd[j + 2]; d[i + 3] = 255;
  }
  ox.putImageData(id, 0, 0); return out;
}

/* ---- Filtros ---- */
const FILTROS = {
  mejorado: 'Colores reales, sin sombras y con el fondo más blanco. Ideal para casi todo.',
  documento: 'Blanco y negro nítido, como una fotocopia. El PDF queda muy liviano.',
  gris: 'Escala de grises sin sombras. Bueno para documentos con sellos o firmas suaves.',
  original: 'La foto tal como salió, solo enderezada.'
};
function quitarSombra(cv, canal) {
  // fondo = dilatar + mediana grande; resultado = 255 - |canal - fondo|, normalizado
  const fondo = new cv.Mat(), dif = new cv.Mat(), k = cv.Mat.ones(7, 7, cv.CV_8U);
  const lado = Math.max(canal.cols, canal.rows); const med = lado > 1200 ? 31 : 21;
  cv.dilate(canal, fondo, k); cv.medianBlur(fondo, fondo, med);
  cv.absdiff(canal, fondo, dif); cv.bitwise_not(dif, dif);
  cv.normalize(dif, dif, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
  fondo.delete(); k.delete();
  return dif;
}
function aplicarFiltro(base, filtro) {
  if (filtro === 'original') { const c = document.createElement('canvas'); c.width = base.width; c.height = base.height; c.getContext('2d').drawImage(base, 0, 0); return c; }
  if (!hayCV()) return filtroJS(base, filtro);
  const cv = window.cv; const src = cv.imread(base); let out;
  try {
    if (filtro === 'mejorado') {
      const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      const canales = new cv.MatVector(); cv.split(rgb, canales);
      const res = new cv.MatVector();
      for (let i = 0; i < 3; i++) { const ch = canales.get(i); const q = quitarSombra(cv, ch); res.push_back(q); ch.delete(); q.delete(); }
      out = new cv.Mat(); cv.merge(res, out);
      rgb.delete(); canales.delete(); res.delete();
    } else {
      const g = new cv.Mat(); cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
      const q = quitarSombra(cv, g); g.delete();
      if (filtro === 'documento') {
        out = new cv.Mat(); const bloque = Math.max(q.cols, q.rows) > 1200 ? 41 : 25;
        cv.adaptiveThreshold(q, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bloque, 14);
        q.delete();
      } else out = q;
    }
    const c = document.createElement('canvas'); cv.imshow(c, out); return c;
  } finally { src.delete(); if (out) out.delete(); }
}
function filtroJS(base, filtro) {
  const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(base, 0, 0);
  const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 16) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; if (l < min) min = l; if (l > max) max = l; }
  const lo = min + (max - min) * 0.08, hi = min + (max - min) * 0.85, k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    if (filtro === 'mejorado') { for (let j = 0; j < 3; j++) d[i + j] = Math.max(0, Math.min(255, (d[i + j] - lo) * k)); continue; }
    let l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - lo) * k;
    l = filtro === 'documento' ? (l > 150 ? 255 : 0) : Math.max(0, Math.min(255, l));
    d[i] = d[i + 1] = d[i + 2] = l;
  }
  x.putImageData(id, 0, 0); return c;
}

/* ================= ESTADO ================= */
const E = {
  cola: [],          // archivos pendientes de procesar
  totalCola: 0,
  edit: null,        // { id, nueva, origCanvas, rot, esq, filtro, recto, cache }
  pdf: null          // { blob, url, nombre, pags }
};
function docId() { let d = ls.get('docId'); if (!d) { d = uid(); ls.set('docId', d); } return d; }

/* ================= LICENCIA Y CUPO ================= */
// Licencia y documentos gratis COMPARTIDOS con todas las herramientas de PDF-IA
const lsPdf = {
  get(k, d) { try { const v = localStorage.getItem('pdfia.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pdfia.' + k, JSON.stringify(v)); } catch (e) {} }
};
function licencia() { return lsPdf.get('licencia', null); }
function usados() { return lsPdf.get('usados', []); }
function quedan() { return Math.max(0, CFG.gratis - usados().length); }
function puedeCrear() { return !!licencia() || quedan() > 0 || usados().includes(docId()); }
function contarDocumento() { if (licencia()) return; const u = usados(); const d = docId(); if (!u.includes(d)) { u.push(d); lsPdf.set('usados', u); } }
function pintarEstado() {
  const ch = $('#chipEstado'); const lic = licencia();
  if (lic) { ch.textContent = 'Completa ✓'; ch.classList.remove('gratis'); }
  else { const q = quedan(); ch.textContent = q === 1 ? '1 gratis' : q + ' gratis'; ch.classList.add('gratis'); }
  const t = $('#tarjetaPlan');
  if (lic) t.innerHTML = `<h3 style="font-size:20px;color:var(--azul)">Versión completa activa ✓</h3><p class="ayuda">Documentos ilimitados en este celular. Gracias por apoyar a SkyNet Genesis.</p>`;
  else t.innerHTML = `<h3 style="font-size:20px;color:var(--azul)">Versión completa: ${fmt(CFG.precio)}, pago único</h3>
    <p class="ayuda">Puede crear <b>${CFG.gratis} documentos gratis</b> (le quedan <b>${quedan()}</b>). Después, por un solo pago de ${fmt(CFG.precio)}, escanea sin límite. Sin mensualidades.</p>
    <button class="btn azul peq" style="margin-top:10px" type="button" onclick="abrirPlan()">Ver la versión completa</button>`;
  const cupo = $('#txtCupo');
  if (cupo) cupo.textContent = lic ? 'Versión completa: documentos ilimitados.' : (usados().includes(docId()) ? 'Este documento ya está contado: puede volver a crearlo sin gastar otro.' : `Le quedan ${quedan()} de ${CFG.gratis} documentos gratis.`);
}

/* ================= NAVEGACIÓN ================= */
let actual = 'inicio';
function ir(p, empujar = true) {
  document.querySelectorAll('.pantalla').forEach(s => s.classList.toggle('activa', s.id === 'p-' + p));
  if (empujar && p !== actual) { try { history.pushState({ p }, '', '#' + p); } catch (e) {} }
  actual = p; window.scrollTo(0, 0);
  if (p === 'bordes') requestAnimationFrame(pintarBordes);
}
window.addEventListener('popstate', ev => {
  const p = (ev.state && ev.state.p) || 'inicio';
  if ($('#modalPlan').classList.contains('ver')) { cerrarPlan(); }
  if (p === 'bordes' && !E.edit) return ir('doc', false);
  if (p === 'filtro' && !(E.edit && E.edit.recto)) return ir(E.edit ? 'bordes' : 'doc', false);
  if (p === 'listo' && !E.pdf) return ir('doc', false);
  if (p === 'inicio') refrescarInicio();
  if (p === 'doc') pintarDoc();
  ir(p, false);
});

/* ================= ENTRADA DE FOTOS ================= */
$('#btnFoto').onclick = () => elegir('#inFoto');
$('#btnGaleria').onclick = () => elegir('#inGaleria');
$('#btnMasFoto').onclick = () => elegir('#inFoto');
$('#btnMasGaleria').onclick = () => elegir('#inGaleria');
function elegir(sel) { const i = $(sel); i.value = ''; i.click(); }
['#inFoto', '#inGaleria'].forEach(s => $(s).addEventListener('change', ev => {
  const fs = [...ev.target.files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
  if (!fs.length) { if (ev.target.files.length) toast('Ese archivo no es una imagen. Elija una foto.'); return; }
  ev.target.value = ''; // permite volver a elegir la misma foto
  E.cola = fs; E.totalCola = fs.length; siguienteDeCola();
}));
async function siguienteDeCola() {
  const f = E.cola.shift();
  if (!f) { E.edit = null; await pintarDoc(); ir('doc'); return; }
  cargando(true, 'Abriendo la foto…', E.totalCola > 1 ? `Página ${E.totalCola - E.cola.length} de ${E.totalCola}` : '');
  try {
    const im = await blobImagen(f);
    const orig = escalar(im, CFG.maxOrig);
    const origBlob = await canvasBlob(orig, 'image/jpeg', 0.92);
    await empezarEdicion({ id: uid(), nueva: true, origCanvas: orig, origBlob, rot: 0, esq: null, filtro: ls.get('filtro', 'mejorado') });
  } catch (e) {
    console.error(e); cargando(false);
    toast('No se pudo abrir esa foto. Si es de iPhone (HEIC), compártala como JPG o tómela de nuevo.');
    if (E.cola.length) siguienteDeCola();
  }
}
async function empezarEdicion(ed) {
  E.edit = ed;
  if (!ed.esq) {
    cargando(true, 'Buscando la hoja…', hayCV() ? '' : 'Preparando el escáner la primera vez (puede tardar unos segundos)');
    const ok = await Promise.race([cargarCV(), espera(hayCV() ? 0 : 25000).then(() => hayCV())]);
    await frame();
    const vis = rotar90(ed.origCanvas, ed.rot);
    const det = ok ? detectarHoja(vis) : null;
    ed.esq = det || esquinasPorDefecto();
    ed.detectada = !!det;
  }
  cargando(false);
  $('#txtPagBordes').textContent = E.totalCola > 1 && ed.nueva ? `Página ${E.totalCola - E.cola.length} de ${E.totalCola}` : '';
  $('#txtDeteccion').textContent = ed.detectada === false
    ? 'No encontramos la hoja sola. Arrastre los cuatro círculos verdes hasta las esquinas del documento.'
    : 'Revise que los círculos verdes estén en las esquinas de la hoja. Si no, arrástrelos.';
  ir('bordes');
}

/* ================= EDITOR DE BORDES ================= */
const cajaB = $('#cajaBordes'), cvB = $('#cvBordes'), capa = $('#capaBordes'), poli = $('#poliBordes');
let vistaB = null; // canvas rotado que se muestra
let manijas = [];
function pintarBordes() {
  const ed = E.edit; if (!ed) return;
  vistaB = rotar90(ed.origCanvas, ed.rot);
  const anchoMax = cajaB.clientWidth || 340, altoMax = Math.max(260, Math.min(window.innerHeight * 0.58, 640));
  const k = Math.min(anchoMax / vistaB.width, altoMax / vistaB.height);
  const w = Math.round(vistaB.width * k), h = Math.round(vistaB.height * k);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cvB.width = w * dpr; cvB.height = h * dpr; cvB.style.width = w + 'px'; cvB.style.height = h + 'px';
  const x = cvB.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(vistaB, 0, 0, cvB.width, cvB.height);
  if (!manijas.length) {
    for (let i = 0; i < 4; i++) {
      const m = document.createElement('div'); m.className = 'manija'; m.setAttribute('role', 'slider');
      m.setAttribute('aria-label', ['Esquina superior izquierda', 'Esquina superior derecha', 'Esquina inferior derecha', 'Esquina inferior izquierda'][i]);
      cajaB.appendChild(m); manijas.push(m); activarArrastre(m, i);
    }
  }
  pintarPoli();
}
function rectCanvas() {
  const rc = cvB.getBoundingClientRect(), rb = cajaB.getBoundingClientRect();
  return { x: rc.left - rb.left, y: rc.top - rb.top, w: rc.width, h: rc.height };
}
function pintarPoli() {
  const ed = E.edit; if (!ed) return; const r = rectCanvas();
  poli.setAttribute('points', ed.esq.map(p => `${r.x + p.x * r.w},${r.y + p.y * r.h}`).join(' '));
  ed.esq.forEach((p, i) => { manijas[i].style.left = (r.x + p.x * r.w) + 'px'; manijas[i].style.top = (r.y + p.y * r.h) + 'px'; });
}
function activarArrastre(m, i) {
  let activo = false, offX = 0, offY = 0;
  m.addEventListener('pointerdown', ev => {
    ev.preventDefault(); activo = true; m.setPointerCapture(ev.pointerId); m.style.cursor = 'grabbing';
    const r = m.getBoundingClientRect(); offX = ev.clientX - (r.left + r.width / 2); offY = ev.clientY - (r.top + r.height / 2);
  });
  m.addEventListener('pointermove', ev => {
    if (!activo || !E.edit) return;
    const rb = cajaB.getBoundingClientRect(), r = rectCanvas();
    const px = ev.clientX - offX - rb.left, py = ev.clientY - offY - rb.top;
    const p = { x: Math.min(1, Math.max(0, (px - r.x) / r.w)), y: Math.min(1, Math.max(0, (py - r.y) / r.h)) };
    E.edit.esq[i] = p; E.edit.recto = null; pintarPoli(); lupa(p, r);
  });
  const soltar = () => { activo = false; m.style.cursor = 'grab'; $('#lupa').style.display = 'none'; };
  m.addEventListener('pointerup', soltar); m.addEventListener('pointercancel', soltar);
  m.addEventListener('keydown', ev => { // accesible con teclado
    const paso = ev.shiftKey ? 0.02 : 0.005; const p = E.edit.esq[i];
    const mov = { ArrowLeft: [-paso, 0], ArrowRight: [paso, 0], ArrowUp: [0, -paso], ArrowDown: [0, paso] }[ev.key];
    if (!mov) return; ev.preventDefault();
    p.x = Math.min(1, Math.max(0, p.x + mov[0])); p.y = Math.min(1, Math.max(0, p.y + mov[1])); E.edit.recto = null; pintarPoli();
  });
  m.tabIndex = 0;
}
function lupa(p, r) {
  const L = $('#lupa'), c = $('#cvLupa'), x = c.getContext('2d');
  const tam = 110, zoom = 2.6;
  let lx = r.x + p.x * r.w - tam / 2, ly = r.y + p.y * r.h - tam - 40;
  if (ly < 4) ly = r.y + p.y * r.h + 40;
  lx = Math.max(4, Math.min(cajaB.clientWidth - tam - 4, lx));
  L.style.left = lx + 'px'; L.style.top = ly + 'px'; L.style.display = 'block';
  const sx = p.x * vistaB.width, sy = p.y * vistaB.height, lado = (vistaB.width / r.w) * tam / zoom;
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(vistaB, sx - lado / 2, sy - lado / 2, lado, lado, 0, 0, c.width, c.height);
  x.strokeStyle = '#14A38B'; x.lineWidth = 3; x.beginPath();
  x.moveTo(c.width / 2 - 18, c.height / 2); x.lineTo(c.width / 2 + 18, c.height / 2);
  x.moveTo(c.width / 2, c.height / 2 - 18); x.lineTo(c.width / 2, c.height / 2 + 18); x.stroke();
}
window.addEventListener('resize', () => { if (actual === 'bordes') pintarBordes(); });
$('#btnRotar').onclick = () => {
  const ed = E.edit; if (!ed) return;
  ed.rot = (ed.rot + 1) % 4; ed.esq = ed.esq.map(p => ({ x: 1 - p.y, y: p.x }));
  // reordenar para que tl siga siendo arriba-izquierda
  ed.esq = ordenarEsquinas(ed.esq) || esquinasPorDefecto(); ed.recto = null; ed.cache = null;
  pintarBordes();
};
$('#btnTodo').onclick = () => { if (!E.edit) return; E.edit.esq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; E.edit.recto = null; pintarPoli(); toast('Se usará la foto completa.'); };
$('#btnAuto').onclick = async () => {
  if (!E.edit) return;
  cargando(true, 'Buscando la hoja…'); const ok = await cargarCV(); await frame();
  const det = ok ? detectarHoja(rotar90(E.edit.origCanvas, E.edit.rot)) : null; cargando(false);
  if (det) { E.edit.esq = det; E.edit.recto = null; pintarPoli(); toast('Hoja encontrada. Revise las esquinas.'); }
  else toast('No se encontró la hoja sola. Ubique las esquinas a mano.');
};
$('#volverBordes').onclick = () => cancelarEdicion();
async function cancelarEdicion() {
  const ed = E.edit; E.edit = null;
  if (ed && ed.nueva) {
    if (E.cola.length) { toast('Foto descartada. Sigue la siguiente.'); return siguienteDeCola(); }
    const ps = await leerPaginas(); E.cola = [];
    if (ps.length) { await pintarDoc(); ir('doc'); } else { refrescarInicio(); ir('inicio'); }
    toast('Foto descartada.');
  } else { await pintarDoc(); ir('doc'); }
}
$('#btnAplicarBordes').onclick = async () => {
  const ed = E.edit; if (!ed) return;
  if (areaPoli(ed.esq) < 0.02) return toast('Las esquinas están muy juntas. Sepárelas sobre la hoja.');
  cargando(true, 'Enderezando la hoja…'); await frame();
  try {
    if (!hayCV()) await Promise.race([cargarCV(), espera(8000)]);
    const vis = rotar90(ed.origCanvas, ed.rot);
    ed.recto = enderezar(vis, ed.esq); ed.cache = {};
    cargando(false); ir('filtro'); await mostrarFiltro(ed.filtro);
  } catch (e) { console.error(e); cargando(false); toast('No se pudo enderezar. Intente con «Toda la foto».'); }
};

/* ================= FILTROS ================= */
$('#chipsFiltro').addEventListener('click', ev => { const b = ev.target.closest('.chip'); if (b) mostrarFiltro(b.dataset.f); });
async function mostrarFiltro(f) {
  const ed = E.edit; if (!ed || !ed.recto) return;
  ed.filtro = f;
  document.querySelectorAll('#chipsFiltro .chip').forEach(c => c.classList.toggle('on', c.dataset.f === f));
  $('#txtFiltro').textContent = FILTROS[f];
  if (!ed.cache[f]) {
    cargando(true, 'Mejorando la imagen…'); await frame();
    try { ed.cache[f] = aplicarFiltro(ed.recto, f); } catch (e) { console.error(e); ed.cache[f] = filtroJS(ed.recto, f); }
    cargando(false);
  }
  const src = ed.cache[f], c = $('#cvFiltro');
  c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0);
}
$('#volverFiltro').onclick = () => { if (E.edit) { E.edit.recto = null; ir('bordes'); } else ir('doc'); };
$('#btnGuardarPagina').onclick = async () => {
  const ed = E.edit; if (!ed || !ed.cache || !ed.cache[ed.filtro]) return;
  cargando(true, 'Guardando la página…'); await frame();
  try {
    const proc = ed.cache[ed.filtro];
    const blob = await canvasBlob(proc, 'image/jpeg', 0.9);
    await guardarPagina({ id: ed.id, orig: ed.origBlob, rot: ed.rot, esq: ed.esq, filtro: ed.filtro, proc: blob, w: proc.width, h: proc.height, fecha: Date.now() });
    const orden = ls.get('orden', []); if (!orden.includes(ed.id)) { orden.push(ed.id); ls.set('orden', orden); }
    ls.set('filtro', ed.filtro); docId(); E.pdf = null;
    const eraNueva = ed.nueva; E.edit = null; cargando(false);
    if (eraNueva && E.cola.length) { toast('Página guardada. Sigue la siguiente foto.'); return siguienteDeCola(); }
    await pintarDoc(); ir('doc');
    toast(eraNueva ? 'Página guardada. Agregue otra o cree el PDF.' : 'Página actualizada.');
  } catch (e) {
    console.error(e); cargando(false);
    toast('No se pudo guardar la página: el celular tiene poca memoria. Cierre otras aplicaciones e intente de nuevo.', 7000);
  }
};

/* ================= DOCUMENTO ================= */
let urlsMini = [];
async function pintarDoc() {
  const ps = await leerPaginas();
  urlsMini.forEach(u => URL.revokeObjectURL(u)); urlsMini = [];
  const L = $('#listaPaginas'); L.innerHTML = '';
  $('#txtNumPags').textContent = ps.length === 1 ? '1 página' : ps.length + ' páginas';
  ps.forEach((p, i) => {
    const u = URL.createObjectURL(p.proc); urlsMini.push(u);
    const d = document.createElement('div'); d.className = 'pag';
    d.innerHTML = `<div class="mini" title="Ajustar esta página"><span class="num">${i + 1}</span><img alt="Página ${i + 1}" src="${u}"></div>
      <div class="acc"><button type="button" aria-label="Mover a la izquierda" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button type="button" class="borrar" aria-label="Quitar página">🗑</button>
      <button type="button" aria-label="Mover a la derecha" ${i === ps.length - 1 ? 'disabled' : ''}>▶</button></div>`;
    d.querySelector('.mini').onclick = () => editarPagina(p);
    const [bi, bb, bd] = d.querySelectorAll('.acc button');
    bi.onclick = () => mover(p.id, -1); bd.onclick = () => mover(p.id, 1); bb.onclick = () => quitar(p.id, i + 1);
    L.appendChild(d);
  });
  if (!ps.length) L.innerHTML = '<div class="aviso-info" style="grid-column:1/-1">Todavía no hay páginas. Tome una foto o elija una de la galería.</div>';
  $('#btnCrearPDF').disabled = !ps.length;
  if (!$('#inNombre').value) $('#inNombre').value = ls.get('nombre', '') || nombrePorDefecto();
  $('#inHoja').value = ls.get('hoja', 'carta'); $('#inCalidad').value = ls.get('calidad', 'normal');
  pintarEstado();
  return ps;
}
function nombrePorDefecto() { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `Documento ${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`; }
async function mover(id, dir) {
  const ps = await leerPaginas(); const orden = ps.map(p => p.id); const i = orden.indexOf(id), j = i + dir;
  if (j < 0 || j >= orden.length) return;
  [orden[i], orden[j]] = [orden[j], orden[i]]; ls.set('orden', orden); E.pdf = null; pintarDoc();
}
async function quitar(id, n) {
  if (!await pregunta(`¿Quitar la página ${n} del documento?`, 'Sí, quitarla')) return;
  await borrarPagina(id); ls.set('orden', ls.get('orden', []).filter(x => x !== id)); E.pdf = null;
  await pintarDoc(); toast(`Página ${n} quitada.`);
}
async function editarPagina(p) {
  cargando(true, 'Abriendo la página…');
  try {
    const im = await blobImagen(p.orig); const orig = escalar(im, CFG.maxOrig);
    E.cola = []; E.totalCola = 1;
    await empezarEdicion({ id: p.id, nueva: false, origCanvas: orig, origBlob: p.orig, rot: p.rot || 0, esq: p.esq.map(q => ({ ...q })), filtro: p.filtro, detectada: true });
  } catch (e) { cargando(false); toast('No se pudo abrir la página.'); }
}
$('#volverDoc').onclick = () => { refrescarInicio(); ir('inicio'); };
$('#inNombre').addEventListener('input', e => { ls.set('nombre', e.target.value); E.pdf = null; });
$('#inHoja').addEventListener('change', e => { ls.set('hoja', e.target.value); E.pdf = null; });
$('#inCalidad').addEventListener('change', e => { ls.set('calidad', e.target.value); E.pdf = null; });

/* ================= PDF ================= */
const HOJAS = { carta: [215.9, 279.4], oficio: [215.9, 330.2], a4: [210, 297] };
function nombreArchivo() {
  let n = ($('#inNombre').value || '').trim() || nombrePorDefecto();
  n = n.replace(/[\\/:*?"<>|#%&{}$!'@+`=]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Documento';
  return n.replace(/\.pdf$/i, '') + '.pdf';
}
$('#btnCrearPDF').onclick = crearPDF;
async function crearPDF() {
  const ps = await leerPaginas();
  if (!ps.length) return toast('Primero agregue al menos una página.');
  if (!puedeCrear()) { abrirPlan('limite'); return; }
  if (!window.jspdf) return toast('Falta cargar el generador de PDF. Revise su conexión y recargue la página.', 7000);
  const alta = $('#inCalidad').value === 'alta', hoja = $('#inHoja').value;
  const lado = alta ? 2000 : 1500, q = alta ? 0.88 : 0.72;
  cargando(true, 'Creando su PDF…', ps.length > 1 ? `0 de ${ps.length} páginas` : '');
  try {
    const { jsPDF } = window.jspdf; let doc = null;
    for (let i = 0; i < ps.length; i++) {
      $('#subCargando').textContent = ps.length > 1 ? `${i + 1} de ${ps.length} páginas` : '';
      await frame();
      const im = await blobImagen(ps[i].proc); const c = escalar(im, lado);
      const datos = c.toDataURL('image/jpeg', ps[i].filtro === 'documento' ? Math.min(q, 0.7) : q);
      const hz = c.width > c.height;
      let W, H;
      if (hoja === 'foto') { W = 210; H = 210 * c.height / c.width; if (hz) { H = 210; W = 210 * c.width / c.height; } H += 6; }
      else { [W, H] = HOJAS[hoja]; if (hz) [W, H] = [H, W]; }
      const ori = W > H ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ orientation: ori, unit: 'mm', format: [W, H], compress: true });
      else doc.addPage([W, H], ori);
      const m = hoja === 'foto' ? 0 : 6, pie = 6;
      const aw = W - 2 * m, ah = H - 2 * m - pie;
      const k = Math.min(aw / c.width, ah / c.height);
      const iw = c.width * k, ih = c.height * k;
      doc.addImage(datos, 'JPEG', (W - iw) / 2, m + (ah - ih) / 2, iw, ih, undefined, 'FAST');
      doc.setFontSize(6.5); doc.setTextColor(93, 107, 120);
      doc.text(CFG.pieDoc + (ps.length > 1 ? `  ·  Página ${i + 1} de ${ps.length}` : ''), W / 2, H - 2.6, { align: 'center' });
    }
    const nombre = nombreArchivo();
    doc.setProperties({ title: nombre.replace(/\.pdf$/i, ''), creator: 'PDF-IA · SkyNet Genesis (skynetgenesis.com)', producer: 'PDF-IA ' + CFG.version, subject: 'Documento escaneado' });
    const blob = doc.output('blob');
    if (E.pdf && E.pdf.url) URL.revokeObjectURL(E.pdf.url);
    E.pdf = { blob, url: URL.createObjectURL(blob), nombre, pags: ps.length };
    contarDocumento(); pintarEstado();
    $('#datoNombre').textContent = nombre; $('#datoPags').textContent = ps.length;
    $('#datoPeso').textContent = blob.size > 1048576 ? (blob.size / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB';
    const lic = licencia();
    $('#txtListo').textContent = lic ? 'Compártalo o descárguelo.' : (quedan() > 0 ? `Le quedan ${quedan()} documentos gratis.` : 'Este fue su último documento gratis. Puede seguir escaneando con la versión completa.');
    $('#btnCompartir').classList.toggle('oculto', !puedeCompartir(blob, nombre));
    cargando(false); ir('listo');
  } catch (e) {
    console.error(e); cargando(false);
    toast('No se pudo crear el PDF. Pruebe con calidad «Normal» o con menos páginas.', 7000);
  }
}
function archivoPDF() { return new File([E.pdf.blob], E.pdf.nombre, { type: 'application/pdf' }); }
function puedeCompartir(blob, nombre) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([blob], nombre, { type: 'application/pdf' })] })); } catch (e) { return false; }
}
$('#btnCompartir').onclick = async () => {
  if (!E.pdf) return;
  try { await navigator.share({ files: [archivoPDF()], title: E.pdf.nombre }); }
  catch (e) { if (e && e.name !== 'AbortError') toast('No se pudo compartir. Use «Descargar al celular».'); }
};
let descargasClaude = null; // dentro de Claude, las descargas pasan por la plataforma
$('#btnDescargar').onclick = async () => {
  if (!E.pdf) return;
  if (descargasClaude) {
    try { await descargasClaude.save({ filename: E.pdf.nombre, data: E.pdf.blob }); toast('PDF «' + E.pdf.nombre + '» guardado.'); }
    catch (e) { if (!e || e.code !== 'declined') toast('No se pudo descargar aquí. Abra la aplicación en el navegador del celular.', 7000); }
    return;
  }
  const a = document.createElement('a'); a.href = E.pdf.url; a.download = E.pdf.nombre; document.body.appendChild(a); a.click(); a.remove();
  toast('Descargando «' + E.pdf.nombre + '». Quedará en la carpeta Descargas.');
};
$('#btnVerPDF').onclick = () => { if (!E.pdf) return; const w = window.open(E.pdf.url, '_blank'); if (!w) toast('Su navegador bloqueó la ventana. Use «Descargar al celular».'); };
$('#btnEditarDoc').onclick = async () => { await pintarDoc(); ir('doc'); };
$('#btnNuevoDoc').onclick = async () => {
  if (!await pregunta('¿Empezar un documento nuevo?\n\nLas páginas de este documento se borrarán de la aplicación. El PDF que ya descargó o compartió no se borra.', 'Sí, empezar otro')) return;
  await vaciarPaginas(); ls.del('nombre'); $('#inNombre').value = ''; E.pdf = null;
  refrescarInicio(); ir('inicio'); toast('Listo para un documento nuevo.');
};

/* ================= INICIO / BORRADOR ================= */
async function refrescarInicio() {
  const ps = await leerPaginas(); const caja = $('#cajaBorrador');
  caja.style.display = ps.length ? 'block' : 'none';
  if (ps.length) $('#txtBorrador').textContent = `Tiene un documento sin terminar con ${ps.length === 1 ? '1 página' : ps.length + ' páginas'}.`;
  pintarEstado();
}
$('#btnSeguirBorrador').onclick = async () => { await pintarDoc(); ir('doc'); };
$('#btnDescartarBorrador').onclick = async () => {
  if (!await pregunta('¿Borrar las páginas del documento sin terminar?', 'Sí, borrarlas')) return;
  await vaciarPaginas(); ls.del('nombre'); $('#inNombre').value = ''; E.pdf = null; refrescarInicio(); toast('Documento descartado.');
};
$('#irInicio').onclick = async ev => { ev.preventDefault(); if (actual === 'bordes' || actual === 'filtro') { if (!await pregunta('¿Salir sin guardar esta página?', 'Sí, salir')) return; E.edit = null; E.cola = []; } refrescarInicio(); ir('inicio'); };

/* ================= PLAN / PAGO BOLD ================= */
function dispositivo() { let d = lsPdf.get('dispositivo'); if (!d) { d = 'pdf' + uid().replace(/[^a-z0-9]/gi, '').slice(0, 14); lsPdf.set('dispositivo', d); } return d; }
$('#chipEstado').onclick = () => abrirPlan();
function abrirPlan(motivo) {
  const lic = licencia(); const c = $('#cajaPlan');
  if (PLAY && !lic) { location.href = '../index.html#comprar'; return; }
  if (lic) {
    c.innerHTML = `<h2 id="tituloPlan" style="font-size:26px;color:var(--azul)">Versión completa activa ✓</h2>
      <p class="ayuda">Puede crear documentos sin límite en este celular.</p>
      <div class="tarjeta" style="margin-top:12px"><div class="dato"><span>Código de su compra</span><b>${esc(lic.ref)}</b></div>
      <div class="dato"><span>Activada</span><b>${new Date(lic.fecha).toLocaleDateString('es-CO')}</b></div></div>
      <p class="nota">Guarde el código: con él recupera la versión completa si cambia de celular o borra el navegador.</p>
      <button class="btn prim" type="button" onclick="cerrarPlan()">Seguir escaneando</button>`;
  } else {
    const q = quedan();
    c.innerHTML = `<h2 id="tituloPlan" style="font-size:26px;color:var(--azul)">${motivo === 'limite' ? 'Ya usó sus ' + CFG.gratis + ' documentos gratis' : 'PDF-IA completa'}</h2>
      <p class="ayuda">${motivo === 'limite' ? 'Sus páginas siguen guardadas. Active la versión completa y cree su PDF ahora mismo.' : `Le quedan <b>${q}</b> de ${CFG.gratis} documentos gratis.`}</p>
      <div style="text-align:center;margin:14px 0 4px"><div class="precio">${fmt(CFG.precio)}</div><div class="ayuda" style="margin:2px 0 0">pago único · sin mensualidades</div></div>
      <ul class="lista-chk"><li>Documentos y páginas sin límite</li><li>Detección automática, enderezado y blanco y negro</li><li>Sin anuncios y sin subir sus documentos a internet</li><li>Para siempre en este celular</li></ul>
      <div class="pila">
        <button class="btn prim" type="button" id="btnPagar">Comprar por ${fmt(CFG.precio)} con Bold</button>
        <p class="nota" style="text-align:center;margin:0">Pago seguro con Bold: tarjeta, PSE o Nequi.</p>
        <details class="faq"><summary>Ya compré: recuperar mi compra</summary>
          <p>Escriba el código de compra que le mostró Bold al pagar.</p>
          <input id="inCodigo" placeholder="Código de la compra" autocomplete="off" style="margin-top:6px">
          <button class="btn azul peq" type="button" id="btnRecuperar" style="margin-top:8px">Recuperar</button>
        </details>
        <a class="btn wa peq" href="${CFG.wa}?text=${encodeURIComponent('Hola, necesito ayuda con PDF-IA')}" target="_blank" rel="noopener">💬 Soporte por WhatsApp</a>
        <button class="btn sec peq" type="button" onclick="cerrarPlan()">${q > 0 ? 'Seguir con la versión gratis' : 'Cerrar'}</button>
      </div>
      ${PRODUCCION ? '' : '<p class="nota" style="text-align:center">Demostración: el pago se simula, no se cobra nada.</p>'}`;
    $('#btnPagar').onclick = pagar;
    $('#btnRecuperar').onclick = () => recuperar($('#inCodigo').value);
  }
  clearTimeout(toastT); $('#toast').classList.remove('ver');
  $('#modalPlan').classList.add('ver');
}
function cerrarPlan() { $('#modalPlan').classList.remove('ver'); }
window.abrirPlan = abrirPlan; window.cerrarPlan = cerrarPlan;
$('#modalPlan').addEventListener('click', ev => { if (ev.target.id === 'modalPlan') cerrarPlan(); });
function esc(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function activar(ref) {
  lsPdf.set('licencia', { ref, fecha: Date.now() }); pintarEstado(); cerrarPlan();
  toast('¡Versión completa activada! Ya puede usar todas las herramientas de PDF-IA sin límite.', 7000);
}
async function pagar() {
  if (!PRODUCCION) {
    if (!await pregunta(`DEMOSTRACIÓN\n\nAquí se abriría el pago de Bold por ${fmt(CFG.precio)}.\n¿Simular que el pago salió aprobado?`, 'Simular pago aprobado')) return;
    return activar('DEMO-' + uid().toUpperCase());
  }
  if (!navigator.onLine) return toast('Necesita internet para comprar. Conéctese e intente de nuevo.');
  cargando(true, 'Abriendo el pago seguro…');
  try {
    // Pago de prueba de $1.000 (solo para SkyNet Genesis): abrir la app con #prueba-bold
    const plan = location.hash === '#prueba-bold' ? 'pdf-ia:prueba' : CFG.plan;
    const u = `${CFG.firmador}?plan=${encodeURIComponent(plan)}&empresa=${encodeURIComponent(dispositivo())}&meses=1&volver=${encodeURIComponent(CFG.volver)}`;
    const r = await fetch(u, { cache: 'no-store' }); const j = await r.json();
    // VERIFICAR al conectar: nombres de campos que devuelve bold-firma.php
    if (!j || j.ok === false) throw new Error('firmador: ' + (j && j.error));
    const orden = j.orderId || j.order_id || j.orden;
    const valor = j.amount || CFG.precio;
    const llave = j.apiKey || j.api_key;
    const firma = j.signature || j.integritySignature || j.integrity_signature;
    if (!orden || !llave || !firma) throw new Error('respuesta del firmador incompleta');
    ls.set('pedido', { orden, fecha: Date.now() });
    if (!window.BoldCheckout) {
      await new Promise((ok, mal) => { const s = document.createElement('script'); s.src = 'https://checkout.bold.co/library/boldPaymentButton.js'; s.onload = ok; s.onerror = mal; document.head.appendChild(s); });
      for (let i = 0; i < 20 && !window.BoldCheckout; i++) await espera(150);
    }
    cargando(false);
    const pago = new BoldCheckout({
      orderId: orden, currency: j.currency || 'COP', amount: String(valor), apiKey: llave,
      integritySignature: firma, description: j.description || 'PDF-IA - Version completa (pago unico)',
      redirectionUrl: j.redirectionUrl || CFG.volver
    });
    pago.open();
  } catch (e) {
    console.error(e); cargando(false);
    toast('No se pudo abrir el pago en este momento. Intente de nuevo o escríbanos por WhatsApp.', 7000);
  }
}
async function verificar(ref) {
  // bold-verificar.php acepta ?ref=<orden> o ?pago=<id de Bold>
  for (const clave of ['ref', 'pago']) {
    try {
      const r = await fetch(`${CFG.verificador}?${clave}=${encodeURIComponent(ref)}&app=${CFG.app}`, { cache: 'no-store' });
      if (!r.ok) continue; const j = await r.json(); const o = j.orden || j.order || j.data || j;
      const plan = o.plan || ''; const est = String(o.estado || o.status || '').toLowerCase();
      const ok = j.ok !== false && (!plan || String(plan).indexOf('pdf-ia') === 0) && (!est || /aprob|approved|pagad|aplicad|ok/.test(est));
      if (ok) return o.orden || o.order_id || o.referencia || ref;
    } catch (e) {}
  }
  return null;
}
async function recuperar(codigo) {
  codigo = (codigo || '').trim(); if (codigo.length < 6) return toast('Escriba el código completo de la compra.');
  if (!PRODUCCION) return toast('En la demostración no hay compras reales para recuperar.');
  cargando(true, 'Buscando su compra…'); const ref = await verificar(codigo); cargando(false);
  if (ref) activar(ref); else toast('No encontramos una compra aprobada con ese código. Revíselo o escríbanos por WhatsApp.', 7000);
}
async function revisarRegresoBold() {
  const q = new URLSearchParams(location.search); const orden = q.get('bold-order-id'); const estado = (q.get('bold-tx-status') || '').toLowerCase();
  if (!orden) return;
  try { history.replaceState({ p: 'inicio' }, '', location.pathname); } catch (e) {}
  if (estado && estado !== 'approved') { toast('El pago no se completó. No se cobró nada; puede intentarlo de nuevo.', 7000); return; }
  cargando(true, 'Confirmando su pago…');
  let ref = null; for (let i = 0; i < 6 && !ref; i++) { ref = await verificar(orden); if (!ref) await espera(4000); }
  cargando(false);
  if (ref) { ls.del('pedido'); activar(ref); }
  else toast('Bold aún no confirma el pago. Espere un minuto y use «Ya compré: recuperar mi compra» con el código ' + orden + '.', 9000);
}

/* ================= ARRANQUE ================= */
(async function iniciar() {
  try { history.replaceState({ p: 'inicio' }, '', location.pathname + location.search); } catch (e) {}
  try { await DB.abrir(); } catch (e) { sinDB = true; }
  await refrescarInicio();
  if (PRODUCCION) revisarRegresoBold();
  // OpenCV se carga en segundo plano para que el primer escaneo sea rápido
  setTimeout(() => cargarCV(), 800);
  if (window.claude && typeof window.claude.use === 'function') {
    $('#btnVerPDF').classList.add('oculto');
    try { descargasClaude = await window.claude.use('downloads'); } catch (e) { descargasClaude = null; }
  } else {
    // Vista de prueba en Claude: esta página corre dentro del marco de PDF-IA y descarga a través de él
    try {
      const p = window.parent;
      if (p !== window && p.location.origin === location.origin && p.pdfiaDescargas) {
        $('#btnVerPDF').classList.add('oculto');
        descargasClaude = { save: (o) => p.pdfiaDescargas().save(o) };
      }
    } catch (e) { /* otro origen */ }
  }
})();
