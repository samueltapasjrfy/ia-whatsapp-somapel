import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { config, formatBR } from './config.js';
import { addMessage, getHistory, getLead, updateLead } from './db.js';
import { identificarDocumento } from './crm.js';
import { buildContextPrompt, buildSystemPrompt } from './prompt.js';
import { scoreLead } from './scoring.js';

export const openai = new OpenAI({ apiKey: config.openaiKey });

const PRODUCTS = JSON.parse(readFileSync(new URL('../knowledge/produtos-site.json', import.meta.url)));
const SYSTEM_PROMPT = buildSystemPrompt();

const PRODUCT_NAMES = PRODUCTS.filter((p) => p.fotos.length).map((p) => p.nome);
const ROOT = new URL('../', import.meta.url).pathname;

const chatTools = [
  {
    type: 'function',
    function: {
      name: 'identificar_documento',
      description: 'Descobre quem e a pessoa pelo CPF/CNPJ e ja resolve o cadastro no CRM. '
        + 'Chame ASSIM QUE o cliente informar o documento, antes de qualquer outra coisa. '
        + 'Devolve se ele ja e CLIENTE da Somapel, se ja existe como PROSPECT, ou cadastra um '
        + 'prospect novo com razao social, endereco e ramo puxados da Receita (CRIADO). '
        + 'Leia o campo "resumo" da resposta: ele diz o que fazer em seguida. '
        + 'Se voltar SEM_CADASTRO, pergunte o nome da empresa e chame de novo passando nome_empresa.',
      parameters: {
        type: 'object',
        required: ['documento'],
        properties: {
          documento: { type: 'string', description: 'CPF ou CNPJ como o cliente mandou, com ou sem pontuacao' },
          nome_empresa: { type: 'string', description: 'Razao social ou nome da pessoa. So quando a consulta automatica nao trouxer (CPF, ou Receita fora do ar)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_qualificacao',
      description: 'Salva/atualiza informações de qualificação do lead. Envie SOMENTE campos que o cliente informou explicitamente ou que são óbvios pela conversa. NUNCA envie campos desconhecidos, vazios, "desconhecido" ou booleanos false por padrão — omita o campo.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          empresa: { type: 'string' },
          cnpj: { type: 'string' },
          email: { type: 'string' },
          cargo: { type: 'string' },
          cargo_decisor: { type: 'boolean', description: 'true se a pessoa compra/decide ou influencia diretamente a compra' },
          tipo_cliente: { type: 'string', enum: ['empresa', 'pessoa_fisica', 'revenda', 'desconhecido'] },
          segmento: { type: 'string', description: 'ex.: metalurgia, alimentos, logística, e-commerce, construção' },
          cidade_uf: { type: 'string' },
          necessidade: { type: 'string', description: 'dor/necessidade em uma frase' },
          aplicacao: { type: 'string', description: 'o que embala/arqueia/paletiza e como' },
          produto_recomendado: { type: 'string', description: 'O produto principal que você recomendou / o cliente escolheu' },
          produtos_interesse: { type: 'array', items: { type: 'string' } },
          solucao_atual: { type: 'string', description: 'o que usa hoje / fornecedor atual' },
          volume: { type: 'string', description: 'quantidade/consumo, ex.: "30 pallets/dia", "20 rolos/mês"' },
          compra_recorrente: { type: 'boolean' },
          prazo: { type: 'string', enum: ['imediato', 'ate_30_dias', '1_a_3_meses', 'sem_prazo'], description: 'imediato = hoje/esta semana/urgente/acabou estoque; ate_30_dias = semana que vem, este mês; 1_a_3_meses; sem_prazo = só pesquisando' },
          pediu_orcamento: { type: 'boolean' },
          pediu_visita: { type: 'boolean' },
          ja_e_cliente: { type: 'boolean' },
          nao_e_lead: { type: 'boolean', description: 'candidato a vaga, fornecedor, spam etc.' },
          objecoes: { type: 'string' },
          estagio: { type: 'string', enum: ['em_qualificacao', 'qualificado', 'nutrir', 'desqualificado'] },
          resumo: { type: 'string', description: 'resumo atualizado da conversa em até 3 frases' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'encaminhar_para_consultor',
      description: `Encaminha o lead para a vendedora ${config.sellerName}: ela recebe no WhatsApp o nome, o número e o resumo do lead e chama o cliente.`,
      parameters: {
        type: 'object',
        required: ['motivo', 'urgencia', 'resumo_para_consultor'],
        properties: {
          motivo: { type: 'string', enum: ['orcamento', 'visita_tecnica', 'showroom', 'assistencia_tecnica', 'pediu_humano', 'reclamacao', 'pos_venda', 'duvida_tecnica', 'outro'] },
          urgencia: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          resumo_para_consultor: { type: 'string', description: 'Tudo que o consultor precisa saber para dar sequência sem repetir perguntas: quem é, necessidade, produtos/medidas, volume, prazo, cidade, próximos passos combinados.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_catalogo',
      description: 'Envia o catálogo PDF completo da Somapel no chat.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_foto_produto',
      description: 'Envia no WhatsApp a(s) foto(s) oficial(is) do(s) produto(s) que está(ão) sendo conversado(s). Use quando o cliente pedir foto/imagem ("tem foto?", "me manda uma imagem", "como ele é?", "quero ver") ou quando ver o produto ajudar a confirmar se é o que ele procura. Escolha EXATAMENTE o produto em discussão — nunca um parecido. Se o produto conversado não estiver na lista, NÃO chame esta ferramenta.',
      parameters: {
        type: 'object',
        required: ['produtos'],
        properties: {
          produtos: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: PRODUCT_NAMES }, description: 'Produto(s) em discussão (máx. 3, ex.: kit fita + selo + aparelho)' },
        },
      },
    },
  },
];

const tools = chatTools.map(({ function: f }) => ({ type: 'function', ...f }));

async function handleTool(leadId, name, args, out) {
  let lead = await getLead(leadId);
  switch (name) {
    case 'identificar_documento': {
      const r = await identificarDocumento({
        doc: args.documento,
        telefone: lead.phone,
        contatoNome: lead.data.nome || lead.push_name || null,
        nome: args.nome_empresa || lead.data.empresa || null,
        observacao: lead.summary || lead.data.necessidade || null,
      });
      if (!r) {
        return { ok: false, erro: 'Nao consegui consultar o cadastro agora. Siga a conversa normalmente e nao peca o documento de novo.' };
      }
      if (r.situacao === 'DOC_INVALIDO') return { ok: false, situacao: r.situacao, orientacao: r.resumo };
      if (r.situacao === 'SEM_CADASTRO') return { ok: false, situacao: r.situacao, orientacao: r.resumo };

      // O documento e a identidade vao para a conversa, nao so para os dados da IA: e o
      // que liga este atendimento a ficha do cliente na tela e o que sobrevive ao fim do
      // papo. `entidade_id` e o mesmo id da tela de clientes.
      const data = {
        ...lead.data,
        cnpj: r.doc,
        ...(r.nome ? { empresa: r.nome } : {}),
        ...(r.municipio ? { cidade_uf: `${r.municipio}/${r.uf}` } : {}),
        ...(r.ramo ? { segmento: r.ramo } : {}),
        ...(r.situacao === 'CLIENTE' ? { ja_e_cliente: true } : {}),
      };
      await updateLead(leadId, {
        data, doc: r.doc, entidade_id: r.id ?? null,
        ...(r.id != null && r.id < 0 ? { prospect_id: r.id } : {}),
      });

      // Cliente de casa chegando pelo WhatsApp e coisa que o vendedor tem que saber na hora
      // — nao no fim da qualificacao. O aviso sai aqui, junto da identificacao.
      if (r.situacao === 'CLIENTE') {
        out.updates.push(`🏛️ *Cliente de casa no WhatsApp* — ${r.nome}\n`
          + `📞 ${formatBR(lead.phone)}\n`
          + `${r.vendedor ? `👤 Carteira de ${r.vendedor}\n` : '👤 Sem vendedor definido (bolsao)\n'}`
          + `${r.classificacao ? `🏷️ ${r.classificacao}\n` : ''}`
          + `${r.ultimaCompra ? `🧾 Ultima compra ha ${r.diasDesdeCompra} dias\n` : ''}`
          + `👉 Ficha: ${config.crmUrl}/clientes/${r.id}`);
      }
      return {
        ok: true, situacao: r.situacao, id: r.id, nome: r.nome,
        cidade: r.municipio ? `${r.municipio}/${r.uf}` : null,
        orientacao: r.resumo,
      };
    }
    case 'registrar_qualificacao': {
      const { estagio, resumo, ...fields } = args;
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) =>
        v !== null && v !== undefined && !(typeof v === 'string' && /^\s*(|desconhecid[oa]|n\/?a|não informado|nao informado|-)\s*$/i.test(v))
        && !(Array.isArray(v) && !v.length) && v !== false));
      const dataBefore = lead.data;
      const data = { ...lead.data, ...clean };
      if (clean.produtos_interesse) {
        data.produtos_interesse = [...new Set([...(lead.data.produtos_interesse || []), ...clean.produtos_interesse])];
      }
      const s = scoreLead(data);
      let stage = estagio || (lead.stage === 'novo' ? 'em_qualificacao' : lead.stage);
      if (lead.stage === 'encaminhado' && !data.nao_e_lead) stage = 'encaminhado';
      if (data.nao_e_lead) stage = 'desqualificado';
      lead = await updateLead(leadId, { data, score: s.score, temperature: s.temperature, stage, summary: resumo || lead.summary });
      const prev = dataBefore;
      const novos = ['nome', 'empresa', 'cnpj', 'email', 'cargo', 'cidade_uf', 'volume', 'produtos_interesse', 'prazo']
        .concat('produto_recomendado').filter((k) => clean[k] !== undefined && (Array.isArray(clean[k])
          ? clean[k].some((x) => !(prev[k] || []).includes(x))
          : JSON.stringify(clean[k]) !== JSON.stringify(prev[k])));
      if (lead.handed_off_at && novos.length) {
        const valor = (k) => (Array.isArray(clean[k]) ? clean[k].filter((x) => !(prev[k] || []).includes(x)).join(', ') : clean[k]);
        out.updates.push(`📌 *Atualização do lead* ${data.nome || lead.push_name || ''} (${formatBR(lead.phone)})\n${novos.map((k) => `• ${k.replace(/_/g, ' ')}: ${valor(k)}`).join('\n')}`);
      }
      const aquecido = !lead.handed_off_at && !data.nao_e_lead && s.score >= config.handoffScore;
      return {
        ok: true, score: s.score, temperatura: s.temperature,
        ...(aquecido ? { alerta: `LEAD AQUECIDO (score ≥ ${config.handoffScore}). Se já tiver o nome do cliente e o que ele precisa, chame encaminhar_para_consultor agora e avise que a ${config.sellerName} vai chamar. Se faltar o nome, peça o nome nesta resposta.` } : {}),
      };
    }
    case 'encaminhar_para_consultor': {
      if (lead.handed_off_at) return { ok: true, aviso: `Lead já havia sido encaminhado; ${config.sellerName} já foi notificada.` };
      await updateLead(leadId, { stage: 'encaminhado', handed_off_at: Date.now() });
      out.handoff = { ...args, lead: await getLead(leadId) };
      return { ok: true, mensagem: `${config.sellerName} foi notificada e vai chamar o cliente neste mesmo WhatsApp. Avise o cliente pelo nome dela.` };
    }
    case 'enviar_catalogo':
      out.attachments.push({ kind: 'document', path: new URL('../assets/catalogo-somapel.pdf', import.meta.url).pathname, fileName: 'Catálogo Somapel Embalagens.pdf' });
      return { ok: true, mensagem: 'Catálogo será enviado logo após sua mensagem de texto.' };
    case 'enviar_foto_produto': {
      const pedidos = Array.isArray(args.produtos) ? args.produtos : [args.produtos].filter(Boolean);
      const enviados = [];
      for (const nome of pedidos.slice(0, 3)) {
        const p = PRODUCTS.find((x) => x.nome === nome);
        if (!p?.fotos.length) continue;
        p.fotos.slice(0, 2).forEach((foto, i) => {
          const caption = i === 0 ? `*${p.nome}*\n${p.url}` : undefined;
          out.attachments.push({ kind: 'image', path: ROOT + foto, caption, produto: p.nome });
        });
        enviados.push(p.nome);
      }
      if (!enviados.length) return { ok: false, erro: 'Esse produto não tem foto disponível. Diga isso ao cliente e ofereça o catálogo PDF ou que a vendedora envia.' };
      return { ok: true, mensagem: `Foto(s) de ${enviados.join(', ')} serão enviadas logo após sua mensagem de texto.` };
    }
    default:
      return { ok: false, erro: `ferramenta desconhecida: ${name}` };
  }
}

// Quebra a resposta em balões de WhatsApp: usa "---" se o modelo marcou; senão, parágrafos
// (listas ficam grudadas no parágrafo anterior). No máximo 3 balões.
export function splitBubbles(text) {
  const clean = text.replace(/[ \t]+$/gm, '').replace(/\*\*(.+?)\*\*/g, '*$1*').trim();
  if (!clean) return [];
  let parts = /\n\s*---+\s*(\n|$)/.test(clean) ? clean.split(/\n\s*---+\s*(?:\n|$)/) : clean.split(/\n\s*\n/);
  parts = parts.map((x) => x.trim()).filter(Boolean).reduce((acc, part) => {
    if (acc.length && /^[•\-\d]/.test(part)) acc[acc.length - 1] += `\n${part}`;
    else acc.push(part);
    return acc;
  }, []);
  while (parts.length > 3) parts.splice(-2, 2, `${parts.at(-2)}\n\n${parts.at(-1)}`);
  return parts;
}

function historyToInput(history) {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'human') return { role: 'assistant', content: `[mensagem enviada manualmente por um atendente humano da Somapel]: ${m.content}` };
    if (m.role === 'system') return { role: 'developer', content: m.content };
    return { role: 'assistant', content: m.content };
  });
}

/**
 * Gera a resposta do agente para o lead. As mensagens do usuário já devem estar salvas no histórico.
 * @param {string} leadId
 * @param {{ images?: string[] }} opts  images = data URLs (base64) recebidas neste turno
 * @returns {Promise<{ replies: string[], attachments: object[], handoff: object|null, updates: string[] }>}
 */
export async function runAgent(leadId, { images = [] } = {}) {
  const out = { attachments: [], handoff: null, updates: [] };
  const lead = await getLead(leadId);
  const input = [
    ...historyToInput(await getHistory(leadId, config.historyLimit)),
    { role: 'developer', content: buildContextPrompt(lead) },
  ];

  if (images.length) {
    input.push({
      role: 'user',
      content: [
        { type: 'input_text', text: '(Imagem(ns) enviada(s) pelo cliente nesta mensagem. Analise e use no atendimento.)' },
        ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' })),
      ],
    });
  }

  const isReasoning = /^(gpt-5|o\d)/.test(config.model);
  const texts = [];
  for (let step = 0; step < 6; step++) {
    const res = await openai.responses.create({
      model: config.model,
      instructions: SYSTEM_PROMPT,
      input,
      tools,
      store: false,
      ...(isReasoning ? { reasoning: { effort: config.reasoningEffort }, include: ['reasoning.encrypted_content'] } : {}),
    });
    input.push(...res.output);
    const calls = res.output.filter((o) => o.type === 'function_call');
    for (const item of res.output.filter((o) => o.type === 'message')) {
      const t = item.content.filter((c) => c.type === 'output_text').map((c) => c.text).join('').trim();
      if (t && !texts.includes(t)) texts.push(t);
    }
    if (!calls.length) break;
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* argumentos inválidos */ }
      // await obrigatorio: sem ele o JSON.stringify abaixo serializaria uma Promise e o
      // modelo receberia "{}" como resultado da ferramenta, sem erro nenhum.
      const result = await handleTool(leadId, call.name, args, out);
      if (process.env.DEBUG) console.log(`  🔧 ${call.name}`, JSON.stringify(args), '→', JSON.stringify(result));
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  // Rede de segurança: lead aquecido com nome e interesse conhecidos vai para a vendedora mesmo se o modelo esquecer.
  const after = await getLead(leadId);
  // Usa o nome informado na conversa; o nome do perfil do WhatsApp só serve de fallback para lead quente.
  const temNome = after.data.nome || (after.temperature === 'quente' && after.push_name);
  if (!after.handed_off_at && !after.data.nao_e_lead && after.score >= config.handoffScore
    && temNome && after.data.produtos_interesse?.length) {
    await updateLead(leadId, { stage: 'encaminhado', handed_off_at: Date.now() });
    out.handoff = { motivo: 'lead_aquecido', urgencia: after.temperature === 'quente' ? 'alta' : 'media', resumo_para_consultor: after.summary || after.data.necessidade || '', lead: await getLead(leadId) };
  }

  const replies = splitBubbles(texts.join('\n\n'));
  if (replies.length) await addMessage(leadId, 'assistant', replies.join('\n\n'));
  return { replies, ...out };
}

export async function transcribeAudio(buffer, filename = 'audio.ogg') {
  const file = await OpenAI.toFile(buffer, filename);
  const r = await openai.audio.transcriptions.create({ file, model: config.transcribeModel, language: 'pt' });
  return r.text;
}

export function formatHandoff(h) {
  const l = h.lead;
  const d = l.data;
  const s = scoreLead(d);
  const icon = { quente: '🔥', morno: '🟡', frio: '🔵' }[s.temperature];
  const nome = d.nome || l.push_name || 'Cliente sem nome';
  return [
    `Oi, ${config.sellerName}! ${icon} *Lead ${s.temperature} para você* — ${h.motivo.replace(/_/g, ' ')} (urgência ${h.urgencia})`,
    '',
    `👤 *${nome}*${d.cargo ? ` (${d.cargo})` : ''}`,
    `📞 ${l.phone ? formatBR(l.phone) : l.id}`,
    d.empresa || d.segmento || d.cnpj ? `🏢 ${[d.empresa, d.segmento, d.cnpj && `CNPJ ${d.cnpj}`].filter(Boolean).join(' · ')}` : null,
    // Cliente de casa muda a conversa inteira da vendedora: ela abre a ficha antes de ligar.
    l.entidade_id != null
      ? `${d.ja_e_cliente ? '🏛️ *Ja e cliente da Somapel*' : '📇 Cadastro no CRM'} · ${config.crmUrl}/clientes/${l.entidade_id}`
      : null,
    d.cidade_uf ? `📍 ${d.cidade_uf}` : null,
    d.email ? `✉️ ${d.email}` : null,
    '',
    `📝 *O que precisa:* ${h.resumo_para_consultor}`,
    '',
    `📦 *Produto:* ${d.produto_recomendado || (d.produtos_interesse || []).at(-1) || '—'}`,
    `📊 Volume: ${d.volume || '—'}${d.prazo && d.prazo !== 'sem_prazo' ? ` · Prazo: ${d.prazo.replace(/_/g, ' ')}` : ''}`,
    `⭐ Score ${s.score}/100 (fit ${s.fit} · intenção ${s.intent})`,
    l.phone ? `\n👉 Chamar agora: https://wa.me/${l.phone}` : '',
  ].filter((x) => x !== null).join('\n');
}

// vCard do lead, para a vendedora salvar/chamar com um toque.
export function leadVCard(lead) {
  const nome = lead.data.nome || lead.push_name || 'Lead Somapel';
  const org = lead.data.empresa ? `ORG:${lead.data.empresa}\n` : '';
  return {
    displayName: nome,
    phone: lead.phone,
    empresa: lead.data.empresa,
    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${nome} (Lead Somapel)\n${org}TEL;type=CELL;waid=${lead.phone}:${formatBR(lead.phone)}\nEND:VCARD`,
  };
}
