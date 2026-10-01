// Armazenamento das conversas no Postgres do CRM.
//
// Era SQLite num arquivo local. Dois motivos para sair de lá: o arquivo morre junto com o
// contêiner (e o combinado é que este serviço não pode cair), e nenhuma tela alcança um
// SQLite dentro de outro processo. No Postgres do CRM os dados entram no backup que já
// existe, a tela de conversas lê direto e não há sincronização nem duas verdades.
//
// **A interface não mudou de forma, só de tempo.** As mesmas sete funções, os mesmos
// objetos de volta — só que agora com `await`. Foi de propósito: o resto do agente não
// precisa saber onde os dados moram.
//
// A tradução de vocabulário mora aqui e só aqui. O agente pensa em "lead", "stage",
// "push_name"; o CRM fala "conversa", "etapa", "nome do WhatsApp" — e a palavra "lead"
// não existe no glossário de lá. Traduzir na fronteira deixa os dois lados coerentes
// consigo mesmos.
import pg from 'pg';
import { config } from './config.js';

// O Postgres devolve BIGINT e NUMERIC como string para não perder precisão. Aqui os ids
// cabem folgados em Number, e string vazando para o resto do código viraria bug silencioso.
pg.types.setTypeParser(20, (v) => Number(v));

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Poucas conexões de propósito: é um processo só, e o RDS é compartilhado com o CRM.
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // O RDS exige TLS e usa certificado da própria AWS.
  ssl: config.databaseUrl?.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : undefined,
});

/**
 * Toda conexao fala UTC.
 *
 * O RDS vem com o fuso da sessao em America/Sao_Paulo, e as colunas de data sao
 * `timestamp without time zone`. Com isso, `now()` gravava a hora **local** — enquanto o
 * resto do sistema (Prisma, na API) grava UTC e a tela le tudo como UTC. O efeito era que
 * conversa, mensagem e disparo apareciam tres horas no passado, e so eles.
 *
 * Fica no `connect` e nao na string de conexao para valer tambem nas conexoes que o pool
 * abre depois, que sao a maioria.
 */
pool.on('connect', (c) => { c.query("SET TIME ZONE 'UTC'").catch(() => {}); });

pool.on('error', (err) => {
  // Conexão ociosa derrubada pelo servidor não é motivo para matar o processo: o pool abre
  // outra na próxima consulta. Sem este handler, o Node encerra o agente.
  console.error('⚠️  erro no pool do Postgres:', err.message);
});

const q = (texto, valores) => pool.query(texto, valores);

/* ─────────────────────────── tradução na fronteira ─────────────────────────── */

const PAPEL_PARA_CRM = { user: 'cliente', assistant: 'ia', human: 'humano', system: 'sistema' };
const PAPEL_DO_CRM = { cliente: 'user', ia: 'assistant', humano: 'human', sistema: 'system' };

/** Da linha do banco para o objeto que o agente espera, com os nomes dele. */
function paraLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.telefone,
    push_name: row.nome_whatsapp,
    origin: row.origem,
    stage: row.etapa,
    score: row.score,
    temperature: row.temperatura,
    data: row.dados ?? {},
    summary: row.resumo,
    // O agente compara com `Date.now()`; no banco é timestamp. A conversão fica aqui para
    // nenhum `lead.paused_until > Date.now()` espalhado pelo código precisar mudar.
    paused_until: row.pausada_ate ? new Date(row.pausada_ate).getTime() : 0,
    handed_off_at: row.encaminhada_em ? new Date(row.encaminhada_em).getTime() : null,
    prospect_id: row.prospect_id ?? null,
    // Quem e, depois que o documento foi identificado: id positivo e cliente do Protheus,
    // negativo e prospect do CRM — a mesma convencao da tela de clientes.
    doc: row.doc ?? null,
    entidade_id: row.entidade_id ?? null,
    created_at: new Date(row.criada_em).getTime(),
    updated_at: new Date(row.atualizada_em).getTime(),
  };
}

/** Dos campos do agente para as colunas do CRM. */
const COLUNA = {
  phone: 'telefone', push_name: 'nome_whatsapp', origin: 'origem', stage: 'etapa',
  score: 'score', temperature: 'temperatura', data: 'dados', summary: 'resumo',
  paused_until: 'pausada_ate', handed_off_at: 'encaminhada_em', prospect_id: 'prospect_id',
  doc: 'doc', entidade_id: 'entidade_id',
};
/** Campos de tempo chegam como epoch ms do agente e saem como timestamp para o banco. */
const TEMPO = new Set(['paused_until', 'handed_off_at']);

/* ──────────────────────────────── a interface ──────────────────────────────── */

export async function getLead(id) {
  const { rows } = await q('SELECT * FROM crm.conversas WHERE id = $1', [id]);
  return paraLead(rows[0]);
}

export async function upsertLead(id, { phone, pushName } = {}) {
  // Uma ida ao banco em vez de "busca, decide, escreve": duas mensagens chegando juntas
  // criariam a mesma conversa duas vezes, e a segunda estouraria na chave primária.
  const { rows } = await q(
    `INSERT INTO crm.conversas (id, telefone, nome_whatsapp, atualizada_em)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
        SET nome_whatsapp = coalesce(EXCLUDED.nome_whatsapp, crm.conversas.nome_whatsapp),
            atualizada_em = now()
     RETURNING *`,
    [id, phone || null, pushName || null],
  );
  return paraLead(rows[0]);
}

export async function updateLead(id, campos) {
  const entradas = Object.entries(campos).filter(([c]) => COLUNA[c]);
  if (!entradas.length) return getLead(id);

  const sets = entradas.map(([c], i) => `${COLUNA[c]} = $${i + 2}`);
  const valores = entradas.map(([c, v]) => {
    if (TEMPO.has(c)) return v ? new Date(v) : null;
    if (c === 'data') return JSON.stringify(v ?? {});
    return v;
  });
  const { rows } = await q(
    `UPDATE crm.conversas SET ${sets.join(', ')}, atualizada_em = now()
      WHERE id = $1 RETURNING *`,
    [id, ...valores],
  );
  return paraLead(rows[0]);
}

export async function addMessage(leadId, role, content) {
  await q(
    'INSERT INTO crm.mensagens_whatsapp (conversa_id, papel, conteudo) VALUES ($1, $2, $3)',
    [leadId, PAPEL_PARA_CRM[role] ?? role, content],
  );
  // Mensagem nova reordena a lista de conversas da tela. Sem isto, a conversa que acabou de
  // receber mensagem ficaria no fim da lista até alguém mexer nela.
  await q('UPDATE crm.conversas SET atualizada_em = now() WHERE id = $1', [leadId]);
}

export async function getHistory(leadId, limit) {
  const { rows } = await q(
    `SELECT papel, conteudo, criada_em FROM crm.mensagens_whatsapp
      WHERE conversa_id = $1 ORDER BY id DESC LIMIT $2`,
    [leadId, limit],
  );
  return rows.reverse().map((r) => ({
    role: PAPEL_DO_CRM[r.papel] ?? r.papel,
    content: r.conteudo,
    created_at: new Date(r.criada_em).getTime(),
  }));
}

export async function listLeads() {
  const { rows } = await q(
    'SELECT * FROM crm.conversas ORDER BY score DESC, atualizada_em DESC',
  );
  return rows.map(paraLead);
}

export async function resetLead(id) {
  // As mensagens caem por CASCADE; apagar explicitamente deixa a intenção à vista.
  await q('DELETE FROM crm.mensagens_whatsapp WHERE conversa_id = $1', [id]);
  await q('DELETE FROM crm.conversas WHERE id = $1', [id]);
}

/**
 * Mensagens que uma pessoa escreveu pelo CRM e ainda não foram para o WhatsApp.
 *
 * `FOR UPDATE SKIP LOCKED` é o que torna isto seguro com mais de um processo: cada um leva
 * linhas diferentes, ninguém espera ninguém e nada é enviado duas vezes. É fila de verdade
 * sem precisar de Redis — uma peça a menos para cair.
 */
export async function pegarEnviosPendentes(limite = 20) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT m.id, m.conversa_id, m.conteudo, c.telefone
         FROM crm.mensagens_whatsapp m
         JOIN crm.conversas c ON c.id = m.conversa_id
        WHERE m.papel = 'humano' AND m.enviada_em IS NULL
        ORDER BY m.id
        LIMIT $1
          FOR UPDATE OF m SKIP LOCKED`,
      [limite],
    );
    return { cliente, rows };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    cliente.release();
    throw err;
  }
}

export async function marcarEnviada(cliente, id, erro = null) {
  await cliente.query(
    'UPDATE crm.mensagens_whatsapp SET enviada_em = now(), erro_envio = $2 WHERE id = $1',
    [id, erro],
  );
}

export async function fecharLote(cliente, ok = true) {
  await cliente.query(ok ? 'COMMIT' : 'ROLLBACK').catch(() => {});
  cliente.release();
}

export async function encerrar() {
  await pool.end();
}

/* ───────────────────────── disparos de campanha ───────────────────────── */

/**
 * Pega um lote de envios de campanha prontos para sair.
 *
 * `FOR UPDATE SKIP LOCKED` pelo mesmo motivo da fila de mensagens: dobrar o numero de
 * agentes amanha nao pode mandar a mesma mensagem duas vezes. E so de disparo com status
 * ENVIANDO — enquanto a pessoa nao aperta o botao na tela, as linhas ficam paradas.
 */
export async function pegarCampanhaPendente(limite = 10) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT e.id, e.telefone, e.texto, e.nome, e.base_id, e.disparo_id,
              t.nome AS template_nome, t.idioma, e.variaveis
         FROM crm.disparo_envios e
         JOIN crm.disparos d  ON d.id = e.disparo_id
         JOIN crm.templates t ON t.id = d.template_id
        WHERE e.status = 'PENDENTE' AND d.status = 'ENVIANDO'
        ORDER BY e.id
        LIMIT $1
          FOR UPDATE OF e SKIP LOCKED`,
      [limite],
    );
    return { cliente, rows };
  } catch (err) {
    cliente.query('ROLLBACK').catch(() => {});
    cliente.release();
    throw err;
  }
}

export async function marcarCampanhaEnviada(cliente, id, wamid, erro = null) {
  await cliente.query(
    `UPDATE crm.disparo_envios
        SET status = $3, wamid = $2, enviado_em = CASE WHEN $3 = 'ENVIADO' THEN now() END, erro = $4
      WHERE id = $1`,
    [id, wamid, erro ? 'FALHOU' : 'ENVIADO', erro],
  );
}

export async function fecharLoteCampanha(cliente, ok) {
  try { await cliente.query(ok ? 'COMMIT' : 'ROLLBACK'); } finally { cliente.release(); }
}

/** Fecha o disparo quando nao sobrou nada pendente. */
export async function fecharDisparosConcluidos() {
  await q(
    `UPDATE crm.disparos d SET status = 'CONCLUIDO', concluido_em = now()
      WHERE d.status = 'ENVIANDO'
        AND NOT EXISTS (SELECT 1 FROM crm.disparo_envios e
                         WHERE e.disparo_id = d.id AND e.status = 'PENDENTE')`,
  );
}

/**
 * O relatorio de entrega da Meta, casado pelo `wamid`.
 *
 * Pelo telefone nao daria: a mesma pessoa recebe de novo no disparo seguinte, e o status
 * de hoje marcaria a mensagem do mes passado.
 */
export async function registrarStatusDeEntrega(wamid, status, erro = null) {
  const coluna = { delivered: 'entregue_em', read: 'lido_em' }[status];
  if (status === 'failed') {
    await q(`UPDATE crm.disparo_envios SET status='FALHOU', erro=$2 WHERE wamid=$1`, [wamid, erro]);
    return;
  }
  if (!coluna) return;
  // `coalesce` para o primeiro carimbo vencer: a Meta reenvia status, e sobrescrever faria
  // a hora da entrega andar para frente sozinha.
  await q(
    `UPDATE crm.disparo_envios
        SET ${coluna} = coalesce(${coluna}, now()),
            status = CASE WHEN $2 = 'read' THEN 'LIDO'
                          WHEN status IN ('ENVIADO') THEN 'ENTREGUE' ELSE status END
      WHERE wamid = $1`,
    [wamid, status],
  );
}

/**
 * Liga a resposta de alguem ao disparo que a provocou.
 *
 * So o envio mais recente daquele telefone, e so dentro de sete dias: resposta de hoje a
 * uma campanha de marco nao e resposta, e contar como se fosse inflaria o funil.
 */
export async function registrarRespostaDeCampanha(telefones, texto, interesse, leadId) {
  // **Lista de variantes, nao um numero.** O WhatsApp entrega o remetente sem o nono digito
  // em conta antiga (553197737057), e a campanha saiu para o numero com ele
  // (5531997737057). Com igualdade exata, nenhuma resposta casava — o funil do primeiro
  // disparo real ficou em zero com gente ja respondendo. `brVariants` gera as duas formas.
  const lista = Array.isArray(telefones) ? telefones : [telefones];
  const { rows } = await q(
    `UPDATE crm.disparo_envios SET respondido_em = coalesce(respondido_em, now()),
            resposta = coalesce(resposta, $2),
            interesse = coalesce($3, interesse)
      WHERE id = (SELECT id FROM crm.disparo_envios
                   WHERE telefone = ANY($1::text[]) AND enviado_em IS NOT NULL
                     AND enviado_em > now() - interval '7 days'
                   ORDER BY enviado_em DESC LIMIT 1)
      RETURNING id, disparo_id, base_id, telefone`,
    [lista, texto.slice(0, 500), interesse],
  );
  const envio = rows[0] ?? null;

  // Quem responde a uma campanha ja esta identificado: a mensagem saiu para um cadastro.
  // Ligar a conversa a ele aqui e o que faz o botao "abrir o cadastro" existir no chat — sem
  // isto, so apareceria depois de a Sofia pedir o CNPJ, que numa resposta de campanha ela
  // nem precisa pedir.
  //
  // `coalesce` para nao sobrescrever uma identificacao que ja exista: as duas sao certas, e
  // a primeira ja esta na tela.
  if (envio && leadId) {
    await q(
      `INSERT INTO crm.conversas (id, telefone, entidade_id, criada_em, atualizada_em)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE
          SET entidade_id = coalesce(crm.conversas.entidade_id, EXCLUDED.entidade_id),
              atualizada_em = now()`,
      [leadId, envio.telefone, envio.base_id],
    );
  }
  return envio;
}

/** Quem pediu para parar nunca mais entra em lista — a supressao sobrevive as cargas do ETL. */
export async function suprimirTelefone(telefone, motivo = 'OPT_OUT') {
  await q(
    `INSERT INTO public.supressao (tipo, valor, motivo, observacao)
     VALUES ('TELEFONE', $1, $2, 'pedido pelo proprio cliente no WhatsApp')
     ON CONFLICT (tipo, valor) DO NOTHING`,
    [telefone, motivo],
  );
}

/** O usuario do CRM em nome de quem a IA registra. Resolvido uma vez e guardado. */
let idDoUsuarioDaIa = null;
async function usuarioDaIa() {
  if (idDoUsuarioDaIa) return idDoUsuarioDaIa;
  const { rows } = await q('SELECT id FROM crm.usuarios WHERE email = $1', [config.crmEmail]);
  idDoUsuarioDaIa = rows[0]?.id ?? null;
  return idDoUsuarioDaIa;
}

/**
 * A mensagem de campanha vira atendimento na ficha do cliente.
 *
 * Sem isto o vendedor abre a ficha no dia seguinte, liga, e descobre pelo cliente que a
 * empresa ja tinha mandado mensagem — ou pior, nao descobre.
 *
 * Fica no nome do **usuario da IA**, nao de quem montou a campanha. Um disparo de 240
 * somaria 240 atendimentos a conta de uma pessoa so e destruiria a meta semanal que o time
 * acompanha. Campanha e automacao; atendimento de vendedor e outra coisa.
 *
 * `MENSAGEM_ENVIADA` e o resultado certo pelo proprio glossario do CRM: conta tentativa,
 * mas nao e o mesmo que ter conversado.
 */
export async function registrarAtendimentoDeCampanha(cliente, envioId) {
  const usuarioId = await usuarioDaIa();
  if (!usuarioId) return;
  await cliente.query(
    `INSERT INTO crm.interacoes (id, base_id, origem, codigo, loja, usuario_id, tipo, resultado, observacao, criada_em)
     SELECT gen_random_uuid()::text, b.id, b.origem, b.codigo, b.loja, $2, 'WHATSAPP', 'MENSAGEM_ENVIADA',
            left('Campanha "' || d.nome || '": ' || e.texto, 2000), now()
       FROM crm.disparo_envios e
       JOIN crm.disparos d       ON d.id = e.disparo_id
       JOIN public.v_entidades b ON b.id = e.base_id
      WHERE e.id = $1`,
    [envioId, usuarioId],
  );
}

/**
 * A mensagem de campanha entra na conversa, como qualquer outra que a gente mandou.
 *
 * Sem isto o chat mostrava so a resposta do cliente — "ainda tenho, vou ver se preciso" —
 * sem o que a gente perguntou. Quem atende lia metade do dialogo e tinha que adivinhar a
 * outra. A campanha e uma mensagem nossa no WhatsApp: o lugar dela e no fio da conversa.
 *
 * Cria a conversa se ainda nao existir e ja a liga ao cadastro: a mensagem saiu para um
 * cliente conhecido, entao o botao "abrir o cadastro" funciona desde o primeiro balao.
 */
export async function registrarMensagemDeCampanha(cliente, envioId, leadId) {
  const { rows } = await cliente.query(
    `SELECT e.telefone, e.texto, e.base_id FROM crm.disparo_envios e WHERE e.id = $1`,
    [envioId],
  );
  const e = rows[0];
  if (!e) return;

  await cliente.query(
    `INSERT INTO crm.conversas (id, telefone, origem, entidade_id, criada_em, atualizada_em)
     VALUES ($1, $2, 'outbound', $3, now(), now())
     ON CONFLICT (id) DO UPDATE
        SET entidade_id = coalesce(crm.conversas.entidade_id, EXCLUDED.entidade_id),
            atualizada_em = now()`,
    [leadId, e.telefone, e.base_id],
  );
  await cliente.query(
    `INSERT INTO crm.mensagens_whatsapp (conversa_id, papel, conteudo, enviada_em)
     VALUES ($1, 'campanha', $2, now())`,
    [leadId, e.texto],
  );
}
