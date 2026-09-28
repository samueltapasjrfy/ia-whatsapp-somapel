# Instalação e operação

Guia para subir o agente numa máquina nova (servidor ou outro computador).

## 1. Requisitos
- **Node 22+** (usa `node:sqlite` e `--env-file`, nativos a partir do 22). `node -v` para conferir.
- Porta HTTP livre para o webhook (padrão 8080).
- Uma URL pública **HTTPS** — a Meta não aceita HTTP nem IP puro.

## 2. Clonar e instalar
```bash
git clone git@github.com:samueltapasjrfy/ia-whatsapp-somapel.git
cd ia-whatsapp-somapel
npm install
cp .env.example .env    # depois preencha o .env (passo 3)
```

## 3. Variáveis de ambiente (`.env`)

| Variável | O que é | Obrigatória |
|---|---|---|
| `OPENAI_API_KEY` | chave da OpenAI | sim |
| `OPENAI_MODEL` | padrão `gpt-5.4-mini` (testado: melhor equilíbrio qualidade/latência) | não |
| `OPENAI_REASONING_EFFORT` | `medium` (padrão). `low` deixa mais rápido e mais raso | não |
| `WHATSAPP_TOKEN` | token da Meta — use o de **usuário do sistema** (não expira) | sim |
| `WHATSAPP_NUMBER_ID` | phone number id do painel da Meta | sim |
| `WHATSAPP_BUSINESS_ID` | id da conta do WhatsApp Business (WABA) | sim |
| `WHATSAPP_PHONE` | número oficial, só dígitos (ex.: `553133485000`) | sim |
| `WHATSAPP_VERIFY_TOKEN` | string que você inventa e repete no painel da Meta | sim |
| `WHATSAPP_APP_SECRET` | App Secret do app. Se preenchido, valida a assinatura dos webhooks | recomendada |
| `WHATSAPP_API_VERSION` | versão da Graph API (padrão `v23.0`) | não |
| `WEBHOOK_PORT` | porta do servidor (padrão `8080`) | não |
| `AGENT_NAME` | nome da atendente (padrão `Sofia`) | não |
| `SELLER_NAME` / `SELLER_WHATSAPP` | vendedora que recebe o lead aquecido | sim |
| `HANDOFF_SCORE` | score a partir do qual o lead é considerado aquecido (padrão 60) | não |
| `ALLOWED_NUMBERS` | **trava de teste**: só responde esses números (DDI+DDD+número, separados por vírgula) | ver abaixo |
| `REPLY_TO_ALL` | `true` libera o atendimento para qualquer número — use em produção | ver abaixo |
| `BUFFER_SECONDS` | segundos esperando o lead terminar de digitar (padrão 8) | não |
| `HUMAN_PAUSE_MINUTES` | quanto tempo o bot fica pausado num chat depois que um humano responde (padrão 180) | não |
| `DB_PATH` | caminho do SQLite (padrão `data/somapel.db`) | não |

> ⚠️ Em produção, deixe `REPLY_TO_ALL=true` e `ALLOWED_NUMBERS` vazio. Enquanto `ALLOWED_NUMBERS`
> estiver preenchido, **todos os outros clientes são ignorados em silêncio**.

## 4. Token da Meta que não expira
O token do painel do app morre junto com a sessão do Facebook (algumas horas). Para produção:
1. business.facebook.com/settings → **Usuários → Usuários do sistema → Adicionar** (papel **Funcionário**;
   só é permitido um único usuário do sistema Admin por negócio).
2. **Adicionar ativos** → o **app** e a **conta do WhatsApp**, ambos com **Controle total**.
3. Clique no usuário criado → **Gerar novo token** → app → validade **Nunca** →
   permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
4. Copie na hora (só aparece uma vez) e coloque em `WHATSAPP_TOKEN`.

Conferir se está válido e sem expiração:
```bash
node --env-file=.env --input-type=module -e '
const t=process.env.WHATSAPP_TOKEN;
const d=await (await fetch(`https://graph.facebook.com/v23.0/debug_token?input_token=${t}&access_token=${t}`)).json();
console.log(d.data?.expires_at === 0 ? "não expira ✅" : d.data);'
```

## 5. Subir o serviço
```bash
npm start            # canal oficial (Cloud API) — sobe o webhook
npm run baileys      # canal alternativo via WhatsApp Web (QR no terminal e em data/qr.html)
```
Para manter rodando, use um gerenciador de processos (o `scripts/run-bot.sh` incluso só reinicia o Baileys):
```bash
npm i -g pm2
pm2 start "npm start" --name somapel-sdr
pm2 save && pm2 startup     # sobe junto com a máquina
pm2 logs somapel-sdr
```

## 6. Webhook na Meta
1. Exponha a porta por HTTPS: domínio com Nginx/Caddy + TLS, ou `ngrok http 8080` para teste
   (a URL gratuita do ngrok muda a cada reinício e obriga a reconfigurar o webhook).
2. Painel da Meta → app → **WhatsApp → Configuration → Webhook → Editar**:
   - **Callback URL:** `https://SEU-DOMINIO/webhook`
   - **Verify token:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
3. Em **Webhook fields → Manage**, marque **messages**.
   Sem isso a URL é verificada, mas **nenhuma mensagem chega** (foi o erro que travou o primeiro teste).

Endpoints do serviço:
- `GET /webhook` — verificação da Meta
- `POST /webhook` — recebe as mensagens
- `GET /status` — healthcheck (`{"ok":true,...}`), útil para monitoramento

## 7. Testes sem WhatsApp
```bash
npm run chat       # conversa livre no terminal (/reset /lead /sair)
npm run simular    # cenários prontos; `npm run simular direto` roda um só
npm run leads      # leads ranqueados · npm run leads -- --csv > leads.csv
```

## 8. Backup
Tudo que importa em runtime está em `data/` (fora do Git): `somapel.db` (leads e conversas),
`wa-auth/` (sessão do Baileys) e os logs. Faça backup do `.db`.

## 9. Problemas comuns
| Sintoma | Causa provável |
|---|---|
| Webhook verifica, mas nenhuma mensagem chega | campo **messages** não assinado no painel |
| `TOKEN DO WHATSAPP EXPIRADO/INVÁLIDO` no log | token temporário venceu → gerar o permanente |
| Erro 131047 ao enviar | janela de 24h fechada → precisa de template aprovado |
| Cliente manda e o log diz `🙈 ignorando` | número fora de `ALLOWED_NUMBERS` |
| Bot não responde num chat | humano respondeu ali; pausa de `HUMAN_PAUSE_MINUTES` (mande `#bot` no chat) |
