# GTM Planner

*Developed by [Carlos Eduardo Vieira Figueiredo](https://www.linkedin.com/in/carloseduardovf/)*

Gerador genérico de Territory Plan / Account Plan B2B com metodologia GTM enterprise (tiering, stakeholder map EB/TB/UB, MEDDIC, framework 4C), pesquisa web ao vivo e IA (Claude). Configure a SUA empresa vendedora (nome, oferta, concorrentes, personas) e gere planos para qualquer conta-alvo. Inclui preset Wise de um clique e tema light/dark. Portfólio: Cadu (Carlos Eduardo Vieira Figueiredo).

## Estrutura

- `src/App.jsx` — aplicação React completa (formulário, pipeline de geração, plano em 9 seções, modo demo)
- `api/generate.js` — função serverless que protege a chave da API (a chave NUNCA vai ao navegador)
- `index.html`, `vite.config.js`, `package.json` — base Vite + React

## Publicar na internet (Vercel + GitHub) — 15 minutos

### 1. Suba o código no GitHub
Opção simples, sem linha de comando:
1. Acesse github.com → botão **New repository** → nome `gtm-account-planner` → **Create repository**
2. Na página do repositório, clique em **uploading an existing file**
3. Arraste TODOS os arquivos e pastas deste projeto (incluindo as pastas `src` e `api`)
4. Clique em **Commit changes**

### 2. Crie a chave da API
1. Acesse console.anthropic.com → **API Keys** → **Create Key**
2. Copie a chave (começa com `sk-ant-...`). Guarde em local seguro. É pré-paga: adicione um crédito pequeno (US$ 5 dura muito; cada plano completo custa centavos).

### 3. Publique na Vercel
1. Acesse vercel.com → **Add New → Project**
2. Selecione o repositório `gtm-account-planner` (conecte o GitHub se pedir)
3. Antes de clicar em Deploy, abra **Environment Variables** e adicione:
   - Name: `ANTHROPIC_API_KEY`
   - Value: a chave `sk-ant-...`
4. Clique em **Deploy**
5. Pronto: a Vercel entrega uma URL pública tipo `https://gtm-account-planner.vercel.app`

### 4. Rodar no seu computador (opcional)
Requisitos: Node.js instalado (nodejs.org, versão LTS).

```bash
npm install
npm install -g vercel
vercel dev
```

`vercel dev` roda o site E a função `/api/generate` localmente. Na primeira vez ele pede login e pergunta o projeto; aceite os padrões. Crie um arquivo `.env` na raiz com:

```
ANTHROPIC_API_KEY=sk-ant-sua-chave
```

Depois abra http://localhost:3000

> Atenção: `npm run dev` sozinho roda só o site, sem a API (a geração falha). Use `vercel dev`.

## Segurança
- A chave fica somente na variável de ambiente da Vercel (ou no `.env` local, que está no `.gitignore`)
- Nunca faça commit de `.env`
- Se a chave vazar, revogue em console.anthropic.com e crie outra

## Confiabilidade das respostas
- `max_tokens` de 2.500-4.000 por chamada no servidor (sem o teto que truncava JSON)
- Pipeline em 9 subchamadas curtas com retry e backoff (429/529 aguardam mais)
- Reparador de JSON truncado como última linha de defesa
- Regeneração parcial: refaz apenas seções que falharam
- Modo demo (Infracommerce) renderiza sem nenhuma chamada de API

## Como usar
1. Painel "1 · Sua empresa (vendedora)": preencha nome, oferta/diferenciais, concorrentes e personas (fica salvo no navegador), ou clique em "Preencher com preset Wise"
2. Painel "2 · Conta-alvo": informe a empresa que você quer conquistar e clique em Gerar
3. O plano sai em 9 seções com links reais de LinkedIn por stakeholder e exportação para impressão/PDF

## Evolução sugerida (roadmap)
- Múltiplos presets de vendedora salvos
- Salvar histórico de planos gerados (localStorage ou banco)
- Exportar PDF nativo
