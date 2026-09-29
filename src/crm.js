// Ponte com o CRM: o prospect qualificado nasce lá dentro.
//
// **Autentica como usuário de verdade**, com e-mail e senha de um login dedicado ao agente.
// A alternativa seria uma rota interna com segredo compartilhado, e ela seria pior por dois
// motivos: abriria superfície nova numa API que está aberta na internet, e o prospect
// apareceria sem autor. Assim ele nasce assinado — "criado por SDR IA" — e passa pelas
// mesmas permissões, pela mesma trava de CNPJ duplicado e pelo mesmo log de auditoria que
// qualquer cadastro feito à mão.
import { config } from './config.js';

let token = null;
let expiraEm = 0;

/** O JWT do CRM dura 15 minutos. Renova com folga para não morrer no meio de uma chamada. */
async function autenticar() {
  if (token && Date.now() < expiraEm) return token;

  const r = await fetch(`${config.crmUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.crmEmail, senha: config.crmSenha }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`login no CRM falhou: ${r.status}`);
  const { accessToken } = await r.json();
  token = accessToken;
  expiraEm = Date.now() + 12 * 60_000;
  return token;
}

async function chamar(caminho, opcoes = {}, tentarDeNovo = true) {
  const t = await autenticar();
  const r = await fetch(`${config.crmUrl}/api/v1${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...opcoes.headers },
    signal: AbortSignal.timeout(15_000),
  });
  // 401 com token que parecia válido: o CRM reiniciou ou a sessão caiu. Uma segunda chance
  // com token novo evita perder o prospect por causa de um deploy no meio da conversa.
  if (r.status === 401 && tentarDeNovo) {
    token = null;
    return chamar(caminho, opcoes, false);
  }
  return r;
}

/** Só dígitos, e só o que tem cara de CNPJ ou CPF. A IA às vezes traz o número com texto junto. */
const soDocumento = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 14 || d.length === 11 ? d : null;
};

/** "Belo Horizonte/MG" → { municipio, uf }. A IA entrega assim, numa string só. */
function separarCidadeUf(v) {
  const t = String(v ?? '').trim();
  const m = t.match(/^(.*?)[\/\-,]\s*([A-Za-z]{2})$/);
  return m ? { municipio: m[1].trim(), uf: m[2].toUpperCase() } : { municipio: t || null, uf: null };
}

/**
 * Descobre de quem e o documento — e cadastra se ainda nao for de ninguem.
 *
 * O CRM resolve tudo numa chamada so (ver `IdentificacaoService` la): procura no espelho do
 * Protheus, procura nos prospects criados aqui, e, nao achando, consulta a Receita e cria o
 * cadastro ja preenchido. Aqui e so o transporte.
 *
 * **Nunca lanca.** Uma falha de rede no meio do atendimento nao pode calar a Sofia; ela
 * segue a conversa e o documento fica salvo nos dados da conversa de qualquer jeito.
 * Devolver `null` faz o modelo tratar como "nao consegui agora", que e a verdade.
 */
export async function identificarDocumento({ doc, telefone, contatoNome, nome, observacao }, log = console.log) {
  if (!config.crmUrl || !config.crmEmail) return null;
  try {
    const r = await chamar('/clientes/identificar', {
      method: 'POST',
      body: JSON.stringify({ doc, telefone, contatoNome, nome, observacao }),
    });
    if (!r.ok) {
      log(`⚠️  CRM recusou a identificacao de ${doc}: ${r.status} ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    const dados = await r.json();
    const rotulo = { CLIENTE: '🏛️  cliente de casa', PROSPECT: '📇 prospect ja cadastrado',
                     CRIADO: '🆕 prospect criado', SEM_CADASTRO: '❔ sem cadastro',
                     DOC_INVALIDO: '❌ documento invalido' }[dados.situacao] ?? dados.situacao;
    log(`${rotulo}: ${dados.nome ?? doc}`);
    return dados;
  } catch (err) {
    log(`⚠️  falha ao identificar ${doc} no CRM: ${err.message}`);
    return null;
  }
}

/**
 * Grava o atendimento na ficha do cliente.
 *
 * O CRM trata uma conversa como UM atendimento por dia: chamar de novo no mesmo dia so
 * atualiza o resumo, nao cria linha nova. Por isso esta funcao pode ser chamada a cada
 * resposta sem encher a ficha — a decisao de agrupar e de la, nao daqui.
 *
 * So faz sentido com `entidadeId`: sem cadastro nao ha ficha onde escrever. A conversa em
 * si continua salva em `crm.conversas` de qualquer jeito.
 *
 * **Nunca lanca.** Falhar em registrar nao pode derrubar o atendimento em andamento.
 */
export async function registrarAtendimento({ entidadeId, conversaId, resultado, observacao }, log = console.log) {
  if (!config.crmUrl || !config.crmEmail || entidadeId == null) return null;
  const texto = (observacao ?? '').trim();
  if (!texto) return null;

  try {
    const r = await chamar(`/clientes/${entidadeId}/atendimento-whatsapp`, {
      method: 'POST',
      body: JSON.stringify({ conversaId, resultado, observacao: texto.slice(0, 2000) }),
    });
    if (!r.ok) {
      log(`⚠️  CRM recusou o atendimento de ${conversaId}: ${r.status} ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    log(`⚠️  falha ao registrar atendimento de ${conversaId}: ${err.message}`);
    return null;
  }
}

/**
 * Cria o prospect no CRM a partir do que a IA extraiu.
 *
 * Devolve `{ id }` quando criou, `null` quando não havia o mínimo ou quando o cadastro já
 * existe. **Nunca lança para cima**: falhar em criar o prospect não pode derrubar o
 * atendimento — a conversa continua e o dado fica guardado na conversa de qualquer jeito.
 *
 * Sem nome de empresa não cria nada. Um prospect chamado "João do WhatsApp" polui a lista
 * de 14 mil cadastros e não ajuda ninguém a vender.
 */
export async function criarProspect(lead, log = console.log) {
  if (!config.crmUrl || !config.crmEmail) return null;

  const d = lead?.data ?? {};
  const nome = (d.empresa || '').trim();
  if (!nome) return null;

  const { municipio, uf } = separarCidadeUf(d.cidade_uf);
  const telefones = [lead.phone].filter(Boolean);

  const corpo = {
    nome,
    doc: soDocumento(d.cnpj),
    contatoNome: (d.nome || lead.push_name || '').trim() || null,
    telefones,
    email: (d.email || '').trim() || null,
    municipio, uf,
    ramo: (d.segmento || '').trim() || null,
    // O que o vendedor precisa ler antes de ligar, numa linha só.
    observacao: [
      d.necessidade && `Precisa: ${d.necessidade}`,
      d.volume && `Volume: ${d.volume}`,
      d.prazo && `Prazo: ${d.prazo}`,
      d.solucao_atual && `Hoje usa: ${d.solucao_atual}`,
      `Veio pelo WhatsApp · score ${lead.score} (${lead.temperature})`,
    ].filter(Boolean).join(' · ').slice(0, 500),
  };

  try {
    const r = await chamar('/clientes/prospects', { method: 'POST', body: JSON.stringify(corpo) });
    if (r.status === 409) {
      // CNPJ já cadastrado — no Protheus ou aqui. Não é erro: é o CRM evitando duplicata,
      // e o vendedor acha o cadastro pela busca.
      log(`ℹ️  ${nome} já existe no CRM (CNPJ duplicado)`);
      return null;
    }
    if (!r.ok) {
      log(`⚠️  CRM recusou o prospect ${nome}: ${r.status} ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    const criado = await r.json();
    log(`🆕 prospect criado no CRM: ${nome} (id ${criado.id})`);
    return criado;
  } catch (err) {
    log(`⚠️  falha ao criar prospect no CRM: ${err.message}`);
    return null;
  }
}
