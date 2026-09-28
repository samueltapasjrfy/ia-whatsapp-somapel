// Roda conversas roteirizadas contra o agente para avaliar qualidade/regressão.
// Uso: npm run simular [-- nome-do-cenario]
import { formatHandoff, runAgent } from './agent.js';
import { addMessage, getLead, resetLead, upsertLead } from './db.js';

const CENARIOS = {
  aco_para_pet: [
    'oi, boa tarde. vcs tem fita pet?',
    'eu uso fita de aço hoje pra arquear bobina de chapa, uns 60 pallets por semana, mas enferruja e mancha o material',
    'aplicamos manual com esticador e selador. sou o Carlos, comprador da Metalúrgica Vale Forte em Contagem',
    'quero um orçamento sim, preciso pra semana que vem',
  ],
  stretch_frigorifico: [
    'Bom dia! Preciso de filme stretch para câmara fria',
    'Somos um frigorífico em Sete Lagoas, paletizamos uns 25 pallets por dia na mão. o filme atual rasga e solta no frio',
    'qual o preço da bobina?',
    'Frigorífico Serra Azul, sou a Juliana do suprimentos. cnpj 12.345.678/0001-90',
  ],
  flavia_real: ['oi', 'filme stretch', 'pallet', 'manual', '3 por dia', 'sou a Flavia da Metalfix, em Contagem'],
  direto: ['bom dia, preciso de fita pet pra arquear pallet', 'manual', 'Rodrigo, Cerâmica Alvorada, Pedro Leopoldo. uns 200 pallets por mês'],
  foto_pet: [
    'boa tarde, vcs trabalham com fita pet?',
    'é pra pallet de cerâmica, uns 500kg cada',
    'tem uma foto dela pra me mandar?',
  ],
  foto_aparelho: [
    'preciso de um aparelho pra arquear fita de aço de 19mm manualmente',
    'e o selador também. consegue me mandar foto desses dois?',
  ],
  foto_sem_foto: ['vcs tem fita zebrada? me manda uma foto'],
  aquece_sozinho: [
    'oi, sou o Rafael da Transportadora Rota Minas, em Betim',
    'a gente usa filme stretch manual, uns 40 pallets por dia, compra todo mês. sou eu que cuido das compras',
    'o operador reclama muito do peso da bobina e esse mês já tá acabando nosso estoque',
  ],
  so_oi: ['oi', 'queria ver o que vcs vendem'],
  maquina_parada: ['minha máquina de arquear sopack 6000 parou de soldar a fita, preciso de técnico urgente, estamos em Betim'],
  pessoa_fisica: ['olá, vcs vendem plástico bolha pra mudança? é só pra minha casa', 'preciso de uns 2 rolos'],
  curriculo: ['Boa tarde, gostaria de enviar meu currículo para vaga de auxiliar de produção'],
  robo_e_preco: ['vc é um robô?', 'me fala o preço da fita adesiva marrom e o prazo de entrega pra SP'],
};

const only = process.argv[2];
for (const [nome, falas] of Object.entries(CENARIOS)) {
  if (only && nome !== only) continue;
  const id = `sim:${nome}`;
  resetLead(id);
  upsertLead(id, { phone: '5531900000000', pushName: 'Lead Simulado' });
  console.log(`\n\x1b[1m════════ ${nome} ════════\x1b[0m`);
  for (const fala of falas) {
    console.log(`\x1b[36m👤 ${fala}\x1b[0m`);
    addMessage(id, 'user', fala);
    const t0 = Date.now();
    const { replies, attachments, handoff, updates } = await runAgent(id);
    console.log(`\x1b[90m   (${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m`);
    for (const r of replies) console.log(`\x1b[32m🤖 ${r.replace(/\n/g, '\n   ')}\x1b[0m`);
    for (const a of attachments) console.log(`\x1b[33m📎 ${a.kind}: ${a.fileName || a.path?.split('/').pop()}${a.caption ? ` — ${a.caption.replace(/\n/g, ' | ')}` : ''}\x1b[0m`);
    if (handoff) console.log(`\x1b[35m${formatHandoff(handoff)}\x1b[0m`);
    for (const u of updates) console.log(`\x1b[35m${u}\x1b[0m`);
  }
  const l = getLead(id);
  console.log(`\x1b[90m→ score ${l.score} (${l.temperature}) · ${l.stage} · ${JSON.stringify(l.data)}\x1b[0m`);
}
