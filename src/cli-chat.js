// Simulador de conversa no terminal (sem WhatsApp).
// Uso: npm run chat [-- nome-da-sessao]   ·  comandos: /reset  /lead  /sair
import readline from 'node:readline/promises';
import { formatHandoff, runAgent } from './agent.js';
import { addMessage, getLead, resetLead, upsertLead } from './db.js';

const leadId = `cli:${process.argv[2] || 'teste'}`;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

await upsertLead(leadId, { phone: '5531999990000', pushName: 'Teste CLI' });
console.log(`\n💬 Simulador Somapel SDR — sessão "${leadId}". Comandos: /reset /lead /sair\n`);

while (true) {
  const input = (await rl.question('\x1b[36mVocê:\x1b[0m ')).trim();
  if (!input) continue;
  if (input === '/sair') break;
  if (input === '/reset') { await resetLead(leadId); await upsertLead(leadId, { phone: '5531999990000', pushName: 'Teste CLI' }); console.log('🧹 conversa zerada\n'); continue; }
  if (input === '/lead') { console.dir(await getLead(leadId), { depth: 5 }); continue; }

  await addMessage(leadId, 'user', input);
  const t = Date.now();
  const { replies, attachments, handoff, updates } = await runAgent(leadId);
  for (const r of replies) console.log(`\x1b[32mSofia:\x1b[0m ${r}\n`);
  for (const a of attachments) console.log(`\x1b[33m📎 [${a.kind}] ${a.fileName || a.caption?.replace(/\n/g, ' | ') || ''} ${a.path || ''}\x1b[0m\n`);
  if (handoff) console.log(`\x1b[35m--- notificação p/ consultor ---\n${formatHandoff(handoff)}\n-------------------------------\x1b[0m\n`);
  for (const u of updates) console.log(`\x1b[35m${u}\x1b[0m\n`);
  const l = await getLead(leadId);
  console.log(`\x1b[90m(${((Date.now() - t) / 1000).toFixed(1)}s · score ${l.score} ${l.temperature} · ${l.stage})\x1b[0m\n`);
}
rl.close();
