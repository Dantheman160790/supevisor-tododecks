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
  const hoyStr = hoy.toISOString().split('T')[0];
  const en3dias = new Date(hoy); en3dias.setDate(hoy.getDate() + 3);
  const en3diasStr = en3dias.toISOString().split('T')[0];
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
    { fields:['id','name','partner_name','expected_revenue','date_closed'], limit:200 }
  );

  // Leads nuevos esta semana
  const nuevosSemanales = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['create_date','>=',inicioSemana.toISOString().split('T')[0]+' 00:00:00']]],
    { fields:['id','name','type','partner_name','create_date'], limit:200 }
  );

  // Contactos nuevos hoy
  const contactosHoy = await odooCall(sessionId, 'res.partner', 'search_read',
    [[['create_date','>=',hoyStr+' 00:00:00'],['create_date','<=',hoyStr+' 23:59:59']]],
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
    [[['start','>=',hoyStr+' 00:00:00'],['start','<=',hoyStr+' 23:59:59']]],
    { fields:['id','name','start','stop','location'], limit:50 }
  );

  // Leads nuevos HOY sin actividad programada
  const leadsHoy = nuevosSemanales.filter(l =>
    l.create_date?.startsWith(hoyStr) && l.type === 'opportunity'
  );
  const leadsHoySinActividad = leadsHoy.filter(l =>
    !actividades.some(a => a.res_id === l.id)
  );

  // Actividades CREADAS hoy por el vendedor
  const actCreadasHoy = await odooCall(sessionId, 'mail.activity', 'search_read',
    [[['create_date','>=',hoyStr+' 00:00:00'],
      ['create_date','<=',hoyStr+' 23:59:59']]],
    { fields:['id','activity_type_id','res_name','user_id','date_deadline','summary'], limit:200 }
  );

  // Actividades creadas esta semana (para tendencia)
  const actCreadasSemana = await odooCall(sessionId, 'mail.activity', 'search_read',
    [[['create_date','>=',inicioSemana.toISOString().split('T')[0]+' 00:00:00']]],
    { fields:['id','activity_type_id','user_id','create_date'], limit:500 }
  );

  // Contar por tipo — hoy
  const conteoHoy = {};
  actCreadasHoy.forEach(a => {
    const tipo = a.activity_type_id?.[1] || 'Otra';
    conteoHoy[tipo] = (conteoHoy[tipo] || 0) + 1;
  });

  // Promedio diario esta semana
  const diasTranscurridos = Math.max(1, new Date().getDay() || 7);
  const promedioDiario = Math.round(actCreadasSemana.length / diasTranscurridos);

  // Tendencia: hoy vs promedio
  const tendencia = actCreadasHoy.length >= promedioDiario ? 'arriba' : 'abajo';

  // Ventas del día — solo CRM ganadas (orden de compra confirmada)
  const ganadadasHoy = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['stage_id.is_won','=',true],
      ['date_closed','>=',hoyStr+' 00:00:00'],
      ['date_closed','<=',hoyStr+' 23:59:59']]],
    { fields:['id','name','partner_name','expected_revenue','date_closed'], limit:100 }
  );
  const totalDia = Math.round(ganadadasHoy.reduce((a,v) => a+(v.expected_revenue||0), 0));

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

  const totalPipeline = oportunidades.reduce((a,op) => a+(op.expected_revenue||0), 0);

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
      total_oportunidades: oportunidades.length,
      valor_total: Math.round(totalPipeline),
      ticket_promedio: oportunidades.length > 0 ? Math.round(totalPipeline/oportunidades.length) : 0,
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
      ganados_detalle: ganadosMes.slice(0,5).map(l => ({ nombre: l.name, cliente: l.partner_name, valor: l.expected_revenue })),
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
        nombre: v.name, cliente: v.partner_name, monto: v.expected_revenue
      })),
      count: ganadadasHoy.length,
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
    actividades_creadas: {
      hoy: actCreadasHoy.length,
      por_tipo_hoy: conteoHoy,
      promedio_diario_semana: promedioDiario,
      tendencia,
      detalle_hoy: actCreadasHoy.slice(0,10).map(a => ({
        tipo: a.activity_type_id?.[1], lead: a.res_name,
        user: a.user_id?.[1], deadline: a.date_deadline, resumen: a.summary||''
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
  if (!webhookUrl) return;
  const r = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });
  if (!r.ok) console.error('Slack error:', r.status, await r.text());
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
        { type:'mrkdwn', text:`*📝 Actividades creadas ayer*\n${d.actividades_creadas?.promedio_diario_semana > 0 ? 'Promedio semana: '+d.actividades_creadas.promedio_diario_semana+'/día' : 'Sin datos aún'}` },
        { type:'mrkdwn', text:`*💰 Pipeline*\n${pip.total_oportunidades} oportunidades · ${fmt(pip.valor_total)}` },
      ]},
      { type:'divider' },
      // ALERTAS — sección de presión
      ...( act.vencidas.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`📋 *Tienes ${act.vencidas.length} actividad(es) pendiente(s) de días anteriores — buen momento para retomar el contacto* 💪\n${act.vencidas.map(a=>`• ${a.lead} — ${a.tipo}`).join('\n')}` }
      }] : []),
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
    const kpis = d.kpis;
    const pip = d.pipeline;

    // Evaluación del desempeño del día
    let evaluacion = '';
    const puntos = [];
    if (act.vencidas.length === 0) puntos.push('✅ Actividades al día — sin pendientes');
    else puntos.push(`💪 ${act.vencidas.length} actividad(es) de días anteriores — mañana es buen momento para retomar`);
    if (kpis.contactos_hoy > 0) puntos.push(`✅ ${kpis.contactos_hoy} contacto(s) nuevo(s) — ¡bien hecho!`);
    else puntos.push('📌 Mañana hay oportunidad de agregar contactos nuevos al pipeline');
    if (pip.sin_actividad_3dias.length === 0) puntos.push('✅ Todas las oportunidades con seguimiento activo');
    else puntos.push(`💡 ${pip.sin_actividad_3dias.length} oportunidad(es) listas para retomar mañana`);

    const ventasHoy = d.ventas_hoy;
    const hayVentas = (ventasHoy?.count || 0) > 0;

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`🌙 Cierre del día — ${d.fecha}` }},
      { type:'divider' },
      // Ventas del día — sección destacada
      ...(hayVentas ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`🏆 *VENTAS DEL DÍA — ${fmt(ventasHoy.total)}*\n${ventasHoy.ganadas.map(v=>`• ${v.nombre} · ${v.cliente} · ${fmt(v.monto)}`).join('\n')}` }
      }] : [{
        type:'section',
        text:{ type:'mrkdwn', text:`💵 *Ventas del día*\nHoy se sembraron las bases para los cierres de mañana. 🌱` }
      }]),
      { type:'section', fields:[
        { type:'mrkdwn', text:`*🎯 Ganados este mes*\n${kpis.ganados_mes} cierres · ${fmt(kpis.valor_ganado_mes)}` },
        { type:'mrkdwn', text:`*📈 Tasa de conversión*\n${kpis.tasa_conversion}%` },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*🆕 Leads nuevos esta semana*\n${kpis.nuevos_semana} nuevos` },
      ]},
      // Actividades completadas del día
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📝 Actividades creadas hoy*\n${d.actividades_creadas?.hoy > 0
          ? Object.entries(d.actividades_creadas.por_tipo_hoy).map(([t,n])=>`• ${t}: ${n}`).join('\n')+'\n_Promedio semana: '+d.actividades_creadas.promedio_diario_semana+'/día_'
          : '⚠️ Sin actividades creadas hoy'}` },
        { type:'mrkdwn', text:`*👤 Contactos nuevos hoy*\n${kpis.contactos_hoy} contacto(s)` },
        { type:'mrkdwn', text:`*👤 Contactos agregados hoy*\n${kpis.contactos_hoy}` },
      ]},
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn',
        text:`*📊 Evaluación del día:*\n${puntos.join('\n')}` }
      },
      ...( kpis.ganados_detalle?.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`*🏆 Cierres del mes:*\n${kpis.ganados_detalle.map(g=>`• ${g.nombre} — ${fmt(g.valor||0)}`).join('\n')}` }
      }] : []),
      ...( pip.sin_actividad_3dias.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`🌅 *Oportunidades para arrancar fuerte mañana:*\n${pip.sin_actividad_3dias.slice(0,5).map(op=>`• ${op.nombre} — ${fmt(op.valor)}`).join('\n')}\n_¡Cada uno de estos puede ser el próximo cierre!_` }
      }] : []),
      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks Supervisor · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }]}
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Cierre enviado');
  } catch(err) { console.error('Error cierre:', err.message); }
}

// Alerta horaria — solo si hay problemas reales
async function slackAlertaHoraria() {
  try {
    const d = await getDatosVendedor();
    const vencidas = d.actividades.vencidas;
    const sin3 = d.pipeline?.sin_actividad_3dias || [];

    const calientes = d.pipeline?.sin_actividad_3dias || [];
    const criticos = d.leads_calientes?.criticos || [];
    if (vencidas.length === 0 && sin3.length === 0 && criticos.length === 0) return;

    const lineas = [];
    if (vencidas.length > 0) {
      lineas.push(`*🚨 ${vencidas.length} actividad(es) vencida(s):*`);
      vencidas.slice(0,5).forEach(a => lineas.push(`• *${a.lead}* — ${a.tipo||'Tarea'} (${a.dias_vencida}d atrasada)`));
    }
    if (sin3.length > 0) {
      lineas.push(`\n*⚠️ ${sin3.length} lead(s) sin contacto en +3 días:*`);
      sin3.slice(0,5).forEach(op => lineas.push(`• *${op.nombre}* · ${op.etapa} · ${op.dias}d parado · ${fmt(op.valor)}`));
      lineas.push('_Acción requerida: programar actividad hoy._');
    }
    if (criticos.length > 0) {
      lineas.push(`\n*🔥 ${criticos.length} cotización(es) sin respuesta en +5 días — riesgo de perder el lead:*`);
      criticos.slice(0,5).forEach(op => lineas.push(`• *${op.nombre}* · ${op.cliente} · ${fmt(op.valor)} · ${op.dias}d sin respuesta`));
      lineas.push('_Llamar HOY — cotización fría en 3 días._');
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

    const actTipos = d.actividades_creadas?.por_tipo_hoy || {};
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
      { type:'section', text:{ type:'mrkdwn', text:'*📝 Actividades creadas esta semana*\n'+actResumen }},
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
    if (d.kpis.leads_hoy_sin_actividad > 0) {
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
