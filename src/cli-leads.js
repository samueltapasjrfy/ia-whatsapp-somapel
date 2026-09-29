// Lista os leads ranqueados por score. Uso: npm run leads  ·  npm run leads -- --csv > leads.csv
import { listLeads } from './db.js';

const leads = await listLeads().filter((l) => !l.id.startsWith('sim:'));
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');

if (process.argv.includes('--csv')) {
  const cols = ['score', 'temperature', 'stage', 'phone', 'nome', 'empresa', 'cidade_uf', 'segmento', 'produtos', 'volume', 'prazo', 'resumo', 'atualizado'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  console.log(cols.join(';'));
  for (const l of leads) {
    const d = l.data;
    console.log([l.score, l.temperature, l.stage, l.phone, d.nome || l.push_name, d.empresa, d.cidade_uf, d.segmento,
      (d.produtos_interesse || []).join(', '), d.volume, d.prazo, l.summary, fmt(l.updated_at)].map(esc).join(';'));
  }
} else {
  const icon = { quente: '🔥', morno: '🟡', frio: '🔵' };
  console.table(leads.map((l) => ({
    '': icon[l.temperature],
    score: l.score,
    estágio: l.stage,
    telefone: l.phone,
    nome: l.data.nome || l.push_name,
    empresa: l.data.empresa || '',
    cidade: l.data.cidade_uf || '',
    interesse: (l.data.produtos_interesse || []).join(', ').slice(0, 40),
    atualizado: fmt(l.updated_at),
  })));
}
