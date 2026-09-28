# Somapel SDR — Agente de pré-vendas no WhatsApp

Agente de IA (OpenAI) que atende quem chama a Somapel no WhatsApp: entende a necessidade, orienta
tecnicamente, qualifica e ranqueia o lead e passa para a vendedora no momento certo, com um resumo pronto.

**Fase atual:** recebimento (inbound) pela **WhatsApp Cloud API** (oficial da Meta).
A estrutura já prevê o disparo para a lista fria (`origin = outbound`).

## Como funciona

```
WhatsApp Cloud API (webhook) ─┐
                              ├─► buffer 8s ─► Agente (OpenAI + base de conhecimento + ferramentas) ─► respostas em balões
Baileys / WhatsApp Web ───────┘                        │
  (canal alternativo)                                  ├─ registrar_qualificacao → SQLite + score 0–100 (quente/morno/frio)
                                                       ├─ encaminhar_para_consultor → nome, telefone e resumo para a vendedora
                                                       ├─ enviar_catalogo → PDF oficial
                                                       └─ enviar_foto_produto → fotos oficiais do produto em conversa
```

- **Base de conhecimento** (`knowledge/`): extraída do site somapel.com.br (44 produtos com fichas técnicas,
  páginas institucionais) e do catálogo PDF, mais um guia consultivo de diagnóstico por linha de produto.
  **Edite `knowledge/04-produtos-foco.md`** com as informações internas (produtos em foco, pedido mínimo,
  regiões de entrega). Não precisa mexer em código — basta reiniciar.
- **Fluxo curto:** a meta é encaminhar o lead em 3 a 4 mensagens. O SDR coleta só os essenciais
  (necessidade, nome, empresa, cidade, volume) — a lista fica na constante `ESSENCIAIS` em `src/prompt.js`.
- **Fotos:** 45 fotos oficiais em `assets/produtos/` (JPEG, prontas para WhatsApp), indexadas em
  `knowledge/produtos-site.json`. O agente envia a do produto que está sendo conversado (até 3 num kit).
  Itens que só existem no catálogo PDF não têm foto — o agente avisa e oferece o catálogo.
- **Vendedora:** quando o lead aquece (score ≥ `HANDOFF_SCORE`, padrão 60) ou pede orçamento, a vendedora
  (`SELLER_NAME` / `SELLER_WHATSAPP`) recebe nome, telefone, resumo, produto, volume e link para chamar.
  Dados que chegam depois (CNPJ, e-mail) vão como atualização.
- **Áudio** é transcrito automaticamente; **imagens** enviadas pelo cliente são analisadas.
- **Humano assume:** se alguém do time responder manualmente no chat, o bot pausa ali (padrão 3h).
  No chat, `#bot` retoma e `#pausar` pausa de vez.
- **Score** (`src/scoring.js`): fit (PJ, segmento, região MG, decisor, recorrência) + intenção
  (produto, volume, prazo, pediu orçamento). Regras ajustáveis.
- **Trava de segurança:** com `ALLOWED_NUMBERS` preenchido, o agente só responde esses números.
  Para produção, `REPLY_TO_ALL=true`.

## Rodando

Requisitos: Node 22+. Copie `.env.example` para `.env` e preencha.

```bash
npm install
npm run chat       # conversa de teste no terminal (sem WhatsApp)
npm run simular    # cenários prontos (troca aço→PET, frigorífico, máquina parada, pedido de foto...)
npm run leads      # leads ranqueados · npm run leads -- --csv > leads.csv
```

### Canal oficial — WhatsApp Cloud API
```bash
npm start          # sobe o webhook na porta WEBHOOK_PORT (padrão 8080)
```
No painel da Meta (app → **WhatsApp → Configuration → Webhook**):
1. **Callback URL:** `https://SEU-DOMINIO/webhook` (em teste local: `ngrok http 8080`).
2. **Verify token:** o valor de `WHATSAPP_VERIFY_TOKEN`.
3. Em **Manage**, marque o campo **messages** — sem isso a URL é verificada mas nenhuma mensagem chega.

O token do painel (`WHATSAPP_TOKEN`) expira junto com a sessão do Facebook. Para produção, gere um token de
**usuário do sistema** (Business Settings → Usuários do sistema), com `whatsapp_business_messaging` e
`whatsapp_business_management`, sem expiração.

**Templates:** dentro da janela de 24h aberta pelo cliente, o agente responde texto livre (sem template).
Mensagens iniciadas pela empresa — aviso de lead para a vendedora, follow-up depois de 24h e disparo para
lista fria — exigem template aprovado na Meta.

### Canal alternativo — WhatsApp Web (Baileys)
```bash
npm run baileys    # mostra o QR no terminal e em data/qr.html
```
Útil para validar sem conta oficial. Não tem limite de janela de 24h, mas é conexão não oficial
(maior risco de bloqueio) — não use para disparo em massa.

## Estrutura
```
knowledge/          base de conhecimento (markdown) + índice de fotos
assets/             catálogo PDF e fotos dos produtos
src/cloud-api.js    canal oficial (webhook + Graph API)
src/index.js        canal alternativo (Baileys)
src/conversation.js núcleo de atendimento comum aos dois canais
src/agent.js        loop do agente, ferramentas e card da vendedora
src/prompt.js       persona, fluxo de atendimento e regras
src/scoring.js      ranqueamento dos leads
src/db.js           SQLite (leads e mensagens) em data/somapel.db
scripts/run-bot.sh  mantém o processo rodando (reinicia se cair)
```
