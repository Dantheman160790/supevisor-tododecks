/**
 * Todo Decks — Servidor Supervisor de Vendedor v2
 * Tablero + Slack con presión activa al vendedor
 */

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const path    = require('path');

const app  = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ODOO_URL    = process.env.ODOO_URL;
const ODOO_DB     = process.env.ODOO_DB;
const ODOO_USER   = process.env.ODOO_USER;
const ODOO_PASS   = process.env.ODOO_PASS;
const SLACK_WEBHOOK        = process.env.SLACK_WEBHOOK;
const SLACK_WEBHOOK_ALERTS = process.env.SLACK_WEBHOOK_ALERTS || process.env.SLACK_WEBHOOK;
const PORT = process.env.PORT || 4000;
const TZ   = 'America/Cancun';

// ── ODOO ─────────────────────────────────────────────
async function odooAuth() {
  const r = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:1,
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS } })
  });
  const d = await r.json();
  if (!d.result?.uid) throw new Error('Auth Odoo falló');
  return { sessionId: r.headers.get('set-cookie'), uid: d.result.uid };
}

async function odooCall(sessionId, model, method, args=[], kwargs={}) {
  const r = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionId },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:1,
      params: { model, method, args, kwargs: { ...kwargs, context: {} } } })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.data?.message || JSON.stringify(d.error));
  return d.result;
}

// ── DATOS PRINCIPALES ─────────────────────────────────
// Frases motivacionales rotativas
const FRASES = [
  "Cada conversación que tienes hoy es una semilla que cosechas mañana. 🌱",
  "Los grandes cierres empiezan con una llamada más. ¿Ya la hiciste? 📞",
  "Eres la razón por la que un cliente encuentra exactamente lo que necesita. 🎯",
  "El seguimiento no es insistir — es demostrar que te importa el proyecto del cliente. 💪",
  "Cada 'lo pienso' es una invitación a volver con más información. 🚀",
  "Tu energía de hoy construye la cartera de mañana. ¡Tú puedes! ✅",
  "Un cliente bien atendido es el mejor anuncio que existe. 🏆",
  "El mejor momento para llamar a ese lead fue ayer. El segundo mejor es ahora. 📲",
  "Cada proyecto que cierras transforma un espacio y una vida. Eso vale mucho. 🌟",
  "Pequeñas acciones constantes generan grandes resultados. Hoy suma. 💫",
];

function getFraseDelDia() {
  const dia = new Date().getDay();
  return FRASES[dia % FRASES.length];
}

async function getDatosVendedor() {
  const { sessionId } = await odooAuth();
  const hoy = new Date();
  // Fecha en hora Cancún (EST = UTC-5 fijo, sin horario de verano)
  const CANCUN_OFFSET_MS = 5 * 60 * 60 * 1000; // 5 horas en ms
  const cancunNow = new Date(hoy.getTime() - CANCUN_OFFSET_MS);
  const hoyStr = cancunNow.toISOString().split('T')[0];
  // Rango UTC para consultas de Odoo que guarda en UTC
  // "hoy" Cancún = hoyStr 05:00 UTC a hoyStr+1 05:00 UTC
  const hoyInicioUTC = hoyStr + ' 05:00:00'; // medianoche Cancún en UTC
  const hoySiguienteStr = new Date(cancunNow.getTime() + 24*60*60*1000).toISOString().split('T')[0];
  const hoyFinUTC = hoySiguienteStr + ' 05:00:00'; // medianoche siguiente Cancún en UTC
  const en3dias = new Date(hoy); en3dias.setDate(hoy.getDate() + 3);
  const en3diasStr = new Date(en3dias.getTime() - CANCUN_OFFSET_MS).toISOString().split('T')[0];
  const inicioSemana = new Date(hoy); inicioSemana.setDate(hoy.getDate() - hoy.getDay());
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];

  // Actividades
  const actividades = await odooCall(sessionId, 'mail.activity', 'search_read',
    [[['res_model','=','crm.lead']]],
    { fields:['id','summary','date_deadline','activity_type_id','res_name','user_id','note'], limit:200 }
  );

  const hoyDate = new Date(hoyStr);
  const actVencidas = actividades.filter(a => new Date(a.date_deadline) < hoyDate);
  const actHoy      = actividades.filter(a => a.date_deadline === hoyStr);
  const actProximas = actividades.filter(a => {
    const d = new Date(a.date_deadline);
    return d > hoyDate && a.date_deadline <= en3diasStr;
  });

  // Pipeline completo
  const oportunidades = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['active','=',true]]],
    { fields:['id','name','partner_name','stage_id','expected_revenue','probability',
              'user_id','date_last_stage_update','create_date','activity_state'], limit:300 }
  );

  const porEtapa = {};
  oportunidades.forEach(op => {
    const etapa = op.stage_id?.[1] || 'Sin etapa';
    if (!porEtapa[etapa]) porEtapa[etapa] = { oportunidades:[], total:0, count:0 };
    const lastUpdate = new Date(op.date_last_stage_update || op.create_date);
    op.dias_sin_movimiento = Math.floor((hoy - lastUpdate) / (1000*60*60*24));
    porEtapa[etapa].oportunidades.push(op);
    porEtapa[etapa].total += op.expected_revenue || 0;
    porEtapa[etapa].count++;
  });

  // ── VENDEDORES — Jonathan y Isabel ──────────────────
  const VENDEDORES = ['Jonathan Tapia', 'Isabel del Peral'];
  const todosVendedores = await odooCall(sessionId, 'res.users', 'search_read',
    [[['share','=',false],['active','=',true]]],
    { fields:['id','name'], limit:20 }
  );
  const vendedoresMap = {};
  todosVendedores.forEach(u => {
    if (VENDEDORES.some(n => u.name.includes(n.split(' ')[0]))) {
      vendedoresMap[u.id] = u.name;
    }
  });
  const vendedorIds = Object.keys(vendedoresMap).map(Number);

  // ── OPORTUNIDADES NUEVAS HOY (por vendedor) ─────────
  const opNuevasHoy = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['active','=',true],
      ['create_date','>=',hoyInicioUTC],['create_date','<',hoyFinUTC]]],
    { fields:['id','name','partner_name','user_id','expected_revenue','stage_id'], limit:100 }
  );

  // ── COTIZACIONES ENVIADAS (por vendedor) ────────────
  const cotizaciones = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['active','=',true],
      ['stage_id.name','in',['Cotización Enviada','Propuesta','Quoted']]]],
    { fields:['id','name','partner_name','user_id','expected_revenue',
              'date_last_stage_update','stage_id'], limit:200 }
  );
  cotizaciones.forEach(op => {
    const lastUpdate = new Date(op.date_last_stage_update);
    op.dias_en_cotizacion = Math.floor((hoy - lastUpdate) / (1000*60*60*24));
  });

  // ── CONTACTOS NUEVOS HOY ─────────────────────────────
  const contactosNuevosHoy = await odooCall(sessionId, 'res.partner', 'search_read',
    [[['create_date','>=',hoyInicioUTC],['create_date','<',hoyFinUTC]]],
    { fields:['id','name','phone','email','create_date'], limit:50 }
  );

  // Agrupar por vendedor
  const porVendedor = {};
  vendedorIds.forEach(uid => {
    const nombre = vendedoresMap[uid];
  const vOpNuevas = opNuevasHoy.filter(o => o.user_id?.[0] === uid);
    const vCotizaciones = cotizaciones.filter(o => o.user_id?.[0] === uid);
    const vOpportunidades = oportunidades.filter(o => o.user_id?.[0] === uid);
    const vOpActivas = vOpportunidades.filter(o => {
      const etapa = o.stage_id?.[1]||'';
      return !['won','ganado','perdido','lost'].some(x=>etapa.toLowerCase().includes(x));
    });
    porVendedor[nombre] = {
      nombre,
      opNuevasHoy: vOpNuevas,
      cotizaciones: vCotizaciones,
      cotizacionesCriticas: vCotizaciones.filter(o => o.dias_en_cotizacion >= 3).map(o => ({
        nombre: o.name || '—',
        valor: o.expected_revenue || 0,
        dias: o.dias_en_cotizacion || 0,
      })),
      totalPipeline: Math.round(vOpActivas.reduce((a,o)=>a+(o.expected_revenue||0),0)),
      totalOportunidades: vOpActivas.length,
    };
  });

  // También total sin filtro de vendedor para compatibilidad
  const leadsNuevosHoy = []; // Ya no usamos leads
  const leadsSinActividad = [];
  const leadsNuevosHoySinActividad = [];
  const leadsConvertidosSemana = { length: 0 };
  const leadsPerdidosSemana = { length: 0 };

  // Leads sin actividad +3 días (ALERTA CRÍTICA)
  const sinActividad3dias = oportunidades.filter(op => {
    const tieneActividad = actividades.some(a => a.res_id === op.id);
    return op.dias_sin_movimiento >= 3 && !tieneActividad;
  });

  // Estancados +7 días
  const estancados7 = oportunidades.filter(op => op.dias_sin_movimiento > 7);

  // Ganados este mes
  const ganadosMes = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['stage_id.is_won','=',true],
      ['date_closed','>=',inicioMes+' 00:00:00']]],
    { fields:['id','name','partner_name','expected_revenue','date_closed','user_id'], limit:200 }
  );

  // Leads nuevos esta semana
  const nuevosSemanales = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['create_date','>=',inicioSemana.toISOString().split('T')[0]+' 00:00:00']]],
    { fields:['id','name','type','partner_name','create_date'], limit:200 }
  );

  // Contactos nuevos hoy
  const contactosHoy = await odooCall(sessionId, 'res.partner', 'search_read',
    [[['create_date','>=',hoyInicioUTC],['create_date','<',hoyFinUTC]]],
    { fields:['id','name','phone','email','create_date'], limit:50 }
  );

  // Nombre del vendedor — desde el user_id asignado en las oportunidades
  let vendedorNombre = 'Jonathan'; // Fallback por defecto
  try {
    // Tomar el responsable más frecuente entre las oportunidades activas
    const conteoUsers = {};
    oportunidades.forEach(op => {
      if (op.user_id?.[1]) {
        const nombre = op.user_id[1];
        conteoUsers[nombre] = (conteoUsers[nombre] || 0) + 1;
      }
    });
    // También revisar actividades
    actividades.forEach(a => {
      if (a.user_id?.[1]) {
        const nombre = a.user_id[1];
        conteoUsers[nombre] = (conteoUsers[nombre] || 0) + 1;
      }
    });
    // El que más aparece es el vendedor principal
    const masFrequente = Object.entries(conteoUsers).sort((a,b) => b[1]-a[1])[0];
    if (masFrequente) {
      vendedorNombre = masFrequente[0].split(' ')[0]; // Solo primer nombre
    }
  } catch(e) { console.log('No se pudo detectar vendedor:', e.message); }

  // Reuniones hoy
  const reuniones = await odooCall(sessionId, 'calendar.event', 'search_read',
    [[['start','>=',hoyInicioUTC],['start','<',hoyFinUTC]]],
    { fields:['id','name','start','stop','location'], limit:50 }
  );

  // Leads nuevos HOY sin actividad programada
  const leadsHoy = nuevosSemanales.filter(l =>
    l.create_date?.startsWith(hoyStr) && l.type === 'opportunity'
  );
  const leadsHoySinActividad = leadsHoy.filter(l =>
    !actividades.some(a => a.res_id === l.id)
  );

  // Bitácora del día — actividades marcadas como hechas (body contiene "hecho")
  const todosMsg = await odooCall(sessionId, 'mail.message', 'search_read',
    [[['model','=','crm.lead'],
      ['date','>=',hoyInicioUTC],
      ['date','<',hoyFinUTC]]],

    { fields:['id','body','author_id','date','res_id','record_name',
              'mail_activity_type_id','message_type','subtype_id'], limit:500 }
  );

  // Filtrar los que son actividades completadas (body tiene "hecho" o tienen activity_type)
  const actCompletadasMsg = todosMsg.filter(m => {
    const body = (m.body||'').toLowerCase();
    return body.includes('hecho') || m.mail_activity_type_id;
  });

  // Notas/comentarios manuales (sin activity type, message_type comment)
  const notasMsg = todosMsg.filter(m => {
    const body = (m.body||'').toLowerCase();
    return m.message_type === 'comment' && !body.includes('hecho') && !m.mail_activity_type_id;
  });

  // Agrupar actividades completadas por tipo
  const bitacoraAgrupada = {};
  actCompletadasMsg.forEach(m => {
    const bodyRaw = (m.body||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
    // Detectar tipo desde el body: "Llamada hecho : feedback" o desde mail_activity_type_id
    let tipo = m.mail_activity_type_id?.[1] || 'Actividad';
    if (bodyRaw.toLowerCase().includes('llamada')) tipo = 'Llamada';
    else if (bodyRaw.toLowerCase().includes('correo') || bodyRaw.toLowerCase().includes('email')) tipo = 'Email';
    else if (bodyRaw.toLowerCase().includes('whatsapp')) tipo = 'WhatsApp';
    else if (bodyRaw.toLowerCase().includes('reunión') || bodyRaw.toLowerCase().includes('meeting')) tipo = 'Reunión';

    // Extraer feedback — lo que viene después del ":"
    let feedback = '';
    const partes = bodyRaw.split(':');
    if (partes.length > 1) {
      feedback = partes.slice(1).join(':').trim();
      // Si el feedback es igual al tipo, no mostrar
      if (feedback.toLowerCase() === tipo.toLowerCase()) feedback = '';
    }

    if (!bitacoraAgrupada[tipo]) bitacoraAgrupada[tipo] = { tipo, leads: [] };
    // Extraer solo el texto de retroalimentación limpio
    let feedbackLimpio = '';
    const retroIdx = bodyRaw.toLowerCase().indexOf('retroalimentación:');
    const feedbackIdx = bodyRaw.toLowerCase().indexOf('feedback:');
    if (retroIdx >= 0) {
      feedbackLimpio = bodyRaw.slice(retroIdx + 18).trim();
    } else if (feedbackIdx >= 0) {
      feedbackLimpio = bodyRaw.slice(feedbackIdx + 9).trim();
    } else if (feedback && feedback.length > 2 && feedback.toLowerCase() !== tipo.toLowerCase()) {
      feedbackLimpio = feedback;
    }
    // Limpiar saltos de línea extra y espacios
    feedbackLimpio = feedbackLimpio.replace(/\s+/g, ' ').trim();
    // Ignorar si es igual al tipo o a textos genéricos
    const textoGenerico = ['llamada','correo electrónico','email','whatsapp','actividades pendientes','to-do','reunión','meeting'];
    if (textoGenerico.some(t => feedbackLimpio.toLowerCase() === t)) feedbackLimpio = '';
    bitacoraAgrupada[tipo].leads.push({
      lead: m.record_name || '—',
      texto: feedbackLimpio.slice(0, 150),
      hora: m.date?.split('T')[1]?.slice(0,5)||'—',
    });
  });

  // Notas manuales por lead
  const mensajesPorLead = {};
  notasMsg.forEach(m => {
    const texto = (m.body||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
    if (!texto || texto==='false' || texto.length < 4) return;
    if (!mensajesPorLead[m.res_id]) mensajesPorLead[m.res_id] = { nombre: m.record_name||'—', mensajes:[] };
    mensajesPorLead[m.res_id].mensajes.push({
      hora: m.date?.split('T')[1]?.slice(0,5)||'—',
      texto: texto.length>200 ? texto.slice(0,200)+'...' : texto,
    });
  });

  const bitacoraFinal = Object.values(bitacoraAgrupada);

  // Actividades COMPLETADAS hoy — desde mail.message con activity_type
  const actCompletadasHoy = await odooCall(sessionId, 'mail.message', 'search_read',
    [[['model','=','crm.lead'],
      ['date','>=',hoyInicioUTC],
      ['date','<',hoyFinUTC],
      ['mail_activity_type_id','!=',false]]],
    { fields:['id','mail_activity_type_id','author_id','date','res_id','record_name'], limit:500 }
  );

  // Contar por tipo directamente desde mail.message
  const conteoHoy = {};
  const conteoHoyPorVendedor = {};
  actCompletadasHoy.forEach(a => {
    const tipo = a.mail_activity_type_id?.[1] || 'Actividad';
    const autor = a.author_id?.[1] || 'Desconocido';
    conteoHoy[tipo] = (conteoHoy[tipo] || 0) + 1;
    if (!conteoHoyPorVendedor[autor]) conteoHoyPorVendedor[autor] = {};
    conteoHoyPorVendedor[autor][tipo] = (conteoHoyPorVendedor[autor][tipo] || 0) + 1;
  });
  const totalCompletadasHoy = actCompletadasHoy.length;

  // Promedio semanal (misma fuente)
  const inicioSemanaStr = inicioSemana.toISOString().split('T')[0];
  const actDoneSemana = await odooCall(sessionId, 'mail.message', 'search_read',
    [[['model','=','crm.lead'],
      ['date','>=',inicioSemanaStr+' 05:00:00'],
      ['mail_activity_type_id','!=',false]]],
    { fields:['id','date'], limit:1000 }
  );
  const diasTranscurridos = Math.max(1, cancunNow.getDay() || 7);
  const promedioDiario = Math.round(actDoneSemana.length / diasTranscurridos);
  const tendencia = totalCompletadasHoy >= promedioDiario ? 'arriba' : 'abajo';

  // Ventas del día — solo CRM ganadas (orden de compra confirmada)
  const ganadadasHoy = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['stage_id.is_won','=',true],
      ['date_closed','>=',hoyInicioUTC],
      ['date_closed','<',hoyFinUTC]]],
    { fields:['id','name','partner_name','expected_revenue','date_closed',
              'source_id','medium_id','campaign_id','user_id'], limit:100 }
  );
  const totalDia = Math.round(ganadadasHoy.reduce((a,v) => a+(v.expected_revenue||0), 0));
  // Ganadas del mes por vendedor
  const ganadosMesPorVendedor = {};
  ganadosMes.forEach(v => {
    const vend = v.user_id?.[1] || 'Sin asignar';
    if (!ganadosMesPorVendedor[vend]) ganadosMesPorVendedor[vend] = { count:0, total:0 };
    ganadosMesPorVendedor[vend].count++;
    ganadosMesPorVendedor[vend].total += v.expected_revenue||0;
  });

  // Leads CALIENTES — en etapa Propuesta (cotización enviada)
  const leadsCalientes = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['active','=',true],
      ['stage_id.name','in',['Propuesta','Proposition','Quoted','Cotización','Propuesta/Precio']]]],
    { fields:['id','name','partner_name','expected_revenue','probability',
              'user_id','date_last_stage_update','create_date'], limit:100 }
  );

  // Calcular días en Propuesta y clasificar urgencia
  leadsCalientes.forEach(op => {
    const lastUpdate = new Date(op.date_last_stage_update || op.create_date);
    op.dias_en_propuesta = Math.floor((hoy - lastUpdate) / (1000*60*60*24));
    op.urgencia = op.dias_en_propuesta >= 3 ? 'critico' : op.dias_en_propuesta >= 1 ? 'alto' : 'normal';
  });

  const calientesCriticos = leadsCalientes.filter(op => op.urgencia === 'critico');
  const calientesAlto     = leadsCalientes.filter(op => op.urgencia === 'alto');
  const valorCalientes    = leadsCalientes.reduce((a,op) => a+(op.expected_revenue||0), 0);

  // Pipeline ACTIVO — excluir ganadas y perdidas
  const ETAPAS_EXCLUIR = ['won','ganado','perdido','lost'];
  const oportunidadesActivas = oportunidades.filter(op => {
    const etapa = (op.stage_id?.[1]||'').toLowerCase();
    return !ETAPAS_EXCLUIR.some(x => etapa.includes(x));
  });
  const totalPipeline = oportunidadesActivas.reduce((a,op) => a+(op.expected_revenue||0), 0);

  return {
    fecha: hoyStr,
    actividades: {
      vencidas: actVencidas.map(a => ({
        lead: a.res_name, tipo: a.activity_type_id?.[1], fecha: a.date_deadline,
        resumen: a.summary, user: a.user_id?.[1],
        dias_vencida: Math.floor((hoy - new Date(a.date_deadline)) / (1000*60*60*24))
      })),
      hoy:      actHoy.map(a => ({ lead: a.res_name, tipo: a.activity_type_id?.[1],
                  fecha: a.date_deadline, resumen: a.summary, user: a.user_id?.[1] })),
      proximas: actProximas.map(a => ({ lead: a.res_name, tipo: a.activity_type_id?.[1],
                  fecha: a.date_deadline, resumen: a.summary, user: a.user_id?.[1] })),
    },
    pipeline: {
      por_etapa: porEtapa,
      total_oportunidades: oportunidadesActivas.length,
      valor_total: Math.round(totalPipeline),
      ticket_promedio: oportunidadesActivas.length > 0 ? Math.round(totalPipeline/oportunidadesActivas.length) : 0,
      sin_actividad_3dias: sinActividad3dias.map(op => ({
        nombre: op.name, cliente: op.partner_name,
        etapa: op.stage_id?.[1], dias: op.dias_sin_movimiento,
        valor: op.expected_revenue || 0
      })),
      estancadas: estancados7.map(op => ({
        nombre: op.name, cliente: op.partner_name,
        etapa: op.stage_id?.[1], dias: op.dias_sin_movimiento,
        valor: op.expected_revenue || 0
      })),
    },
    kpis: {
      ganados_mes: ganadosMes.length,
      valor_ganado_mes: Math.round(ganadosMes.reduce((a,l) => a+(l.expected_revenue||0), 0)),
      ganados_detalle: ganadosMes.slice(0,5).map(l => ({ nombre: l.name||'—', cliente: l.partner_name||'—', valor: l.expected_revenue||0 })),
      nuevos_semana: nuevosSemanales.length,
      contactos_hoy: contactosHoy.length,
      contactos_hoy_detalle: contactosHoy.slice(0,5).map(c => ({ nombre: c.name, telefono: c.phone||'—', email: c.email||'—' })),
      leads_hoy_sin_actividad: leadsHoySinActividad.length,
      tasa_conversion: (oportunidades.length + ganadosMes.length) > 0
        ? Math.round((ganadosMes.length / (oportunidades.length + ganadosMes.length)) * 100) : 0,
    },
    ventas_hoy: {
      total: totalDia,
      ganadas: ganadadasHoy.map(v => ({
        nombre: v.name || '—',
        cliente: v.partner_name || '—',
        monto: v.expected_revenue || 0,
        fuente: v.source_id?.[1] || v.medium_id?.[1] || v.campaign_id?.[1] || 'Directo',
        vendedor: v.user_id?.[1] || '—',
      })),
      por_vendedor: ganadosMesPorVendedor,
      count: ganadadasHoy.length,
    },
    vendedores: porVendedor,
    contactos_nuevos_hoy: contactosNuevosHoy.map(c => ({
      nombre: c.name, telefono: c.phone||'—', email: c.email||'—'
    })),
    op_nuevas_hoy: opNuevasHoy.map(o => ({
      nombre: o.name, cliente: o.partner_name||'—',
      vendedor: o.user_id?.[1]||'—', valor: o.expected_revenue||0
    })),
    leads_prospectos: {
      total: 0,
      nuevos_hoy: 0,
      sin_actividad: 0,
      nuevos_sin_actividad: 0,
      convertidos_semana: 0,
      perdidos_semana: 0,
      detalle_sin_actividad: [],
    },
    leads_calientes: {
      total: leadsCalientes.length,
      valor_total: Math.round(valorCalientes),
      criticos: calientesCriticos.map(op => ({
        nombre: op.name, cliente: op.partner_name,
        valor: op.expected_revenue, dias: op.dias_en_propuesta
      })),
      alto: calientesAlto.map(op => ({
        nombre: op.name, cliente: op.partner_name,
        valor: op.expected_revenue, dias: op.dias_en_propuesta
      })),
      todos: leadsCalientes.map(op => ({
        nombre: op.name, cliente: op.partner_name,
        valor: op.expected_revenue, dias: op.dias_en_propuesta, urgencia: op.urgencia
      })),
    },
    bitacora_dia: {
      total: bitacoraFinal.length,
      actividades: bitacoraFinal,
      mensajes_por_lead: mensajesPorLead,
      total_registros: actCompletadasMsg.length,
    },
    actividades_completadas: {
      hoy: totalCompletadasHoy,
      por_tipo_hoy: conteoHoy,
      por_vendedor_hoy: conteoHoyPorVendedor,
      promedio_diario_semana: promedioDiario,
      tendencia,
      detalle_hoy: actCompletadasHoy.slice(0,10).map(a => ({
        tipo: a.mail_activity_type_id?.[1], lead: a.record_name||'—',
        user: '—', feedback: ''
      })),
    },
    vendedor: vendedorNombre,
    reuniones: reuniones.map(r => ({
      nombre: r.name, inicio: r.start, fin: r.stop, lugar: r.location || '—'
    })),
  };
}

// ── SLACK ─────────────────────────────────────────────
async function sendSlack(webhookUrl, blocks) {
  if (!webhookUrl) { console.log('⚠️ No webhook URL'); return; }
  const body = JSON.stringify({ blocks });
  const r = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const txt = await r.text();
  if (!r.ok || txt !== 'ok') {
    console.error('Slack error:', r.status, txt);
    console.error('Blocks count:', blocks.length);
    // Log each block type to find the problem
    blocks.forEach((b,i) => {
      const textLen = b.text?.text?.length || b.fields?.reduce((a,f)=>a+(f.text?.length||0),0) || 0;
      if (textLen > 2900) console.error(`Block ${i} too long: ${textLen} chars, type: ${b.type}`);
    });
  } else {
    console.log(`✅ Slack sent OK (${blocks.length} blocks)`);
  }
}

const fmt = n => '$' + Math.round(n||0).toLocaleString('es-MX');

// 9am — Resumen del día con presión
async function slackResumenManana() {
  try {
    const d = await getDatosVendedor();
    const act = d.actividades;
    const pip = d.pipeline;
    const kpis = d.kpis;

    const hayProblemas = act.vencidas.length > 0 || pip.sin_actividad_3dias.length > 0 || kpis.leads_hoy_sin_actividad > 0;

    const frase = getFraseDelDia();
    const vendedor = d.vendedor || 'Vendedor';

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`☀️ Buenos días, ${vendedor} — Reporte de ventas ${d.fecha}` }},
      { type:'section', text:{ type:'mrkdwn', text:`💬 _"${frase}"_` }},
      { type:'divider' },
      // Actividades hoy
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📋 Para hoy (${act.hoy.length})*\n${act.hoy.length > 0 ? act.hoy.map(a=>`• ${a.tipo||'Tarea'}: _${a.lead}_`).join('\n') : '✅ Sin actividades — ¿ya las programó?'}` },
        { type:'mrkdwn', text:`*📅 Reuniones (${d.reuniones.length})*\n${d.reuniones.length > 0 ? d.reuniones.map(r=>`• ${r.nombre} ${r.inicio?.split('T')[1]?.slice(0,5)||''}`).join('\n') : '— Sin reuniones hoy'}` },
      ]},
      // KPIs rápidos
      { type:'section', fields:[
        { type:'mrkdwn', text:`*💰 Pipeline total*\n${pip.total_oportunidades} oportunidades · ${fmt(pip.valor_total)}` },
        { type:'mrkdwn', text:`*🆕 Oportunidades nuevas hoy*\n${d.op_nuevas_hoy?.length||0} nuevas · ${d.contactos_nuevos_hoy?.length||0} contactos nuevos` },
      ]},
      // Por vendedor
      ...Object.values(d.vendedores||{}).map(v => ({
        type:'section',
        text:{ type:'mrkdwn', text:`*👤 ${v.nombre}*\n🆕 ${v.opNuevasHoy.length} oportunidades nuevas hoy\n📄 ${v.cotizaciones.length} cotizaciones activas${v.cotizacionesCriticas.length>0?' · 🔥 '+v.cotizacionesCriticas.length+' críticas (+3d)':''}` }
      })),
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📊 Promedio actividades semana*\n${d.actividades_completadas?.promedio_diario_semana||0}/día` },
        { type:'mrkdwn', text:`*👥 Contactos nuevos hoy*\n${d.contactos_nuevos_hoy?.length||0}${d.contactos_nuevos_hoy?.length>0?' · '+d.contactos_nuevos_hoy.slice(0,2).map(c=>c.nombre).join(', '):''}` },
      ]},
      { type:'divider' },
      // ALERTAS — sección de presión
      ...( act.vencidas.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`📋 *Tienes ${act.vencidas.length} actividad(es) pendiente(s) de días anteriores — buen momento para retomar el contacto* 💪\n${act.vencidas.map(a=>`• ${a.lead} — ${a.tipo}`).join('\n')}` }
      }] : []),
      // Cotizaciones críticas por vendedor
    ...Object.values(d.vendedores||{}).filter(v=>v.cotizacionesCriticas.length>0).map(v=>({
      type:'section',
      text:{ type:'mrkdwn', text:`🔥 *${v.nombre} — ${v.cotizacionesCriticas.length} cotización(es) sin seguimiento +3 días:*\n${v.cotizacionesCriticas.slice(0,3).map(o=>`• ${o.nombre} · ${fmt(o.expected_revenue||0)} · ${o.dias_en_cotizacion}d`).join('\n')}\n_Una llamada puede acelerar el cierre._` }
    })),
    ...( pip.sin_actividad_3dias.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`💡 *${pip.sin_actividad_3dias.length} oportunidad(es) listas para retomar — llevan unos días sin contacto*\n${pip.sin_actividad_3dias.slice(0,5).map(op=>`• ${op.nombre} · ${op.etapa} · ${fmt(op.valor)}`).join('\n')}\n_Una llamada hoy puede hacer la diferencia._` }
      }] : []),
      ...( kpis.leads_hoy_sin_actividad > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`📥 *${kpis.leads_hoy_sin_actividad} lead(s) nuevo(s) hoy sin actividad programada*\nPuedes programarles una llamada para mantener el momentum. 🚀` }
      }] : []),
      ...( !hayProblemas ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`✅ *Excelente arranque* — todo al día y pipeline activo. ¡Hoy puede ser un gran día!` }
      }] : []),
      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks Supervisor · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }]}
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Resumen mañana enviado');
  } catch(err) { console.error('Error resumen:', err.message); }
}

// 6pm — Cierre con evaluación del día
async function slackCierreDia() {
  try {
    const d = await getDatosVendedor();
    const act = d.actividades;
    const pip = d.pipeline;
    const kpis = d.kpis;
    const ventasHoy = d.ventas_hoy;
    const hayVentas = (ventasHoy?.count || 0) > 0;
    const TI = {'Call':'📞','Llamada':'📞','Meeting':'🤝','Reunión':'🤝','Email':'📧','Correo electrónico':'📧','WhatsApp':'📱','Todo':'✅'};
    const ti = t => Object.entries(TI).find(([k])=>t?.includes(k))?.[1]||'✅';

    // Pipeline ACTIVO — excluir ganadas/won
    const etapasExcluir = ['won','ganado','perdido','lost'];
    const etapasActivas = Object.entries(pip.por_etapa||{})
      .filter(([etapa]) => !etapasExcluir.some(x => etapa.toLowerCase().includes(x)));
    const pipelineActivo = etapasActivas.reduce((a,[,v]) => a + (v.total||0), 0);
    const opActivas = etapasActivas.reduce((a,[,v]) => a + (v.count||0), 0);





    // Cierres del mes por vendedor
    const cierresMesPorVendedor = {};
    (kpis.ganados_detalle||[]).forEach(g => {
      // ganados_detalle no tiene vendedor — usamos por_vendedor de ventas_hoy como proxy
    });
    // Usar ganadosMes desde pipeline por_etapa Won
    const wonOpps = (pip.por_etapa?.['Won']?.oportunidades || pip.por_etapa?.['Ganado']?.oportunidades || []);
    // Better: use d.ventas_hoy.por_vendedor which has month data
    const cierresMes = d.ventas_hoy?.por_vendedor || {};

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`🌙 Cierre del día — ${d.fecha}` }},

      // ── RESUMEN TOTAL ──
      { type:'section', text:{ type:'mrkdwn', text:'*── RESUMEN TOTAL ──────────────────*' }},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*💰 Ventas del día*\n${hayVentas ? fmt(ventasHoy.total)+' · '+ventasHoy.count+' cierre'+(ventasHoy.count>1?'s':'') : 'Sin cierres hoy'}` },
        { type:'mrkdwn', text:`*📊 Pipeline activo*\n${opActivas} oport. · ${fmt(pipelineActivo)}` },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*🎯 Ganados este mes*\n${kpis.ganados_mes} cierres · ${fmt(kpis.valor_ganado_mes)}` },
        { type:'mrkdwn', text:`*📈 Conversión · Contactos*\n${kpis.tasa_conversion}% · ${kpis.contactos_hoy} nuevo(s) hoy` },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*🆕 Oportunidades nuevas hoy*\n${d.op_nuevas_hoy?.length||0}${d.op_nuevas_hoy?.length>0?' · '+d.op_nuevas_hoy.slice(0,2).map(o=>o.nombre).join(', '):''}` },
        { type:'mrkdwn', text:`*✅ Actividades completadas*\n${d.actividades_completadas?.hoy||0} total · Promedio ${d.actividades_completadas?.promedio_diario_semana||0}/día` },
      ]},
      { type:'divider' },

      // ── POR VENDEDOR ──
      ...Object.values(d.vendedores||{}).flatMap(v => {
        const actVend = (d.actividades_completadas?.por_vendedor_hoy||{})[v.nombre] || {};
        const actTotal = Object.values(actVend).reduce((a,n)=>a+n,0);
        const cierresHoyVend = ventasHoy?.ganadas?.filter(g=>g.vendedor===v.nombre)||[];
        const totalCierresHoy = cierresHoyVend.reduce((a,g)=>a+(g.monto||0),0);
        const cierresMesVend = cierresMes[v.nombre];
        const notasDestacadas = (d.bitacora_dia?.actividades||[])
          .flatMap(g => g.leads.filter(l=>l.texto))
          .filter(l => {
            const act = actCompletadasDelVendedor(d, v.nombre, l.lead);
            return true; // show all notes
          })
          .slice(0,4);

        const vendorBlocks = [
          { type:'section', text:{ type:'mrkdwn', text:`*── ${v.nombre.toUpperCase()} ─────────────────*` }},
          { type:'section', fields:[
            { type:'mrkdwn', text:`*💰 Cierres hoy*\n${cierresHoyVend.length>0?fmt(totalCierresHoy)+' ('+cierresHoyVend.length+')':'Sin cierres hoy'}` },
            { type:'mrkdwn', text:`*🏆 Cierres este mes*\n${cierresMesVend?fmt(cierresMesVend.total)+' ('+cierresMesVend.count+' cierre'+(cierresMesVend.count>1?'s':'')+')'  :'Sin datos'}` },
          ]},
          { type:'section', fields:[
            { type:'mrkdwn', text:`*📊 Pipeline*\n${v.totalOportunidades} oport. · ${fmt(v.totalPipeline)}` },
            { type:'mrkdwn', text:`*📄 Cotizaciones*\n${v.cotizaciones.length} activas${v.cotizacionesCriticas.length>0?' · 🔥 '+v.cotizacionesCriticas.length+' críticas':''}` },
          ]},
          { type:'section', text:{ type:'mrkdwn', text:
            `*✅ Actividades (${actTotal}):* ${actTotal>0?Object.entries(actVend).map(([t,n])=>ti(t)+' '+t+' '+n).join(' · '):'Sin actividades completadas hoy'}`
          }},
        ];

        // Notas destacadas (leads con comentario)
        const notasLead = (d.bitacora_dia?.actividades||[]).flatMap(g=>g.leads.filter(l=>l.texto)).slice(0,4);
        if (notasLead.length > 0) {
          vendorBlocks.push({
            type:'section',
            text:{ type:'mrkdwn', text:'*📋 Notas destacadas:*\n'+notasLead.map(l=>`• _${l.lead}_ — "${l.texto.slice(0,100)}"`).join('\n') }
          });
        }

        vendorBlocks.push({ type:'divider' });
        return vendorBlocks;
      }),





      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks Supervisor · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }]},
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Cierre enviado');
  } catch(err) { console.error('Error cierre:', err.message); }
}

// Helper — no usado pero evita error de referencia
function actCompletadasDelVendedor(d, nombre, lead) { return true; }


async function slackAlertaHoraria() {
  try {
    const d = await getDatosVendedor();
    const vencidas = d.actividades.vencidas;
    const sin3 = d.pipeline?.sin_actividad_3dias || [];
    const criticos = d.leads_calientes?.criticos || [];
    const leadsSA = d.leads_prospectos?.detalle_sin_actividad || [];
    const totalLeadsSA = d.leads_prospectos?.sin_actividad || 0;

    // No mandar nada si todo está en orden
    if (vencidas.length === 0 && sin3.length === 0 && criticos.length === 0 && totalLeadsSA === 0) return;

    const lineas = [];
    if (vencidas.length > 0) {
      lineas.push(`*📋 ${vencidas.length} actividad(es) de días anteriores lista(s) para retomar:*`);
      vencidas.slice(0,5).forEach(a => lineas.push(`• ${a.lead} — ${a.tipo||'Seguimiento pendiente'}`));
    }
    if (totalLeadsSA > 0) {
      lineas.push(`\n*👥 ${totalLeadsSA} lead(s) sin actividad programada — necesitan una próxima acción:*`);
      leadsSA.slice(0,5).forEach(l => lineas.push(`• ${l.nombre}${l.dias>0?' · '+l.dias+'d sin acción':' · creado hoy'}`));
      lineas.push('_Programa una llamada o email para cada uno._');
    }
    if (sin3.length > 0) {
      lineas.push(`\n*💡 ${sin3.length} oportunidad(es) listas para retomar hoy:*`);
      sin3.slice(0,5).forEach(op => lineas.push(`• ${op.nombre} · ${op.etapa} · ${fmt(op.valor)}`));
      lineas.push('_Un mensaje o llamada corta puede reactivarlos._');
    }
    if (criticos.length > 0) {
      lineas.push(`\n*🔥 ${criticos.length} cotización(es) con +3 días sin respuesta:*`);
      criticos.slice(0,5).forEach(op => lineas.push(`• ${op.nombre} · ${op.cliente} · ${fmt(op.valor)} · ${op.dias}d desde la propuesta`));
      lineas.push('_Una llamada amigable puede acelerar la decisión._');
    }

    const blocks = [
      { type:'section', text:{ type:'mrkdwn', text: lineas.join('\n') }},
      { type:'context', elements:[{ type:'mrkdwn', text:`Alerta automática · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }]}
    ];

    await sendSlack(SLACK_WEBHOOK_ALERTS, blocks);
    console.log(`✅ Alerta horaria: ${vencidas.length} vencidas, ${sin3.length} sin actividad`);
  } catch(err) { console.error('Error alerta:', err.message); }
}


// ── RESUMEN SEMANAL (Sábados 9am) ───────────────────
async function slackResumenSemanal() {
  try {
    const d = await getDatosVendedor();
    const act = d.actividades;
    const pip = d.pipeline;
    const kpis = d.kpis;
    const vendedor = d.vendedor || 'Jonathan';
    const frase = getFraseDelDia();
    const hoy = new Date();
    const lunesStr = new Date(hoy.setDate(hoy.getDate()-5)).toLocaleDateString('es-MX',{day:'numeric',month:'long',timeZone:TZ});
    const sabStr = new Date().toLocaleDateString('es-MX',{day:'numeric',month:'long',timeZone:TZ});

    const actTipos = d.actividades_completadas?.por_tipo_hoy || {};
    const actResumen = Object.keys(actTipos).length > 0
      ? Object.entries(actTipos).map(([t,n]) => '• '+t+': '+n).join('\n')
      : '— Registra tus actividades en Odoo para verlas aquí';

    const puntos = [];
    if (kpis.ganados_mes > 0) puntos.push('✅ '+kpis.ganados_mes+' cierre(s) este mes — ¡excelente!');
    else puntos.push('📌 Sin cierres aún — hay oportunidades listas en el pipeline');
    if (kpis.nuevos_semana > 0) puntos.push('✅ '+kpis.nuevos_semana+' leads nuevos esta semana');
    else puntos.push('💡 La próxima semana es buena para generar leads frescos');
    if (pip.sin_actividad_3dias.length === 0) puntos.push('✅ Todas las oportunidades con seguimiento activo');
    else puntos.push('💡 '+pip.sin_actividad_3dias.length+' oportunidad(es) para retomar el lunes');

    const calientes = d.leads_calientes || {};
    const pendientes = pip.sin_actividad_3dias || [];

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:'📅 Resumen semanal, '+vendedor+' — '+lunesStr+' al '+sabStr }},
      { type:'section', text:{ type:'mrkdwn', text:'💬 _"'+frase+'"_' }},
      { type:'divider' },
      { type:'section', fields:[
        { type:'mrkdwn', text:'*🆕 Leads nuevos esta semana*\n'+kpis.nuevos_semana+' nuevos contactos' },
        { type:'mrkdwn', text:'*🎯 Ganados este mes*\n'+kpis.ganados_mes+' cierres · '+fmt(kpis.valor_ganado_mes) },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:'*📊 Pipeline activo*\n'+pip.total_oportunidades+' oportunidades · '+fmt(pip.valor_total) },
        { type:'mrkdwn', text:'*📈 Tasa de conversión*\n'+kpis.tasa_conversion+'%' },
      ]},
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn', text:'*📝 Actividades completadas esta semana*\n'+actResumen }},
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn', text:'*🏁 Evaluación de la semana:*\n'+puntos.join('\n') }},
      ...(calientes.total > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:'*🔥 '+calientes.total+' cotización(es) activas — '+fmt(calientes.valor_total)+' en juego*\n'+
          calientes.todos.slice(0,5).map(op=>'• '+op.nombre+' · '+fmt(op.valor)+' · '+op.dias+'d en propuesta').join('\n')+
          '\n_¡La próxima semana es clave para cerrar estas!_' }
      }] : []),
      ...(pendientes.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:'*🌅 Oportunidades para arrancar fuerte el lunes:*\n'+
          pendientes.slice(0,5).map(op=>'• '+op.nombre+' — '+fmt(op.valor)).join('\n') }
      }] : []),
      { type:'section', text:{ type:'mrkdwn', text:'*¡Buen fin de semana, '+vendedor+'! El lunes seguimos. 💪*' }},
      { type:'context', elements:[{ type:'mrkdwn', text:'Todo Decks Supervisor · Resumen semanal · '+new Date().toLocaleString('es-MX',{timeZone:TZ}) }]}
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Resumen semanal enviado');
  } catch(err) { console.error('Error resumen semanal:', err.message); }
}


// ── BITÁCORA DEL DÍA ─────────────────────────────────
async function slackBitacoraDia() {
  try {
    const d = await getDatosVendedor();
    const vendedor = d.vendedor || 'Jonathan';
    const TIPO_ICON = {'Llamada':'📞','Call':'📞','Reunión':'🤝','Meeting':'🤝','Email':'📧','WhatsApp':'📱','Todo':'✅','Correo':'📧'};
    const ti = t => Object.entries(TIPO_ICON).find(([k])=>t?.includes(k))?.[1]||'✅';

    const lineas = [];

    // Usar actividades.hoy que SÍ funciona — programadas para hoy
    const actHoy = d.actividades?.hoy || [];
    const actCompletadas = d.actividades_completadas;

    // Agrupar actividades de hoy por tipo
    const porTipo = {};
    actHoy.forEach(a => {
      const tipo = a.tipo || 'Actividad';
      if (!porTipo[tipo]) porTipo[tipo] = [];
      porTipo[tipo].push(a);
    });

    // Usar actividades_completadas — exactamente lo mismo que el cierre del día
    const actComp = d.actividades_completadas;
    const totalComp = actComp?.hoy || 0;
    const porTipoComp = actComp?.por_tipo_hoy || {};

    if (totalComp > 0) {
      lineas.push(`*✅ Actividades completadas hoy (${totalComp}):*`);
      Object.entries(porTipoComp).forEach(([tipo, count]) => {
        lineas.push(`${ti(tipo)} *${tipo}:* ${count}`);
      });
    } else {
      lineas.push(`*📋 Actividades programadas para hoy (${actHoy.length}):*`);
      Object.entries(porTipo).forEach(([tipo, acts]) => {
        lineas.push(`${ti(tipo)} *${tipo}:* ${acts.length} · ${acts.map(a=>a.lead).slice(0,3).join(', ')}${acts.length>3?` +${acts.length-3} más`:''}`);
      });
      lineas.push(`
_Recuerda marcar cada actividad como ✅ Hecho en Odoo_`);
    }

    // Detalle por lead — usando bitacora_dia para los comentarios
    const bitacora = d.bitacora_dia;
    if (bitacora?.actividades?.length > 0) {
      lineas.push(`
*📝 Detalle por lead:*`);
      bitacora.actividades.forEach(grupo => {
        const conNota = grupo.leads.filter(l=>l.texto);
        if (conNota.length > 0) {
          lineas.push(`
${ti(grupo.tipo)} *${grupo.tipo}*`);
          conNota.slice(0,5).forEach(l => lineas.push(`  • _${l.lead}_ — "${l.texto}"`));
        }
      });
    }

    // Notas manuales del chatter
    const conMensajes = Object.values(bitacora?.mensajes_por_lead||{}).filter(l=>l.mensajes.length>0);
    if (conMensajes.length > 0) {
      lineas.push(`
*💬 Notas adicionales (${conMensajes.length} leads):*`);
      conMensajes.slice(0,5).forEach(l => {
        lineas.push(`
📝 *${l.nombre}*`);
        l.mensajes.slice(0,2).forEach(m => lineas.push(`  ${m.hora} — "${m.texto}"`));
      });
    }

    // Resumen del pipeline para contexto
    const pip = d.pipeline;
    const kpis = d.kpis;
    lineas.push(`
*📊 Estado del pipeline:*`);
    lineas.push(`• ${pip.total_oportunidades} oportunidades · ${fmt(pip.valor_total)} en juego`);
    if (kpis.ganados_mes > 0) lineas.push(`• 🏆 ${kpis.ganados_mes} cierres este mes · ${fmt(kpis.valor_ganado_mes)}`);
    if (d.reuniones?.length > 0) {
      lineas.push(`
*📅 Reuniones de hoy:*`);
      d.reuniones.forEach(r => lineas.push(`  • ${r.nombre} · ${r.inicio?.split('T')[1]?.slice(0,5)||'—'}`));
    }

    if (lineas.length === 0) lineas.push('_Sin actividades registradas hoy._');

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`📋 Bitácora del día — ${vendedor} · ${d.fecha}` }},
      { type:'section', text:{ type:'mrkdwn', text: lineas.join('\n') }},
      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks Supervisor · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }]}
    ];
    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Bitácora enviada');
  } catch(err) { console.error('Error bitácora:', err.message); }
}

// ── SCHEDULERS ────────────────────────────────────────
// 9:00am Cancún (L-S)
cron.schedule('0 9 * * 1-5', slackResumenManana, { timezone: TZ });
// Sábado — resumen semanal 9am (único mensaje)
cron.schedule('0 9 * * 6', slackResumenSemanal, { timezone: TZ });
// 6:00pm Cancún (L-S)
cron.schedule('0 18 * * 1-5', slackCierreDia,    { timezone: TZ });
// Cada hora 10am-5pm Cancún
cron.schedule('0 10-17 * * 1-5', slackAlertaHoraria, { timezone: TZ });
// Alerta especial 2pm — leads sin seguimiento del día
cron.schedule('0 14 * * 1-5', async () => {
  try {
    const d = await getDatosVendedor();
    if ((d.leads_prospectos?.nuevos_sin_actividad||0) > 0) {
      await sendSlack(SLACK_WEBHOOK_ALERTS, [{
        type:'section',
        text:{ type:'mrkdwn', text:`⏰ *Recordatorio de la tarde:* Tienes ${d.kpis.leads_hoy_sin_actividad} lead(s) nuevo(s) que aún no tienen actividad programada. ¡Todavía hay tiempo para hacer ese primer contacto hoy! 💪` }
      }]);
    }
  } catch(e){}
}, { timezone: TZ });

console.log('\n✅ Todo Decks Supervisor corriendo en http://localhost:'+PORT);
console.log('⏰ Schedulers:');
console.log('   9:00am → Resumen del día');
console.log('   6:00pm → Cierre y evaluación');
console.log('   Cada hora (10am-5pm) → Alerta si hay problemas');
console.log('   2:00pm → Recordatorio leads sin seguimiento\n');

// ── API ───────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  try {
    const { sessionId } = await odooAuth();
    const hoy = new Date();
    const CANCUN_OFFSET_MS = 5 * 60 * 60 * 1000;
    const cancunNow = new Date(hoy.getTime() - CANCUN_OFFSET_MS);
    const hoyStr = cancunNow.toISOString().split('T')[0];
    const hoySiguienteStr = new Date(cancunNow.getTime() + 24*60*60*1000).toISOString().split('T')[0];
    const hoyInicioUTC = hoyStr + ' 05:00:00';
    const hoyFinUTC = hoySiguienteStr + ' 05:00:00';

    // Get last 10 mail.messages in CRM leads
    const msgs = await odooCall(sessionId, 'mail.message', 'search_read',
      [[['model','=','crm.lead']]],
      { fields:['id','date','body','mail_activity_type_id','record_name'], limit:10,
        order:'date desc' }
    );

    res.json({
      utc_now: hoy.toISOString(),
      cancun_now: cancunNow.toISOString(),
      hoyStr,
      hoyInicioUTC,
      hoyFinUTC,
      last_10_messages: msgs.map(m=>({
        id: m.id, date: m.date, record: m.record_name,
        activity_type: m.mail_activity_type_id,
        body_preview: (m.body||'').replace(/<[^>]*>/g,'').slice(0,50)
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({
  status:'ok', odoo: ODOO_URL||'no config', slack: SLACK_WEBHOOK?'✅':'⚠️ no config'
}));

app.get('/api/datos', async (req, res) => {
  try { res.json(await getDatosVendedor()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slack/resumen', async (req, res) => {
  try { await slackResumenManana(); res.json({ ok:true, mensaje:'Resumen enviado' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slack/cierre', async (req, res) => {
  try { await slackCierreDia(); res.json({ ok:true, mensaje:'Cierre enviado' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slack/bitacora', async (req, res) => {
  try { await slackBitacoraDia(); res.json({ ok:true, mensaje:'Bitácora enviada' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slack/semanal', async (req, res) => {
  try { await slackResumenSemanal(); res.json({ ok:true, mensaje:'Resumen semanal enviado' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/slack/alerta', async (req, res) => {
  try { await slackAlertaHoraria(); res.json({ ok:true, mensaje:'Alerta enviada' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
