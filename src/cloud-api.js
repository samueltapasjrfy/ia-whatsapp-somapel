// Conector oficial: WhatsApp Cloud API (Meta).
// Sobe um webhook HTTP que recebe as mensagens e responde pela Graph API.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { transcribeAudio } from './agent.js';
import { brVariants, config, formatBR, normalizeBR } from './config.js';
import { createConversation } from './conversation.js';
import { fecharLote, marcarEnviada, pegarEnviosPendentes, updateLead } from './db.js';
import {
  fecharDisparosConcluidos, fecharLoteCampanha, marcarCampanhaEnviada, pegarCampanhaPendente,
  registrarAtendimentoDeCampanha, registrarRespostaDeCampanha, registrarStatusDeEntrega,
  suprimirTelefone,
} from './db.js';
import { addMessage, getLead } from './db.js';

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);
const GRAPH = `https://graph.facebook.com/${config.waApiVersion}`;
const mediaCache = new Map(); // caminho local -> media id da Meta

async function graph(path, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.waToken}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body instanceof FormData ? body : body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    if (e.code === 190) throw new Error('TOKEN DO WHATSAPP EXPIRADO/INVÁLIDO — gere um novo no painel da Meta e atualize WHATSAPP_TOKEN no .env');
    throw new Error(`Graph ${res.status}: ${e.message || JSON.stringify(data)}`);
  }
  return data;
}

const sendMessage = (payload) => graph(`${config.waNumberId}/messages`, { body: { messaging_product: 'whatsapp', ...payload } });

async function uploadMedia(path, type) {
  if (mediaCache.has(path)) return mediaCache.get(path);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);
  form.append('file', new Blob([readFileSync(path)], { type }), basename(path));
  const { id } = await graph(`${config.waNumberId}/media`, { body: form });
  mediaCache.set(path, id);
  return id;
}

async function downloadMedia(mediaId) {
  const { url, mime_type: mime } = await graph(mediaId, { method: 'GET' });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.waToken}` } });
  if (!res.ok) throw new Error(`download de mídia falhou: ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

const channel = {
  sendText: (to, text) => sendMessage({ to, type: 'text', text: { body: text, preview_url: true } }),
  sendImage: async (to, a) => sendMessage({ to, type: 'image', image: { id: await uploadMedia(a.path, 'image/jpeg'), caption: a.caption } }),
  sendDocument: async (to, a) => sendMessage({ to, type: 'document', document: { id: await uploadMedia(a.path, 'application/pdf'), filename: a.fileName } }),
  sendContact: (to, v) => sendMessage({
    to,
    type: 'contacts',
    contacts: [{
      name: { formatted_name: v.displayName, first_name: v.displayName.split(' ')[0] },
      ...(v.empresa ? { org: { company: v.empresa } } : {}),
      phones: [{ phone: formatBR(v.phone), wa_id: v.phone, type: 'CELL' }],
    }],
  }),
  // Confirma leitura e mostra "digitando…" para o cliente (dura ~25s ou até a resposta sair).
  markRead: (raw) => sendMessage({ status: 'read', message_id: raw.id, typing_indicator: { type: 'text' } }),
  sellerTarget: (n) => normalizeBR(n),
};

const { onIncoming, isAllowed } = createConversation(channel, log);

function extractText(m) {
  switch (m.type) {
    case 'text': return m.text?.body || '';
    case 'image': return `[enviou uma imagem]${m.image?.caption ? ` ${m.image.caption}` : ''}`;
    case 'document': return `[enviou o documento "${m.document?.filename || 'arquivo'}"]${m.document?.caption ? ` ${m.document.caption}` : ''}`;
    case 'video': return `[enviou um vídeo]${m.video?.caption ? ` ${m.video.caption}` : ''}`;
    case 'sticker': return '[enviou uma figurinha]';
    case 'location': return `[enviou localização: ${m.location?.name || ''} ${m.location?.address || ''} (${m.location?.latitude}, ${m.location?.longitude})]`;
    case 'contacts': return `[enviou um contato: ${m.contacts?.[0]?.name?.formatted_name || ''}]`;
    case 'button': return m.button?.text || '';
    case 'interactive': return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
    case 'reaction': return '';
    default: return `[mensagem do tipo ${m.type}]`;
  }
}

async function handleMessage(m, contato) {
  const phone = normalizeBR(m.from);
  const leadId = `wa:${phone}`;
  if (m.type === 'reaction' || m.type === 'unsupported') return;

  let text = extractText(m);
  const images = [];
  try {
    if (m.type === 'audio' || m.type === 'voice') {
      const { buffer } = await downloadMedia(m.audio?.id || m.voice?.id);
      const t = await transcribeAudio(buffer, 'audio.ogg');
      text = `[áudio transcrito] ${t}`;
      log(`🎙️  áudio de ${formatBR(phone)}: "${t}"`);
    } else if (m.type === 'image') {
      const { buffer, mime } = await downloadMedia(m.image.id);
      images.push(`data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`);
    }
  } catch (err) {
    log('⚠️  falha ao baixar mídia:', err.message);
    text ||= '[enviou uma mídia que não consegui abrir]';
  }
  if (!text) return;

  await onIncoming({ leadId, to: m.from, phone, pushName: contato?.profile?.name, text, images, raw: m });
}

// Mensagens enviadas pela equipe pelo app do WhatsApp Business (echo) → humano assumiu o chat.
async function handleEcho(m) {
  const phone = normalizeBR(m.to || m.recipient_id || '');
  const lead = await getLead(`wa:${phone}`);
  if (!lead) return;
  const texto = extractText(m).trim();
  const cmd = texto.toLowerCase();
  if (cmd === '#bot') { await updateLead(lead.id, { paused_until: 0 }); log(`▶️  bot retomado em ${formatBR(phone)}`); return; }
  if (cmd === '#pausar') { await updateLead(lead.id, { paused_until: Date.now() + 30 * 24 * 3600e3 }); log(`⏸️  bot pausado em ${formatBR(phone)}`); return; }
  if (texto) await addMessage(lead.id, 'human', texto);
  await updateLead(lead.id, { paused_until: Date.now() + config.humanPauseMinutes * 60e3 });
  log(`🧑 humano respondeu ${formatBR(phone)} — bot pausado por ${config.humanPauseMinutes} min (envie #bot no chat para retomar)`);
}

function assinaturaValida(raw, assinatura) {
  if (!config.waAppSecret) return true; // sem app secret configurado, não dá para validar
  const esperado = `sha256=${createHmac('sha256', config.waAppSecret).update(raw).digest('hex')}`;
  const a = Buffer.from(esperado);
  const b = Buffer.from(assinatura || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/webhook') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === config.waVerifyToken;
    log(ok ? '✅ webhook verificado pela Meta' : '❌ verificação do webhook recusada (verify token diferente)');
    res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get('hub.challenge') : 'forbidden');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      res.writeHead(200).end('EVENT_RECEIVED'); // a Meta exige resposta rápida
      if (!assinaturaValida(raw, req.headers['x-hub-signature-256'])) return log('❌ assinatura do webhook inválida — ignorado');
      try {
        const body = JSON.parse(raw);
        for (const entry of body.entry || []) {
          for (const { value } of entry.changes || []) {
            for (const m of value?.messages || []) {
              const phone = normalizeBR(m.from);
              if (m.from === config.waPhone) { await handleEcho(m); continue; }

              // **Antes do filtro de números liberados, de propósito.** Registrar não é
              // responder: com REPLY_TO_ALL desligado a Sofia fica calada, mas a campanha
              // disparou para gente de fora da lista e a resposta dela é o funil inteiro.
              // Amarrado ao `isAllowed`, um disparo para 240 pessoas mostraria zero
              // respostas — e um "parar de receber" seria ignorado, que é pior.
              await registrarRespostaDeDisparo(phone, extractText(m));

              if (!isAllowed(phone)) {
                log(`🙈 ignorando ${formatBR(phone)} — fora de ALLOWED_NUMBERS`);
                continue;
              }
              await handleMessage(m, value.contacts?.find((c) => c.wa_id === m.from));
            }
            // O relatorio de entrega da Meta. Antes so o erro virava log e nada era
            // guardado — sem isto o funil da campanha nao sai do "enviadas".
            for (const s of value?.statuses || []) {
              const erro = s.errors?.[0];
              if (s.status === 'failed') {
                log(`⚠️  envio falhou para ${formatBR(s.recipient_id)}: ${erro?.title || ''} — ${erro?.error_data?.details || ''}`);
              }
              await registrarStatusDeEntrega(
                s.id, s.status,
                erro ? `${erro.title || ''} ${erro.error_data?.details || ''}`.trim().slice(0, 300) : null,
              ).catch((e) => log('⚠️  nao consegui gravar o status de entrega:', e.message));
            }
          }
        }
      } catch (err) {
        log('❌ erro ao processar webhook:', err);
      }
    });
    return;
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, numero: config.waPhone, agente: config.agentName }));
    return;
  }
  res.writeHead(404).end('not found');
}).listen(config.webhookPort, () => {
  log(`🚀 Webhook da Cloud API ouvindo na porta ${config.webhookPort}`);
  log(`📱 Número oficial: ${formatBR(config.waPhone)} (id ${config.waNumberId}) · agente ${config.agentName} (${config.model})`);
  log(`👩‍💼 Leads aquecidos (score ≥ ${config.handoffScore}) vão para ${config.sellerName}: ${config.sellerNumbers.map(formatBR).join(', ') || '(não configurado)'}`);
  if (!config.replyToAll) log(`🔒 Modo seguro: respondendo apenas ${config.allowedNumbers.map(formatBR).join(', ') || '(ninguém — configure ALLOWED_NUMBERS)'}`);
});

/**
 * Leva ao WhatsApp o que alguem escreveu na tela do CRM.
 *
 * A tela grava a mensagem como pendente e devolve na hora — ninguem fica esperando a Meta
 * responder para ver o proprio balao aparecer. Este laco e quem entrega de verdade.
 *
 * `SKIP LOCKED` no banco garante que dois processos nunca peguem a mesma linha, entao dobrar
 * o numero de agentes amanha nao envia nada duas vezes. E o lote so e confirmado no fim: se
 * o processo morrer no meio, as linhas voltam a ficar pendentes e saem quando ele voltar.
 * E fila durável sem Redis — uma peca a menos para cair.
 *
 * Escrever pela tela tambem **cala a IA** naquela conversa: quem assumiu, assumiu.
 */
async function despacharDoCrm() {
  let lote;
  try {
    lote = await pegarEnviosPendentes(20);
  } catch (err) {
    log('⚠️  não consegui ler a fila de envio:', err.message);
    return;
  }
  const { cliente, rows } = lote;
  if (!rows.length) { await fecharLote(cliente, true); return; }

  for (const m of rows) {
    try {
      await channel.sendText(m.telefone, m.conteudo);
      await marcarEnviada(cliente, m.id);
      await updateLead(m.conversa_id, { paused_until: Date.now() + config.humanPauseMinutes * 60e3 });
      log(`💬 ${formatBR(m.telefone)} ← (CRM): ${m.conteudo.replace(/\n/g, ' ⏎ ').slice(0, 80)}`);
    } catch (err) {
      // Marca a falha na propria linha em vez de tentar para sempre: mensagem que a Meta
      // recusou (fora da janela de 24h, por exemplo) nao melhora com insistencia, e a tela
      // precisa mostrar que nao foi.
      await marcarEnviada(cliente, m.id, err.message.slice(0, 300));
      log(`❌ falha ao enviar para ${formatBR(m.telefone)}: ${err.message}`);
    }
  }
  await fecharLote(cliente, true);
}

// A cada 2 segundos. Curto para o balao sair quase junto com o clique, e barato: uma consulta
// indexada que quase sempre volta vazia. `unref` para o laco nao segurar o processo de pe.
setInterval(() => { despacharDoCrm().catch((e) => log('⚠️  despacho:', e.message)); }, 2000).unref();

/* ─────────────────────────── disparos de campanha ─────────────────────────── */

/**
 * Entrega os disparos montados no CRM.
 *
 * A mensagem sai como **template**, nao como texto: fora da janela de 24h a Meta so aceita
 * modelo aprovado, e campanha por definicao fala com quem nao escreveu primeiro.
 *
 * O ritmo e deliberadamente lento — poucos por vez, com pausa entre um e outro. Centenas de
 * mensagens identicas saindo no mesmo segundo e o padrao que a Meta associa a spam, e o
 * preco disso e a qualidade do numero, nao o disparo.
 */
const CAMPANHA_LOTE = 5;
const CAMPANHA_PAUSA_MS = 1500;

async function enviarTemplate(to, nomeDoTemplate, idioma, variaveis) {
  const valores = Object.keys(variaveis ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => ({ type: 'text', text: String(variaveis[k] ?? '') }));
  const resposta = await sendMessage({
    to,
    type: 'template',
    template: {
      name: nomeDoTemplate,
      language: { code: idioma || 'pt_BR' },
      ...(valores.length ? { components: [{ type: 'body', parameters: valores }] } : {}),
    },
  });
  return resposta?.messages?.[0]?.id ?? null;
}

async function despacharCampanha() {
  let lote;
  try {
    lote = await pegarCampanhaPendente(CAMPANHA_LOTE);
  } catch (err) {
    log('⚠️  não consegui ler a fila de campanha:', err.message);
    return;
  }
  const { cliente, rows } = lote;
  if (!rows.length) {
    await fecharLoteCampanha(cliente, true);
    await fecharDisparosConcluidos().catch(() => {});
    return;
  }

  for (const e of rows) {
    try {
      const wamid = await enviarTemplate(e.telefone, e.template_nome, e.idioma, e.variaveis);
      await marcarCampanhaEnviada(cliente, e.id, wamid);
      // Na mesma transacao do envio: ou as duas coisas existem, ou nenhuma. Ficha sem a
      // mensagem que saiu e pior que nada — e o vendedor liga sem saber.
      await registrarAtendimentoDeCampanha(cliente, e.id);
      log(`📣 campanha → ${formatBR(e.telefone)} (${e.nome})`);
    } catch (err) {
      // Marca a falha na propria linha em vez de insistir: numero que nao tem WhatsApp nao
      // melhora na segunda tentativa, e a tela precisa mostrar que nao foi.
      await marcarCampanhaEnviada(cliente, e.id, null, err.message.slice(0, 300));
      log(`❌ campanha falhou para ${formatBR(e.telefone)}: ${err.message}`);
    }
    await sleep(CAMPANHA_PAUSA_MS);
  }
  await fecharLoteCampanha(cliente, true);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cada 10 segundos. Nao precisa ser rapido: campanha nao e conversa, e o ritmo lento e
// proposital. `unref` para o laco nao segurar o processo de pe.
setInterval(() => { despacharCampanha().catch((e) => log('⚠️  campanha:', e.message)); }, 10_000).unref();

/**
 * Classifica a resposta a uma campanha pelo que a pessoa tocou ou escreveu.
 *
 * Os botoes do modelo sao o sinal limpo: "Quero uma cotacao" nao deixa duvida. O texto
 * livre fica INDEFINIDO de proposito — quem decide se aquilo e interesse e a Sofia, na
 * qualificacao, ou o vendedor lendo. Chutar aqui encheria o funil de falso positivo.
 */
/** Robo de atendimento do outro lado. Nao e resposta de gente — e so o aparelho confirmando. */
const AUTOMATICA = /atendimento autom|mensagem autom|resposta autom|agradece (o )?seu contato|agradece o contato|seja bem.?vindo|em breve (um|uma) (atendente|consultor)|nosso hor.rio de (atendimento|funcionamento)|retornaremos (o|seu) contato|deixe sua mensagem/i;

/**
 * Classifica a resposta a uma campanha pelo que a pessoa tocou ou escreveu.
 *
 * Os botoes do modelo sao o sinal limpo — chegam como texto exato e nao deixam duvida. O
 * texto livre fica INDEFINIDO de proposito: quem decide se aquilo e interesse e a Sofia, na
 * qualificacao, ou o vendedor lendo. Chutar aqui enche o funil de falso positivo, e o custo
 * e um vendedor ligando para quem nunca respondeu.
 *
 * O primeiro disparo real ensinou duas coisas. Um "ATENDIMENTO AUTOMATICO: obrigado por nos
 * contactar, envie seu orcamento..." foi classificado como INTERESSADO porque a palavra
 * aparecia no meio do texto do robo — por isso o teste de interesse agora exige mensagem
 * curta. E "favor nao me enviar spam" passou batido: e pedido de saida como qualquer outro,
 * so que dito com raiva.
 */
function lerInteresse(texto) {
  const t = (texto || '').toLowerCase().trim();
  if (!t) return 'INDEFINIDO';

  // Sai antes de tudo: o robo do outro lado pode conter qualquer palavra-chave.
  if (AUTOMATICA.test(t)) return 'AUTOMATICA';

  if (/parar de receber|descadastr|n[aã]o (quero|desejo) (mais|receber)|n[aã]o me envie|nao me envie|me (tire|tira|remove|remova)|spam|^sair$/.test(t)) {
    return 'DESCADASTRO';
  }
  // Curto de proposito: a frase so conta como interesse quando ela E a resposta, nao quando
  // a palavra aparece perdida dentro de um texto longo.
  const curto = t.length <= 90;
  if (curto && /quero (uma )?cota|quero o pre|me (manda|passa) o pre|^or[cç]amento|preciso de or[cç]amento/.test(t)) {
    return 'INTERESSADO';
  }
  if (curto && /volta a falar|mais pra frente|m[eê]s que vem|me chama depois/.test(t)) return 'DEPOIS';
  if (curto && /^(hoje n|n[aã]o, obrigad|nao obrigad|sem interesse|n[aã]o preciso)/.test(t)) {
    return 'SEM_INTERESSE';
  }
  if (curto && /outro fornecedor|j[aá] (comprei|compramos)|j[aá] temos fornecedor/.test(t)) {
    return 'SEM_INTERESSE';
  }
  return 'INDEFINIDO';
}

/**
 * Liga a resposta de alguem a campanha que a provocou, e respeita o pedido de parar.
 *
 * Roda antes da IA responder: se a pessoa pediu para sair, ela sai da lista hoje — a
 * supressao vale para todas as campanhas seguintes e sobrevive as cargas do ETL.
 */
async function registrarRespostaDeDisparo(phone, texto) {
  const interesse = lerInteresse(texto);
  try {
    const envio = await registrarRespostaDeCampanha(
      brVariants(phone), texto, interesse, `wa:${phone}`,
    );
    if (!envio) return;
    log(`📊 resposta de campanha (${interesse.toLowerCase()}): ${formatBR(phone)}`);
    if (interesse === 'DESCADASTRO') {
      for (const v of brVariants(phone)) await suprimirTelefone(v);
      log(`🚫 ${formatBR(phone)} pediu para sair — não entra em campanha nenhuma a partir de agora`);
    }
  } catch (err) {
    log('⚠️  não consegui registrar a resposta de campanha:', err.message);
  }
}
