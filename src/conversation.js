// Núcleo de atendimento, independente do canal (Baileys ou Cloud API da Meta).
// O canal só precisa saber enviar texto/imagem/documento; a lógica de buffer,
// "digitando", pausa por humano e notificação da vendedora fica aqui.
import { formatHandoff, leadVCard, resumoParaFicha, runAgent } from './agent.js';
import { brVariants, config, formatBR } from './config.js';
import { addMessage, getLead, updateLead, upsertLead } from './db.js';
import { criarProspect, registrarAtendimento } from './crm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} channel
 *  - sendText(to, texto)
 *  - sendImage(to, { path, caption })
 *  - sendDocument(to, { path, fileName })
 *  - sendContact?(to, vcard)        opcional
 *  - markRead?(item)                opcional
 *  - typing?(to, ligado)            opcional
 *  - sellerTarget?(numero)          converte número em destino do canal
 */
export function createConversation(channel, log = console.log) {
  const chats = new Map(); // leadId -> { pending, timer, running }

  async function notifySellers(text, lead) {
    if (!config.sellerNumbers.length) {
      log(`📣 (SELLER_WHATSAPP não configurado) notificação:\n${text}`);
      return;
    }
    let enviados = 0;
    for (const n of config.sellerNumbers) {
      try {
        const to = channel.sellerTarget ? await channel.sellerTarget(n) : n;
        await channel.sendText(to, text);
        if (lead?.phone && channel.sendContact) await channel.sendContact(to, leadVCard(lead));
        enviados++;
      } catch (err) {
        log(`⚠️  falha ao notificar ${config.sellerName} (${formatBR(n)}):`, err.message);
      }
    }
    if (enviados) log(`📣 ${config.sellerName} notificada (${config.sellerNumbers.map(formatBR).join(', ')})`);
    else log(`❌ NÃO foi possível avisar ${config.sellerName} — lead aguardando atendimento!`);
  }

  function isAllowed(phone) {
    if (config.replyToAll) return true;
    const allowed = new Set(config.allowedNumbers.flatMap(brVariants));
    return brVariants(phone).some((v) => allowed.has(v));
  }

  /**
   * Registra a mensagem do lead e agenda a resposta (aguardando mensagens picadas).
   * @param {{ leadId, to, phone, pushName, text, images?, raw? }} msg
   */
  async function onIncoming({ leadId, to, phone, pushName, text, images = [], raw, midia, aoGravar }) {
    const lead = await upsertLead(leadId, { phone, pushName });
    log(`📩 ${lead.push_name || formatBR(phone)}: ${text}`);
    // O id da mensagem volta para quem chamou poder anexar os bytes e o contato a ela.
    const mensagemId = await addMessage(leadId, 'user', text, midia ?? null);
    if (aoGravar) await aoGravar(mensagemId).catch(() => {});

    if (lead.paused_until > Date.now()) {
      log(`⏸️  ${formatBR(phone)} em atendimento humano — bot não responde`);
      return;
    }
    const chat = chats.get(leadId) || { pending: [], timer: null, running: false };
    chats.set(leadId, chat);
    chat.pending.push({ images, raw, to });
    clearTimeout(chat.timer);
    chat.timer = setTimeout(() => flush(leadId), config.bufferSeconds * 1000);
  }

  async function flush(leadId) {
    const chat = chats.get(leadId);
    if (!chat || chat.running || !chat.pending.length) return;
    chat.running = true;
    const batch = chat.pending.splice(0);
    const to = batch.at(-1).to;

    try {
      if (channel.markRead) for (const b of batch) await channel.markRead(b.raw).catch(() => {});
      await channel.typing?.(to, true).catch(() => {});

      const started = Date.now();
      const images = batch.flatMap((b) => b.images);
      let result;
      try {
        result = await runAgent(leadId, { images });
      } catch (err) {
        log('⚠️  erro na OpenAI, tentando de novo:', err.message);
        await sleep(2000);
        result = await runAgent(leadId, { images });
      }

      const { replies, attachments, handoff, updates } = result;
      for (let i = 0; i < replies.length; i++) {
        const espera = Math.min(1500 + replies[i].length * 30, 7000) - (i === 0 ? Date.now() - started : 0);
        await channel.typing?.(to, true).catch(() => {});
        if (espera > 0) await sleep(espera);
        await channel.sendText(to, replies[i]);
        log(`🤖 ${config.agentName} → ${await getLead(leadId).phone}: ${replies[i].replace(/\n/g, ' ⏎ ')}`);
      }
      for (const a of attachments) {
        try {
          await sleep(800);
          if (a.kind === 'document') await channel.sendDocument(to, a);
          else if (a.kind === 'image') await channel.sendImage(to, a);
          log(`📎 enviado ${a.kind}: ${a.fileName || a.produto}`);
        } catch (err) {
          log(`⚠️  falha ao enviar ${a.kind}:`, err.message);
        }
      }
      await channel.typing?.(to, false).catch(() => {});

      if (handoff) {
        // O prospect nasce no CRM junto com o aviso a vendedora, e antes dele: quando ela
        // abrir o WhatsApp, o cadastro ja esta la para ela trabalhar. `criarProspect` nunca
        // lanca — falhar em criar nao pode derrubar o atendimento.
        //
        // Quem ja passou pelo documento nao passa por aqui: a identificacao pelo CPF/CNPJ
        // ja achou ou ja criou o cadastro, e chamar de novo so renderia um 409 do CRM.
        if (handoff.lead.entidade_id == null) {
          const criado = await criarProspect(handoff.lead, log);
          if (criado?.id) await updateLead(leadId, { prospect_id: criado.id, entidade_id: criado.id });
        }
        await notifySellers(formatHandoff(handoff), handoff.lead);
      }
      for (const u of updates) await notifySellers(u);

      const l = await getLead(leadId);
      log(`📊 ${l.phone}: score ${l.score} (${l.temperature}) · ${l.stage}`);

      // O atendimento vai para a ficha do cliente, nao so para a tela de conversas. Sem
      // isto, da mesa do vendedor este atendimento nao aconteceu — que e exatamente o que
      // cobramos do time humano.
      //
      // Roda depois do encaminhamento de proposito: e la que o cadastro nasce quando o
      // cliente nao passou o documento, e so com `entidade_id` existe ficha onde escrever.
      // O CRM agrupa por conversa e por dia, entao chamar a cada resposta nao enche nada.
      await registrarAtendimento({
        entidadeId: l.entidade_id,
        conversaId: leadId,
        resultado: 'CONTATO_FEITO',
        observacao: resumoParaFicha(l),
      }, log);
      if (handoff) {
        await registrarAtendimento({
          entidadeId: l.entidade_id,
          conversaId: leadId,
          resultado: 'PROPOSTA_PEDIDA',
          observacao: `Encaminhado para ${config.sellerName} — ${handoff.motivo.replace(/_/g, ' ')}`
            + ` (urgência ${handoff.urgencia}).\n${handoff.resumo_para_consultor ?? ''}`,
        }, log);
      }
    } catch (err) {
      log('❌ falha ao responder:', err);
      await channel.sendText(to, 'Opa, tive uma instabilidade aqui 😅 Já já te respondo!').catch(() => {});
      await notifySellers(`⚠️ O agente falhou ao responder ${await getLead(leadId)?.phone}. Verifique o chat.`);
    } finally {
      chat.running = false;
      if (chat.pending.length) chat.timer = setTimeout(() => flush(leadId), 1500);
    }
  }

  return { onIncoming, notifySellers, isAllowed };
}
