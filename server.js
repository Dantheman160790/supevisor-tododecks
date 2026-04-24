/**
 * Todo Decks — Servidor Supervisor de Vendedor
 * Tablero de supervisión + Slack notifications + Scheduler
 * Deploy: Railway · Puerto: process.env.PORT || 4000
 */

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const path    = require('path');

const app  = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ──────────────────────────────────────────────
const ODOO_URL    = process.env.ODOO_URL;
const ODOO_DB     = process.env.ODOO_DB;
const ODOO_USER   = process.env.ODOO_USER;
const ODOO_PASS   = process.env.ODOO_PASS;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;   // https://hooks.slack.com/services/...
const SLACK_WEBHOOK_ALERTS = process.env.SLACK_WEBHOOK_ALERTS || process.env.SLACK_WEBHOOK;
const PORT        = process.env.PORT || 4000;
const TZ          = 'America/Cancun';

// ── ODOO HELPERS ─────────────────────────────────────
async function odooAuth() {
  const r = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:1,
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS } })
  });
  const d = await r.json();
  if (!d.result?.uid) throw new Error('Auth Odoo falló: ' + JSON.stringify(d.error));
  return { sessionId: r.headers.get('set-cookie'), uid: d.result.uid };
}

async function odooCall(sessionId, model, method, args=[], kwargs={}) {
  const r = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionId },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:1,
      params: { model, method, args, kwargs: { ...kwargs, context: { lang:'es_MX' } } } })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.data?.message || JSON.stringify(d.error));
  return d.result;
}

// ── OBTENER DATOS DEL VENDEDOR ────────────────────────
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
  const actVencidas  = actividades.filter(a => new Date(a.date_deadline) < hoyDate);
  const actHoy       = actividades.filter(a => a.date_deadline === hoyStr);
  const actProximas  = actividades.filter(a => {
    const d = new Date(a.date_deadline);
    return d > hoyDate && a.date_deadline <= en3diasStr;
  });

  // Pipeline
  const oportunidades = await odooCall(sessionId, 'crm.lead', 'search_read',
    [[['type','=','opportunity'],['active','=',true]]],
    { fields:['id','name','partner_name','stage_id','expected_revenue','probability',
              'user_id','date_last_stage_update','create_date'], limit:300 }
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

  // Reuniones de hoy
  const reuniones = await odooCall(sessionId, 'calendar.event', 'search_read',
    [[['start','>=',hoyStr+' 00:00:00'],['start','<=',hoyStr+' 23:59:59']]],
    { fields:['id','name','start','stop','partner_ids','description','location'], limit:50 }
  );

  const totalPipeline = oportunidades.reduce((a,op) => a+(op.expected_revenue||0), 0);
  const estancadas = oportunidades.filter(op => op.dias_sin_movimiento > 7);

  return {
    fecha: hoyStr,
    actividades: {
      vencidas:  actVencidas.map(a => ({
        lead: a.res_name, tipo: a.activity_type_id?.[1], fecha: a.date_deadline,
        resumen: a.summary, user: a.user_id?.[1],
        dias_vencida: Math.floor((hoy - new Date(a.date_deadline)) / (1000*60*60*24))
      })),
      hoy:       actHoy.map(a => ({ lead: a.res_name, tipo: a.activity_type_id?.[1],
                   fecha: a.date_deadline, resumen: a.summary, user: a.user_id?.[1] })),
      proximas:  actProximas.map(a => ({ lead: a.res_name, tipo: a.activity_type_id?.[1],
                   fecha: a.date_deadline, resumen: a.summary, user: a.user_id?.[1] })),
    },
    pipeline: {
      por_etapa: porEtapa,
      total_oportunidades: oportunidades.length,
      valor_total: Math.round(totalPipeline),
      ticket_promedio: oportunidades.length > 0 ? Math.round(totalPipeline/oportunidades.length) : 0,
      estancadas: estancadas.map(op => ({
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
      tasa_conversion: (oportunidades.length + ganadosMes.length) > 0
        ? Math.round((ganadosMes.length / (oportunidades.length + ganadosMes.length)) * 100) : 0,
    },
    reuniones: reuniones.map(r => ({
      nombre: r.name, inicio: r.start, fin: r.stop,
      lugar: r.location || '—', descripcion: r.description || ''
    })),
  };
}

// ── SLACK HELPERS ─────────────────────────────────────
async function sendSlack(webhookUrl, blocks) {
  if (!webhookUrl) { console.log('⚠️  SLACK_WEBHOOK no configurado'); return; }
  const r = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });
  if (!r.ok) console.error('Slack error:', r.status, await r.text());
}

function fmt(n) { return '$' + Math.round(n).toLocaleString('es-MX'); }

// Resumen de mañana (9am)
async function slackResumenManana() {
  try {
    const d = await getDatosVendedor();
    const act = d.actividades;
    const pip = d.pipeline;
    const kpis = d.kpis;

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`☀️ Buenos días — Resumen vendedor ${d.fecha}` } },
      { type:'divider' },
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📋 Actividades de hoy*\n${act.hoy.length > 0 ? act.hoy.map(a=>`• ${a.tipo||'Tarea'}: _${a.lead}_`).join('\n') : '✅ Sin actividades programadas'}` },
        { type:'mrkdwn', text:`*🔴 Actividades vencidas*\n${act.vencidas.length > 0 ? act.vencidas.map(a=>`• ${a.lead} (${a.dias_vencida}d atrasada)`).join('\n') : '✅ Ninguna vencida'}` },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📅 Reuniones de hoy*\n${d.reuniones.length > 0 ? d.reuniones.map(r=>`• ${r.nombre} ${r.inicio?.split('T')[1]?.slice(0,5)||''}`).join('\n') : '— Sin reuniones'}`},
        { type:'mrkdwn', text:`*💰 Pipeline activo*\n${pip.total_oportunidades} oportunidades · ${fmt(pip.valor_total)} en juego`},
      ]},
      ...(act.vencidas.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`⚠️ *Atención:* Hay *${act.vencidas.length} actividad(es) vencida(s)*. Requieren acción inmediata.` }
      }] : []),
      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks · Supervisor automático · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }] }
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Resumen mañana enviado a Slack');
  } catch(err) {
    console.error('Error resumen mañana Slack:', err.message);
  }
}

// Resumen de cierre (6pm)
async function slackCierreDia() {
  try {
    const d = await getDatosVendedor();
    const act = d.actividades;
    const kpis = d.kpis;

    const blocks = [
      { type:'header', text:{ type:'plain_text', text:`🌙 Cierre del día — ${d.fecha}` } },
      { type:'divider' },
      { type:'section', fields:[
        { type:'mrkdwn', text:`*✅ Ganados este mes*\n${kpis.ganados_mes} cierres · ${fmt(kpis.valor_ganado_mes)}` },
        { type:'mrkdwn', text:`*🆕 Leads nuevos esta semana*\n${kpis.nuevos_semana} nuevos` },
      ]},
      { type:'section', fields:[
        { type:'mrkdwn', text:`*📊 Tasa de conversión*\n${kpis.tasa_conversion}%` },
        { type:'mrkdwn', text:`*⚠️ Actividades vencidas*\n${act.vencidas.length > 0 ? act.vencidas.length+' pendiente(s)' : '✅ Al día'}` },
      ]},
      ...(kpis.ganados_detalle?.length > 0 ? [{
        type:'section',
        text:{ type:'mrkdwn', text:`*🏆 Cierres del mes:*\n${kpis.ganados_detalle.map(g=>`• ${g.nombre} — ${fmt(g.valor||0)}`).join('\n')}` }
      }] : []),
      { type:'context', elements:[{ type:'mrkdwn', text:`Todo Decks · Supervisor automático · ${new Date().toLocaleString('es-MX',{timeZone:TZ})}` }] }
    ];

    await sendSlack(SLACK_WEBHOOK, blocks);
    console.log('✅ Cierre del día enviado a Slack');
  } catch(err) {
    console.error('Error cierre día Slack:', err.message);
  }
}

// Alerta de tareas vencidas (cada hora en horario laboral)
async function slackAlertaVencidas() {
  try {
    const d = await getDatosVendedor();
    const vencidas = d.actividades.vencidas;
    if (vencidas.length === 0) return; // Solo alerta si hay vencidas

    const blocks = [
      { type:'section', text:{ type:'mrkdwn',
        text:`🚨 *Alerta: ${vencidas.length} tarea(s) vencida(s)*\n${vencidas.slice(0,5).map(a=>`• *${a.lead}* — ${a.tipo||'Tarea'} (${a.dias_vencida}d atrasada)`).join('\n')}${vencidas.length>5?`\n_...y ${vencidas.length-5} más_`:''}`
      }},
    ];

    await sendSlack(SLACK_WEBHOOK_ALERTS, blocks);
    console.log(`✅ Alerta ${vencidas.length} vencidas enviada a Slack`);
  } catch(err) {
    console.error('Error alerta vencidas:', err.message);
  }
}

// ── SCHEDULERS (hora Cancún CST = UTC-6) ─────────────
// 9:00am Cancún = 15:00 UTC
cron.schedule('0 15 * * 1-6', slackResumenManana, { timezone: TZ });

// 6:00pm Cancún = 00:00 UTC siguiente día
cron.schedule('0 0 * * 2-7', slackCierreDia, { timezone: TZ });

// Alerta vencidas cada hora 9am-5pm Cancún (15-23 UTC) L-S
cron.schedule('0 15-23 * * 1-6', slackAlertaVencidas, { timezone: TZ });

console.log('⏰ Schedulers activos:');
console.log('   9:00am CST → Resumen del día (Lun-Sab)');
console.log('   6:00pm CST → Cierre del día (Lun-Sab)');
console.log('   Cada hora (9am-5pm) → Alerta tareas vencidas');

// ── RUTAS API ─────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok', servidor: 'Todo Decks Supervisor',
  odoo: ODOO_URL || '⚠ no configurado',
  slack: SLACK_WEBHOOK ? '✅ configurado' : '⚠ no configurado',
  timestamp: new Date().toISOString()
}));

app.get('/api/datos', async (req, res) => {
  try {
    const datos = await getDatosVendedor();
    res.json(datos);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Envío manual de resumen a Slack
app.post('/api/slack/resumen', async (req, res) => {
  try {
    await slackResumenManana();
    res.json({ ok: true, mensaje: 'Resumen enviado a Slack' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/slack/cierre', async (req, res) => {
  try {
    await slackCierreDia();
    res.json({ ok: true, mensaje: 'Cierre del día enviado a Slack' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SERVIDOR ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Todo Decks Supervisor corriendo en http://localhost:${PORT}`);
  console.log(`   → Tablero: http://localhost:${PORT}/`);
  console.log(`   → API:     http://localhost:${PORT}/api/datos\n`);
});
