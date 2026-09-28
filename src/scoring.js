// Score determinístico (0–100) a partir dos campos que o agente coleta.
// Fit = quem é o lead · Intenção = quão perto de comprar está.
// Mantido em código (e não "no feeling" do LLM) para ser explicável e ajustável pelo time.

const INDUSTRIAL = /ind[uú]str|log[ií]st|transport|distribu|atacad|metal|sider|madeir|autope|automot|aliment|bebida|frigor|qu[ií]mic|farm|e-?commerce|gr[aá]fic|t[eê]xtil|confec|constru|agro|movel|m[oó]ve|eletr/i;
const MG = /\b(mg|minas|bh|belo horizonte|contagem|betim|nova lima|sabar[aá]|santa luzia|ribeir[aã]o das neves|vespasiano|lagoa santa|ibirit[eé]|sete lagoas|divin[oó]polis|ipatinga|juiz de fora|uberl[aâ]ndia|montes claros|itabira|ouro preto|pedro leopoldo|igarap[eé])\b/i;

export function scoreLead(d = {}) {
  const reasons = [];
  let fit = 0;
  let intent = 0;
  const add = (bucket, pts, why) => {
    if (bucket === 'fit') fit += pts; else intent += pts;
    reasons.push(`+${pts} ${why}`);
  };

  if (d.tipo_cliente === 'empresa' || d.cnpj) add('fit', 12, 'empresa (PJ)');
  if (d.empresa) add('fit', 3, 'empresa identificada');
  if (d.segmento && INDUSTRIAL.test(d.segmento)) add('fit', 10, 'segmento aderente');
  else if (d.segmento) add('fit', 4, 'segmento informado');
  if (d.cidade_uf && MG.test(d.cidade_uf)) add('fit', 8, 'região MG/BH');
  else if (d.cidade_uf) add('fit', 3, 'localização informada');
  if (d.cargo_decisor === true) add('fit', 7, 'fala com decisor/comprador');
  if (d.compra_recorrente === true) add('fit', 10, 'consumo recorrente');

  if (d.produtos_interesse?.length) add('intent', 10, 'produto identificado');
  if (d.aplicacao) add('intent', 5, 'aplicação entendida');
  if (d.volume) add('intent', 10, 'volume/quantidade informado');
  if (d.prazo === 'imediato') add('intent', 15, 'prazo imediato');
  else if (d.prazo === 'ate_30_dias') add('intent', 10, 'prazo até 30 dias');
  else if (d.prazo === '1_a_3_meses') add('intent', 4, 'prazo 1–3 meses');
  if (d.pediu_orcamento || d.pediu_visita) add('intent', 10, 'pediu orçamento/visita');

  fit = Math.min(fit, 50);
  intent = Math.min(intent, 50);
  let score = fit + intent;
  if (d.tipo_cliente === 'pessoa_fisica' && !d.compra_recorrente) score = Math.min(score, 45);
  if (d.nao_e_lead) score = 0;

  const temperature = score >= 70 ? 'quente' : score >= 40 ? 'morno' : 'frio';
  return { score, fit, intent, temperature, reasons };
}
