# Arquitetura e pontos de integração

Para quem vai dar continuidade ou plugar o agente em outro sistema (CRM, ERP, painel).

## Fluxo de uma mensagem

```
Cliente no WhatsApp
      │
      ▼
src/cloud-api.js  (webhook da Meta)          src/index.js (Baileys, canal alternativo)
      │  normaliza: texto, áudio→transcrição, imagem→base64
      ▼
src/conversation.js  ── buffer de 8s (junta mensagens picadas)
      │                 pausa se um humano assumiu o chat
      ▼
src/agent.js  ── monta o prompt (src/prompt.js + knowledge/) e chama a OpenAI (Responses API)
      │          executa as ferramentas que o modelo pedir
      ▼
resposta em 1–3 balões  +  anexos (foto do produto / catálogo)  +  card para a vendedora
```

## Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/cloud-api.js` | canal oficial: webhook + envio pela Graph API, upload/download de mídia |
| `src/index.js` | canal alternativo (Baileys / WhatsApp Web), com QR |
| `src/conversation.js` | núcleo comum: buffer, "digitando", pausa por humano, notificação da vendedora |
| `src/agent.js` | loop do agente, definição das ferramentas, card do lead, transcrição de áudio |
| `src/prompt.js` | persona, fluxo de atendimento, regras e a lista `ESSENCIAIS` |
| `src/scoring.js` | score 0–100 (fit + intenção) e temperatura (frio/morno/quente) |
| `src/db.js` | SQLite: leads e mensagens |
| `src/config.js` | env + helpers de telefone brasileiro (`normalizeBR`, `brVariants`, `formatBR`) |
| `knowledge/*.md` | base de conhecimento (entra inteira no prompt) |
| `knowledge/produtos-site.json` | índice nome → URL → fotos em `assets/produtos/` |

## Banco (SQLite, `data/somapel.db`)

**leads** — `id` (`wa:<telefone>` na Cloud API), `phone`, `push_name`, `origin` (`inbound`/`outbound`),
`stage` (`novo`, `em_qualificacao`, `qualificado`, `encaminhado`, `nutrir`, `desqualificado`),
`score`, `temperature`, `data` (JSON da qualificação), `summary`, `paused_until`, `handed_off_at`,
`created_at`, `updated_at`.

**messages** — `lead_id`, `role` (`user`, `assistant`, `human`, `system`), `content`, `created_at`.

O JSON de `data` traz: `nome, empresa, cnpj, email, cargo, cargo_decisor, tipo_cliente, segmento,
cidade_uf, necessidade, aplicacao, produto_recomendado, produtos_interesse[], solucao_atual, volume,
compra_recorrente, prazo, pediu_orcamento, pediu_visita, ja_e_cliente, nao_e_lead, objecoes`.

## Onde plugar outro sistema

1. **Receber o lead qualificado (o gancho mais direto).**
   Em `src/conversation.js`, a função `notifySellers(texto, lead)` roda quando o agente encaminha.
   É o ponto para um `fetch(CRM_URL, {method:'POST', body: JSON.stringify(lead)})` — o objeto `lead`
   já tem telefone, score, resumo e o JSON de qualificação.

2. **Ler os leads de fora.** O SQLite pode ser lido direto, ou use `listLeads()` de `src/db.js`.
   `npm run leads -- --csv` exporta tudo. Para uma API HTTP, o servidor em `src/cloud-api.js`
   já está de pé: basta acrescentar uma rota ao lado de `/status`.

3. **Outro canal (site, Instagram, Telegram).** Implemente um objeto `channel` com
   `sendText`, `sendImage`, `sendDocument` (e, opcionais, `sendContact`, `markRead`, `typing`,
   `sellerTarget`) e passe para `createConversation(channel)`. Todo o comportamento vem junto.
   `src/cloud-api.js` é o exemplo mais completo.

4. **Novas capacidades do agente.** Ferramentas ficam em `src/agent.js` (array `chatTools` +
   `handleTool`). Ex.: consultar estoque no ERP, agendar visita, gerar orçamento.
   Descreva a ferramenta em português — o modelo decide quando usar.

5. **Conteúdo e tom.** Regras de atendimento em `src/prompt.js`; catálogo e argumentos em `knowledge/`.
   Alterar esses arquivos não exige mexer em código — só reiniciar o processo.

## Regras da Meta que afetam o design

- **Janela de 24h:** depois que o cliente escreve, a empresa responde texto livre por 24h
  (conversa de atendimento, sem custo). É o caso do fluxo inbound atual.
- **Fora da janela** (empresa iniciando a conversa) só com **template aprovado**. Afeta:
  - o card de lead enviado para a vendedora (se ela não escreveu para o número nas últimas 24h);
  - follow-up de lead que sumiu;
  - disparo para lista fria (categoria MARKETING, exige opt-in e opt-out).
- Templates já aprovados na conta: `somapel_apresentacao_{tulio_v7,adiel_v5,michele_v2}` (MARKETING),
  usados por outro sistema conectado à mesma WABA.

## Estado atual e próximos passos

**Funcionando e testado em produção real:** recebimento pela Cloud API, atendimento consultivo,
envio de fotos do produto em conversa, catálogo em PDF, transcrição de áudio, leitura de imagem,
score, encaminhamento para a vendedora com resumo, pausa quando um humano assume.

**Pendente:**
1. Criar os templates utility `sdr_novo_lead` (aviso para a vendedora) e `sdr_retomada_orcamento`
   (follow-up), com fallback no código: texto livre dentro da janela, template fora dela.
2. Frente de disparo (lista fria): seleção do público, template de marketing, controle de opt-out
   e registro com `origin = 'outbound'`.
3. Ajuste fino do prompt: a pergunta técnica às vezes sai truncada ("Vocês usam como hoje?").
4. Painel de leads (hoje só CLI/CSV).
5. Revisar a lista `ESSENCIAIS` em `src/prompt.js` com o time comercial.
