// Todos os números são do Brasil: aceita "31 99314-4382", "+55 (31) 99314-4382" etc. e devolve 5531993144382.
export function normalizeBR(v) {
  const d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.length > 13) return d; // não é telefone (ex.: LID do WhatsApp)
  return d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
}

// Mesmo número com e sem o 9º dígito (contas antigas de WhatsApp no Brasil usam o formato sem o 9).
export function brVariants(v) {
  const n = normalizeBR(v);
  const m = n.match(/^55(\d{2})(\d+)$/);
  if (!m) return [n];
  const [, ddd, rest] = m;
  if (rest.length === 9 && rest.startsWith('9')) return [n, `55${ddd}${rest.slice(1)}`];
  if (rest.length === 8) return [n, `55${ddd}9${rest}`];
  return [n];
}

export function formatBR(v) {
  let n = normalizeBR(v);
  if (/^55\d{2}[6-9]\d{7}$/.test(n)) n = `${n.slice(0, 4)}9${n.slice(4)}`; // celular salvo sem o 9º dígito
  const m = n.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${v}`;
}

const list = (v) => (v || '').split(',').map(normalizeBR).filter(Boolean);
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|sim|yes)$/i.test(v));

export const config = {
  openaiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'medium',
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',

  agentName: process.env.AGENT_NAME || 'Sofia',
  companyName: 'Somapel Embalagens',

  // Segurança no teste com número pessoal: só responde esses números (DDI+DDD+número).
  allowedNumbers: list(process.env.ALLOWED_NUMBERS),
  replyToAll: bool(process.env.REPLY_TO_ALL),

  // Vendedora(es) que recebem o lead aquecido: nome + número.
  sellerName: process.env.SELLER_NAME || 'Flavia',
  sellerNumbers: list(process.env.SELLER_WHATSAPP),
  // A partir deste score o lead é considerado aquecido e é encaminhado para a vendedora.
  handoffScore: Number(process.env.HANDOFF_SCORE || 60),

  // Aguarda o lead terminar de digitar várias mensagens seguidas antes de responder.
  bufferSeconds: Number(process.env.BUFFER_SECONDS || 8),
  // Se alguém do time responder manualmente no chat, o bot pausa nesse chat.
  humanPauseMinutes: Number(process.env.HUMAN_PAUSE_MINUTES || 180),
  historyLimit: Number(process.env.HISTORY_LIMIT || 40),

  // WhatsApp Cloud API (Meta)
  waToken: process.env.WHATSAPP_TOKEN,
  waNumberId: process.env.WHATSAPP_NUMBER_ID,
  waBusinessId: process.env.WHATSAPP_BUSINESS_ID,
  waPhone: normalizeBR(process.env.WHATSAPP_PHONE),
  waApiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
  waVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  waAppSecret: process.env.WHATSAPP_APP_SECRET,
  webhookPort: Number(process.env.WEBHOOK_PORT || 8080),

  dbPath: process.env.DB_PATH || 'data/somapel.db',
  authDir: process.env.WA_AUTH_DIR || 'data/wa-auth',
  pairingNumber: (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, ''),
  timezone: 'America/Sao_Paulo',
};

if (!config.openaiKey) {
  console.error('OPENAI_API_KEY não encontrada. Rode com: node --env-file=.env ...');
  process.exit(1);
}
