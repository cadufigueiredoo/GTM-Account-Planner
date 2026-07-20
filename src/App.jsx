import { useState, useEffect, useRef } from "react";

// ============================================================
// Wise Account Planner — app standalone (Vercel + serverless)
// ============================================================

// ---------- Temas (light / dark) ----------
// Sistema visual iOS (Human Interface Guidelines) com o verde Wise como acento de marca
const THEMES = {
  light: {
    paper: "#F2F2F7",
    card: "#FFFFFF",
    ink: "#0A0A0A",
    mist: "#E5E5EA",
    gray: "#6E6E73",
    forest: "#163300",
    bright: "#9FE870",
    soft: "rgba(159,232,112,0.18)",
    tableHead: "#F5F5F7",
    headerBg: "rgba(242,242,247,0.78)",
    headerText: "#0A0A0A",
    zebra: "#FAFAFC",
    danger: "#FF3B30",
    field: "#EFEFF1",
    shadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)",
    segTrack: "rgba(118,118,128,0.12)",
    segActive: "#FFFFFF",
  },
  dark: {
    paper: "#000000",
    card: "#1C1C1E",
    ink: "#F5F5F7",
    mist: "#38383A",
    gray: "#98989F",
    forest: "#163300",
    bright: "#9FE870",
    soft: "rgba(159,232,112,0.16)",
    tableHead: "#2C2C2E",
    headerBg: "rgba(10,10,12,0.72)",
    headerText: "#F5F5F7",
    zebra: "#232325",
    danger: "#FF453A",
    field: "#2C2C2E",
    shadow: "none",
    segTrack: "rgba(118,118,128,0.24)",
    segActive: "#636366",
  },
};

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI Variable Display', 'Segoe UI', Inter, system-ui, sans-serif";
const display = { fontFamily: SYSTEM_FONT, letterSpacing: "-0.02em" };
const body = { fontFamily: SYSTEM_FONT };
// Etiquetas/eyebrows no estilo iOS (footnote caps), substituindo o mono anterior
const mono = { fontFamily: SYSTEM_FONT, fontWeight: 600, letterSpacing: "0.06em" };

// URL de busca de pessoas no LinkedIn por cargo/nome + empresa.
// Determinístico: nunca inventa perfis, leva à lista real de resultados.
function linkedinSearchUrl(quem, empresa) {
  const q = `${(quem || "").replace(/\(.*?\)/g, "").trim()} ${empresa || ""}`.trim();
  return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(q);
}

// ---------- API (via função serverless /api/generate) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callClaude(messages, tools, maxTokens, timeoutMs) {
  let msgs = [...messages];
  for (let hop = 0; hop < 4; hop++) {
    const payload = { messages: msgs, max_tokens: maxTokens || 2500 };
    if (tools) payload.tools = tools;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 65000);
    let res;
    try {
      res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("Tempo excedido na chamada; tentando novamente");
      throw e;
    }
    clearTimeout(timer);
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${raw.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error("Resposta não-JSON do servidor: " + raw.slice(0, 120));
    }
    if (data.stop_reason === "pause_turn") {
      msgs = [...msgs, { role: "assistant", content: data.content }];
      continue;
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text) throw new Error("Resposta sem texto: " + raw.slice(0, 120));
    return text;
  }
  throw new Error("Sem resposta final da API (pause_turn loop)");
}

async function withRetry(fn, attempts = 3) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      const rateLimited = e.status === 429 || e.status === 529;
      if (i < attempts - 1) await sleep((rateLimited ? 5000 : 1500) * (i + 1));
    }
  }
  throw err;
}

async function genText(promptText) {
  return withRetry(() => callClaude([{ role: "user", content: promptText }]), 3);
}

// ---------- Parse de JSON com reparo de truncamento ----------
function repairTruncated(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      candidates.push({ i, st: [...stack] });
    }
  }
  for (let k = candidates.length - 1; k >= 0 && k >= candidates.length - 10; k--) {
    const { i, st } = candidates[k];
    const closers = st
      .map((o) => (o === "{" ? "}" : "]"))
      .reverse()
      .join("");
    try {
      return JSON.parse(s.slice(0, i + 1) + closers);
    } catch (e) {}
  }
  throw new Error("JSON truncado irrecuperável");
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("Sem JSON na resposta");
  const bodyStr = clean.slice(start);
  const end = bodyStr.lastIndexOf("}");
  if (end !== -1) {
    try {
      return JSON.parse(bodyStr.slice(0, end + 1));
    } catch (e) {}
  }
  return repairTruncated(bodyStr);
}

async function genJSON(prompt) {
  const text = await genText(prompt + "\nIMPORTANTE: responda APENAS com JSON válido e completo, sem markdown, sem texto antes ou depois.");
  try {
    return parseJSON(text);
  } catch (e) {
    const retryText = await genText(prompt + "\nResponda SOMENTE o objeto JSON completo. Comece com { e termine com }.");
    return parseJSON(retryText);
  }
}

// ---------- Perfil da empresa vendedora (genérico) + metodologia GTM ----------
const WISE_PRESET = {
  nome: "Wise",
  descricao:
    "Conta multimoeda Wise Business (40+ moedas, dados bancários locais em USD/EUR/GBP); pagamentos internacionais na taxa média do mercado (mid-market rate) com tarifas transparentes; batch payments para fornecedores e contractors; cartões corporativos multimoeda; Wise Platform (APIs de infraestrutura de pagamentos). Resolve: spread cambial opaco, prazos SWIFT de 2-5 dias, custo de contas no exterior, conciliação manual, payouts para times globais.",
  concorrentes: "Bancos incumbentes (Itaú, Bradesco, Santander, BTG), corretoras de câmbio, Payoneer, Ebury, Nomad, Husky",
  personas: "CFO, Head de Tesouraria, Controller, Head de Operações Financeiras; em empresas menores, Founder ou COO",
};

const EMPTY_SELLER = { nome: "", descricao: "", concorrentes: "", personas: "" };

function buildSellerContext(s) {
  return `Você é um estrategista de Sales Enablement da empresa vendedora "${s.nome}", montando um Account Plan B2B com metodologia GTM enterprise para vender à empresa-alvo.
O que a vendedora "${s.nome}" oferece (produtos/serviços, diferenciais e dores que resolve): ${s.descricao}
${s.concorrentes ? `Concorrência típica nas contas: ${s.concorrentes}` : ""}
${s.personas ? `Personas-alvo típicas: ${s.personas}` : ""}

METODOLOGIA (siga rigorosamente):
- Tiering: VERY HIGH/HIGH = potencial de receita alto + dor clara + acesso executivo mapeável; a conta não precisa de todos os critérios, basta potencial alto + dor + acesso.
- Stakeholders: use a taxonomia Economic Buyer (aprova budget), Technical Buyer (avalia tecnicamente), User Buyer (usa no dia a dia), Champion Potencial (aliado interno) e Gatekeeper/Blocker. Multi-thread obrigatório: nunca dependa de um contato.
- Plays em sequência: entry point de menor fricção primeiro, depois oferta âncora (maior valor), depois visão de plataforma/expansão da relação.
- Business case: sempre outcomes, nunca features. Traduza cada capacidade em resultado mensurável no P&L ou na operação do cliente. Range conservador vs. otimista.
- Action plan em fases: dias 1-30 discovery e mapeamento; 31-60 qualificação e alinhamento com decisor; 61-90 proposta e avanço.
- Pitch no framework 4C: Contexto (iniciativa específica da empresa-alvo) → Conflito (problema estrutural com dado de mercado) → Capacidade (oferta ligada a outcome) → CTA (pedido pequeno, fácil de dizer sim).
- Discovery no MEDDIC: Metrics, Economic Buyer, Decision criteria/process, Identify pain, Champion.`;
}

// ---------- Etapas visuais ----------
const STAGES = [
  { id: "research", label: "Pesquisa da conta", sub: "Web search: footprint internacional, moedas, notícias" },
  { id: "contexto", label: "Contexto e stakeholders", sub: "Visão geral, iniciativas, mapa de poder" },
  { id: "gap", label: "Gap analysis e plays", sub: "Infra financeira atual vs. entrada Wise" },
  { id: "acao", label: "Plano de ação e riscos", sub: "90 dias, mitigação" },
  { id: "pitch", label: "Core pitch", sub: "Framework 4C, 15 minutos" },
  { id: "disc", label: "Discovery e objeções", sub: "MEDDIC e contornos" },
  { id: "analise", label: "Análise estratégica", sub: "SWOT, faturamento e recomendações" },
];

const SEGMENTOS = [
  "E-commerce / Marketplace",
  "SaaS / Tecnologia",
  "Importação / Exportação",
  "Logística",
  "Agência / Serviços profissionais",
  "Turismo / Viagens",
  "Educação internacional",
  "Indústria",
  "Outro",
];

// ---------- Plano de exemplo (renderiza sem API) ----------
const DEMO_FORM = { empresa: "Infracommerce", segmento: SEGMENTOS[0], porte: "Enterprise (500+ func.)", contexto: "Exemplo pré-carregado (modo demo)" };
const DEMO_PLAN = {
  tier: "HIGH",
  potencial: "US$ 8-15M/ano em volume de câmbio",
  visaoGeral:
    "A Infracommerce é a maior plataforma de full commerce da América Latina, operando a cadeia completa de e-commerce (plataforma, logística, pagamentos e atendimento) para grandes marcas. Tem operações no Brasil, México, Chile, Colômbia, Argentina e Peru, o que gera fluxo constante de recebíveis e pagamentos em múltiplas moedas. A operação multi-país cria complexidade cambial e de tesouraria que cresce a cada nova geografia.",
  iniciativas: [
    "Consolidação das operações LATAM após ciclo de aquisições regionais",
    "Pressão por eficiência de margem e redução de custos operacionais",
    "Expansão de serviços financeiros embarcados para as marcas clientes",
    "Padronização de sistemas de tesouraria e conciliação entre países",
  ],
  insight:
    "O entry point ideal é a tesouraria: pagamentos em lote a fornecedores e transferências entre entidades LATAM hoje passam por bancos com spread opaco e prazos SWIFT. Uma prova de valor com um único corredor (Brasil-México) demonstra economia mensurável em semanas.",
  stakeholders: [
    { nome: "CFO (a confirmar)", area: "Finanças", papel: "Economic Buyer", sentimento: "Desconhecido", proximoPasso: "Briefing executivo com business case de economia cambial" },
    { nome: "Head de Tesouraria", area: "Tesouraria", papel: "Technical Buyer", sentimento: "Desconhecido", proximoPasso: "Discovery sobre corredores e volumes por moeda" },
    { nome: "Controller LATAM", area: "Controladoria", papel: "User Buyer", sentimento: "Desconhecido", proximoPasso: "Mapear dor de conciliação multi-país" },
    { nome: "Head de Ops Financeiras", area: "Operações", papel: "Champion Potencial", sentimento: "Desconhecido", proximoPasso: "Abordagem BDR inicial via LinkedIn" },
  ],
  gaps: [
    { categoria: "Câmbio e remessas", atual: "Bancos incumbentes + corretoras por país", maturidade: "2/5", gapWise: "Mid-market rate com tarifa transparente; economia típica de 1-3% por operação, mensurável no P&L" },
    { categoria: "Contas no exterior", atual: "Contas bancárias locais em cada país, custo fixo alto", maturidade: "3/5", gapWise: "Conta multimoeda com dados bancários locais em USD/EUR/GBP e saldos em 40+ moedas" },
    { categoria: "Payouts a fornecedores", atual: "SWIFT manual, 2-5 dias, conciliação em planilha", maturidade: "2/5", gapWise: "Batch payments com rastreio e conciliação via API; horas de tesouraria recuperadas" },
    { categoria: "Infra / API", atual: "Sem integração câmbio-ERP; processos manuais", maturidade: "1/5", gapWise: "Wise Platform para embutir pagamentos internacionais no fluxo financeiro e no produto" },
  ],
  plays: [
    { titulo: "Batch payments para fornecedores internacionais", produtos: "Wise Business + Batch", potencial: "Economia estimada de US$ 150-400K/ano", descricao: "Migrar pagamentos recorrentes a fornecedores e parceiros no exterior para lotes com câmbio na taxa média. Prova de valor com um corredor em 30 dias.", esforco: "Baixo", impacto: "Alto", trigger: "Quanto sua tesouraria paga hoje de spread nos pagamentos Brasil-México? A maioria não sabe, porque o custo está embutido na taxa." },
    { titulo: "Consolidação de recebíveis LATAM", produtos: "Conta multimoeda", potencial: "Redução de custo fixo bancário multi-país", descricao: "Centralizar recebíveis de MXN, CLP, COP e ARS em uma conta multimoeda, convertendo no momento ótimo em vez de conversões forçadas por país.", esforco: "Médio", impacto: "Alto", trigger: "Aquisições regionais deixaram um banco diferente em cada país? Esse é o padrão que mais gera custo invisível de tesouraria." },
    { titulo: "Serviços financeiros embarcados para marcas", produtos: "Wise Platform (API)", potencial: "Nova linha de receita B2B2C", descricao: "Embutir pagamentos internacionais na oferta de full commerce, permitindo que marcas clientes vendam e liquidem cross-border sem montar infraestrutura própria.", esforco: "Alto", impacto: "Alto", trigger: "Suas marcas clientes pedem expansão internacional? A infraestrutura de liquidação pode ser um diferencial da sua plataforma, não um custo delas." },
  ],
  acoes: [
    { quando: "S1-S2", acao: "Mapear stakeholders de tesouraria e ops financeiras no LinkedIn", objetivo: "Identificar campeão potencial" },
    { quando: "S2", acao: "Outbound personalizado com insight de custo cambial LATAM", objetivo: "Gerar primeira resposta" },
    { quando: "S3-S4", acao: "Cold call + follow-up com case de e-commerce multi-país", objetivo: "Qualificar corredores e volumes" },
    { quando: "M2", acao: "Discovery de 30 min com tesouraria; briefing executivo com CFO", objetivo: "Mapear volumes reais por moeda" },
    { quando: "M3", acao: "Proposta com prova de valor: um corredor, economia medida", objetivo: "Avançar para piloto" },
  ],
  riscos: [
    { risco: "Relacionamento bancário consolidado (crédito atrelado)", prob: "Alta", impacto: "Alto", mitigacao: "Posicionar como complemento para pagamentos, não substituição do banco de crédito" },
    { risco: "Compliance/tesouraria conservadora", prob: "Média", impacto: "Médio", mitigacao: "Licenças e trilha de auditoria da Wise; piloto de baixo volume" },
    { risco: "Concorrência já na conta (Payoneer/Ebury)", prob: "Média", impacto: "Médio", mitigacao: "Comparativo de custo total real em corredor específico" },
    { risco: "Ciclo de decisão longo (enterprise)", prob: "Alta", impacto: "Médio", mitigacao: "Entry point de baixo atrito com economia mensurável em 30 dias" },
  ],
  pitch: {
    abertura: "Empresas de e-commerce operando em 4+ países da América Latina gastam em média 1,5% a 3% do volume internacional em spread cambial embutido, um custo que raramente aparece em relatório porque está dentro da taxa.",
    problema: "A operação multi-país da Infracommerce herda um banco e um processo diferente por geografia. O resultado é spread opaco, prazos SWIFT e conciliação manual que cresce a cada aquisição.",
    solucao: "A Wise Business centraliza recebíveis em uma conta multimoeda, executa pagamentos em lote na taxa média do mercado com tarifa transparente, e a Wise Platform permite até embutir isso na oferta às marcas clientes. Um corredor piloto demonstra a economia em 30 dias.",
    cta: "Faz sentido eu mostrar em 15 minutos quanto um único corredor, Brasil-México por exemplo, custa hoje versus na Wise?",
  },
  descoberta: [
    "[Metrics] Quais corredores concentram seu volume internacional hoje (ex.: BRL-MXN, BRL-USD), qual o volume mensal de cada um, e como vocês medem o custo efetivo de câmbio versus a taxa média do mercado?",
    "[Economic Buyer] Além de você, quem mais seria envolvido numa decisão sobre infraestrutura de pagamentos internacionais? Como o CFO enxerga esse tema hoje?",
    "[Decision] Se vocês avaliassem um provedor de pagamentos internacionais, quais seriam os 3 critérios mais importantes, e como funciona o processo de aprovação de um projeto desse nível?",
    "[Pain] Quanto tempo leva, na prática, um pagamento internacional do pedido à confirmação do beneficiário? E quantas pessoas e planilhas tocam esse processo depois das aquisições regionais?",
    "[Champion] Tem alguém na tesouraria ou em ops financeiras que já mapeou esse custo e está buscando ativamente uma alternativa?",
  ],
  objecoes: [
    { objecao: "Já temos relacionamento bancário forte e linhas de crédito atreladas.", resposta: "Perfeito, e não precisa mudar. A Wise entra como camada de pagamentos, não de crédito. Vocês mantêm o banco para funding e migram só o fluxo transacional onde o spread dói. Muitos clientes começam com um único corredor." },
    { objecao: "Fintech para volumes enterprise? Preciso de segurança e compliance.", resposta: "Justo. A Wise é listada em bolsa (LSE), regulada em cada mercado onde opera, com licenças locais e trilha de auditoria completa por transação. Posso trazer nosso time de compliance para uma sessão técnica com o seu." },
    { objecao: "Já usamos Payoneer para parte dos payouts.", resposta: "Ótimo sinal: vocês já validaram que banco não é a única via. A conversa então vira comparação objetiva: custo total num corredor real, taxa de conversão aplicada e cobertura de moedas. Topa rodar esse comparativo com uma amostra de 10 pagamentos?" },
  ],
  fitScore: 82,
  fitRazoes: [
    "Dor de tesouraria multi-país casa diretamente com a oferta core",
    "Volume internacional estimado de US$ 8-15M/ano sustenta tier HIGH",
    "Reestruturação recente cria janela de revisão de fornecedores",
  ],
  sinais: [
    { sinal: "Consolidação pós-aquisições em 6 países", tipo: "Reestruturação", implicacao: "Revisão natural de bancos e processos herdados abre espaço para consolidar pagamentos." },
    { sinal: "Pressão pública por eficiência de margem", tipo: "Financeiro", implicacao: "Custo cambial invisível vira pauta executiva quando margem aperta." },
    { sinal: "Expansão de serviços financeiros para marcas", tipo: "Expansão", implicacao: "Wise Platform encaixa como infraestrutura da nova linha de receita." },
  ],
  matriz: [
    { persona: "CFO (a confirmar)", dor: "Margem pressionada e custo cambial invisível no P&L", mensagem: "Um corredor piloto quantifica em 30 dias quanto o spread está custando por ano.", canal: "Reunião executiva" },
    { persona: "Head de Tesouraria", dor: "Conciliação manual e prazos SWIFT em 6 países", mensagem: "Batch payments com trilha de auditoria eliminam a planilha de conciliação.", canal: "LinkedIn InMail" },
    { persona: "Controller LATAM", dor: "Fechamento multi-moeda lento e sujeito a erro", mensagem: "Extratos unificados por moeda reduzem o fechamento em dias.", canal: "E-mail" },
    { persona: "Head de Ops Financeiras", dor: "Processos de payout herdados diferentes por país", mensagem: "Um fluxo único de payout para os 6 países, com API no ERP.", canal: "Cold call" },
  ],
  swot: {
    forcas: ["Liderança em full commerce na América Latina", "Operação consolidada em 6 países", "Relacionamento profundo com grandes marcas"],
    fraquezas: ["Tesouraria fragmentada herdada de aquisições", "Conciliação manual multi-país", "Custo cambial invisível embutido nas taxas bancárias"],
    oportunidades: ["Corredor piloto Brasil-México com economia mensurável", "Consolidação de recebíveis LATAM em conta multimoeda", "Embedded finance como nova receita para marcas clientes"],
    ameacas: ["Relacionamento bancário atrelado a crédito", "Payoneer já presente em parte dos payouts", "Ciclo de decisão enterprise longo"],
  },
  faturamento: [
    { ano: "2023", valor: 3.1 },
    { ano: "2024", valor: 3.4 },
    { ano: "2025", valor: 3.8 },
  ],
  moeda: "R$ bi (exemplo ilustrativo)",
  confiabilidade: "estimado",
  sintese:
    "A Infracommerce combina os três critérios de conta prioritária: volume internacional relevante, dor estrutural de tesouraria herdada de aquisições, e um momento de pressão por margem que torna custo cambial invisível um tema executivo. O timing favorece a entrada agora, antes da renovação dos acordos bancários regionais.",
  recomendacoes: [
    { titulo: "Abrir pelo corredor Brasil-México", detalhe: "Entry point de menor fricção com economia mensurável em 30 dias; é a prova de valor que destrava o resto." },
    { titulo: "Multi-thread desde a semana 1", detalhe: "Tesouraria (Technical Buyer) e Ops Financeiras (Champion) em paralelo; o CFO entra via business case, não via cold call." },
    { titulo: "Neutralizar Payoneer com comparativo", detalhe: "Transformar a presença do concorrente em vantagem: propor comparação objetiva de custo total em 10 pagamentos reais." },
  ],
  proximoPasso: "Mapear os 4 stakeholders no LinkedIn e enviar o InMail de abertura com o insight do corredor Brasil-México ainda esta semana.",
};

// Cadência de prospecção Tier 1 (metodologia GTM adaptada para Wise) — estática
const CADENCIA_T1 = [
  { dia: "Dia 0", canal: "LinkedIn · Conexão", acao: "Solicitação de conexão sem mensagem. Deixe o perfil falar primeiro." },
  { dia: "Dia 2", canal: "LinkedIn · InMail", acao: "3 parágrafos: por que o contato, insight específico da dor que sua oferta resolve nesta conta, CTA de 15 min." },
  { dia: "Dia 5", canal: "E-mail · Conteúdo", acao: "Case de cliente do mesmo segmento. Não peça reunião: gere valor antes de vender." },
  { dia: "Dia 7", canal: "Cold call", acao: "Mencione o e-mail e o case. Valide se o tema ressoou e qualifique. 3-5 minutos." },
  { dia: "Dia 10", canal: "LinkedIn · Post", acao: "Comentário inteligente em publicação recente do stakeholder. Visibilidade sem abordagem." },
  { dia: "Dia 14", canal: "E-mail · Novo ângulo", acao: "Reabra com dado novo de mercado ou movimento de concorrente. CTA direto." },
  { dia: "Dia 21", canal: "Cold call · Break-up", acao: "'Quero respeitar seu tempo: faz sentido continuarmos?' Às vezes cria urgência." },
  { dia: "Dia 30", canal: "E-mail · Break-up", acao: "Feche o ciclo com elegância, porta aberta, conta em nurture." },
];

export default function App() {
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("wise-planner-theme") || "light";
    } catch (e) {
      return "light";
    }
  });
  const t = THEMES[mode];

  const [seller, setSeller] = useState(() => {
    try {
      const saved = localStorage.getItem("gtm-planner-seller");
      return saved ? JSON.parse(saved) : { ...EMPTY_SELLER };
    } catch (e) {
      return { ...EMPTY_SELLER };
    }
  });
  const [form, setForm] = useState({ empresa: "", segmento: SEGMENTOS[0], porte: "Mid-market (50 a 500 func.)", contexto: "" });
  const [status, setStatus] = useState({});
  const [plan, setPlan] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [debug, setDebug] = useState(null);
  const runRef = useRef({ brief: null, intel: "" });

  useEffect(() => {
    try {
      localStorage.setItem("wise-planner-theme", mode);
    } catch (e) {}
    document.body.style.background = t.paper;
  }, [mode, t.paper]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setS = (k, v) =>
    setSeller((s) => {
      const next = { ...s, [k]: v };
      try {
        localStorage.setItem("gtm-planner-seller", JSON.stringify(next));
      } catch (e) {}
      return next;
    });
  const applyWisePreset = () => {
    setSeller({ ...WISE_PRESET });
    try {
      localStorage.setItem("gtm-planner-seller", JSON.stringify(WISE_PRESET));
    } catch (e) {}
  };
  const sellerReady = seller.nome.trim() && seller.descricao.trim();

  async function generate() {
    setRunning(true);
    setError(null);
    setDebug(null);
    const brief = `Vendedora: ${seller.nome}. Empresa-alvo: ${form.empresa}. Segmento: ${form.segmento}. Porte: ${form.porte}. Contexto adicional do vendedor: ${form.contexto || "nenhum"}.`;

    const sameRun = runRef.current.brief === brief && plan;
    let currentPlan = sameRun ? { ...plan } : {};
    if (!sameRun) {
      setPlan({});
      setStatus({});
      runRef.current = { brief, intel: "" };
    }

    // 1. Pesquisa (com fallback para conhecimento geral)
    let intel = runRef.current.intel;
    if (!intel) {
      setStatus((s) => ({ ...s, research: "run" }));
      const researchPrompt = `Pesquise na web a empresa "${form.empresa}" (Brasil, segmento ${form.segmento}). Resuma em até 10 bullets curtos: o que faz, porte estimado, presença internacional (países, moedas prováveis), expansão ou notícias recentes, fornecedores/clientes no exterior, sinais de dores que a oferta da vendedora resolve, NOMES REAIS de executivos relevantes (C-level, diretores das áreas-alvo) se encontrados publicamente, FATURAMENTO ANUAL dos últimos 3 anos (busque em relatórios de RI, balanços e imprensa de negócios; liste ano a ano com os valores), e SINAIS DE COMPRA recentes: troca de executivos, captação de investimento, expansão, reestruturação, fusões, contratações em massa. Seja factual e conciso.`;
      try {
        intel = await withRetry(
          () => callClaude([{ role: "user", content: researchPrompt }], [{ type: "web_search_20250305", name: "web_search" }], 3000),
          2
        );
        setStatus((s) => ({ ...s, research: "done" }));
      } catch (e) {
        console.error("research", e);
        setDebug("Pesquisa web falhou (" + String(e.message).slice(0, 80) + "); usando conhecimento geral.");
        try {
          intel = await genText(
            `Com base em conhecimento geral (sem acesso à web), resuma a empresa "${form.empresa}" (Brasil, segmento ${form.segmento}) em até 10 bullets: o que faz, porte estimado, presença internacional provável, moedas envolvidas, e sinais prováveis das dores que a oferta da vendedora resolve. Sinalize estimativas como hipóteses.`
          );
          setStatus((s) => ({ ...s, research: "done" }));
        } catch (e2) {
          intel = "(Pesquisa indisponível. Use conhecimento geral e sinalize estimativas como hipóteses.)";
          setStatus((s) => ({ ...s, research: "err" }));
        }
      }
      runRef.current.intel = intel;
    }
    const base = `${buildSellerContext(seller)}\n\nBRIEF: ${brief}\n\nINTEL DA PESQUISA:\n${intel}`;

    // Subetapas mapeadas às etapas visuais
    const SUB = [
      {
        id: "contexto",
        ui: "contexto",
        done: () => currentPlan.visaoGeral,
        prompt: `${base}\n\nGere: {"visaoGeral":"3 frases","iniciativas":["4 iniciativas estratégicas prováveis"],"insight":"o entry point ideal da vendedora nesta conta, 1-2 frases","tier":"VERY HIGH | HIGH | MEDIUM","potencial":"receita/volume anual potencial para a vendedora, range conservador-otimista"}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "stak",
        ui: "contexto",
        done: () => currentPlan.stakeholders,
        prompt: `${base}\n\nGere: {"stakeholders":[{"nome":"NOME REAL se estiver no intel, senão cargo + (a identificar)","area":"","papel":"Economic Buyer | Technical Buyer | User Buyer | Champion Potencial | Gatekeeper","sentimento":"","proximoPasso":""}] com exatamente 4 itens, papéis diferentes (multi-thread). NUNCA invente nomes de pessoas.}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "gaps",
        ui: "gap",
        done: () => currentPlan.gaps,
        prompt: `${base}\n\nGere: {"gaps":[{"categoria":"categorias relevantes para a oferta da vendedora","atual":"solução atual estimada da empresa-alvo","maturidade":"1/5 a 5/5","gapWise":"produto/serviço da vendedora + outcome mensurável"}] com 4 linhas}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "plays",
        ui: "gap",
        done: () => currentPlan.plays,
        prompt: `${base}\n\nGere: {"plays":[{"titulo":"","produtos":"","potencial":"","descricao":"2 frases focadas em outcome","esforco":"Baixo | Médio | Alto","impacto":"Baixo | Médio | Alto","trigger":"gancho de conversa concreto, 1 frase"}] com exatamente 3 plays na sequência: 1º entry point de menor fricção, 2º oferta âncora de maior valor, 3º visão de plataforma/expansão da relação}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "acoes",
        ui: "acao",
        done: () => currentPlan.acoes,
        prompt: `${base}\n\nGere: {"acoes":[{"quando":"S1-S2 | S3-S4 | M2 | M3","acao":"","objetivo":""}] com 5 itens nas fases: 1-30 discovery e mapeamento, 31-60 qualificação com decisor, 61-90 proposta e avanço}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "riscos",
        ui: "acao",
        done: () => currentPlan.riscos,
        prompt: `${base}\n\nGere: {"riscos":[{"risco":"","prob":"Baixa | Média | Alta","impacto":"Baixo | Médio | Alto","mitigacao":""}] com 4 riscos incluindo concorrente entrincheirado e dependência de single-thread}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "pitch",
        ui: "pitch",
        done: () => currentPlan.pitch,
        prompt: `${base}\n\nGere o pitch 4C: {"abertura":"Contexto com iniciativa específica da empresa, 2 frases","problema":"Conflito estrutural com dado de mercado, 2 frases","solucao":"Capacidade da vendedora ligada a outcome, 3 frases","cta":"pedido pequeno e fácil de dizer sim, 1 frase"}`,
        apply: (d) => (currentPlan = { ...currentPlan, pitch: d }),
      },
      {
        id: "desc",
        ui: "disc",
        done: () => currentPlan.descoberta,
        prompt: `${base}\n\nGere: {"descoberta":["5 perguntas de discovery específicas desta conta, cada uma iniciando com [Metrics], [Economic Buyer], [Decision], [Pain] ou [Champion]"]}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "obj",
        ui: "disc",
        done: () => currentPlan.objecoes,
        prompt: `${base}\n\nGere: {"objecoes":[{"objecao":"","resposta":"contorno consultivo, 2-3 frases"}] com exatamente 3: apego ao fornecedor/solução atual, confiança-compliance-risco de trocar, concorrente já na conta}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "swot",
        ui: "analise",
        done: () => currentPlan.swot,
        prompt: `${base}\n\nGere a SWOT da empresa-alvo ORIENTADA À VENDA da vendedora: {"swot":{"forcas":["3 forças da conta, até 12 palavras"],"fraquezas":["3 fraquezas/dores operacionais que a vendedora explora"],"oportunidades":["3 oportunidades de entrada para a vendedora"],"ameacas":["3 ameaças ao deal: concorrência, timing, riscos"]}}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "fit",
        ui: "contexto",
        done: () => currentPlan.fitScore != null,
        prompt: `${base}\n\nCalcule o ICP Fit Score da conta para a vendedora, de 0 a 100, ponderando: aderência da dor à oferta (40%), potencial de receita (25%), acesso executivo mapeável (20%), timing/sinais de compra (15%). Gere: {"fitScore":numero inteiro 0-100,"fitRazoes":["3 razões curtas do score, a mais forte primeiro"]}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "sinais",
        ui: "analise",
        done: () => currentPlan.sinais,
        prompt: `${base}\n\nREGRA: use apenas fatos do INTEL DA PESQUISA; não invente eventos. Gere os sinais de compra que justificam abordar AGORA: {"sinais":[{"sinal":"fato detectado, até 10 palavras","tipo":"Executivo | Financeiro | Expansão | Reestruturação | Contratação | Tecnologia","implicacao":"por que isso abre porta para a vendedora, 1 frase"}] com 2 a 4 itens reais; se o intel não trouxer sinais, retorne {"sinais":[]}}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "matriz",
        ui: "disc",
        done: () => currentPlan.matriz,
        prompt: `${base}\n\nSTAKEHOLDERS JÁ MAPEADOS: ${JSON.stringify((currentPlan.stakeholders || []).map((s) => s.nome + " (" + s.papel + ")"))}\nGere a matriz de mensagem por persona: {"matriz":[{"persona":"nome/cargo do stakeholder","dor":"a dor específica DESTA persona, até 12 palavras","mensagem":"a mensagem-chave que ressoa com ela, 1 frase","canal":"LinkedIn InMail | E-mail | Cold call | Reunião executiva"}] com 1 linha por stakeholder mapeado}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "fin",
        ui: "analise",
        done: () => currentPlan.faturamento,
        prompt: `${base}\n\nREGRA CRÍTICA: use SOMENTE números de faturamento que constem no INTEL DA PESQUISA acima. NÃO estime, NÃO invente. Se o intel não trouxer números anuais confiáveis, retorne {"faturamento":[],"moeda":"","confiabilidade":"indisponível"}. Caso existam, gere a SÉRIE COMPLETA que o intel trouxer (idealmente 3 anos): {"faturamento":[{"ano":"2022","valor":numero},{"ano":"2023","valor":numero},{"ano":"2024","valor":numero}] em ordem cronológica, apenas anos com valor real no intel,"moeda":"ex: R$ bi ou R$ mi","confiabilidade":"público (RI/imprensa) | estimado"}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
      {
        id: "rec",
        ui: "analise",
        done: () => currentPlan.sintese,
        prompt: `${base}\n\nCom base em TODO o plano, gere a síntese executiva: {"sintese":"parágrafo de 3-4 frases: leitura estratégica da conta e por que agora","recomendacoes":[{"titulo":"até 6 palavras","detalhe":"1-2 frases acionáveis"}] com exatamente 3, priorizadas,"proximoPasso":"a ação única mais importante desta semana, 1 frase"}`,
        apply: (d) => (currentPlan = { ...currentPlan, ...d }),
      },
    ];

    const failedUi = new Set();
    for (const st of SUB) {
      if (st.done()) continue;
      setStatus((s) => (s[st.ui] === "done" ? s : { ...s, [st.ui]: "run" }));
      try {
        const d = await genJSON(st.prompt);
        st.apply(d);
        setPlan({ ...currentPlan });
        const uiDone = SUB.filter((x) => x.ui === st.ui).every((x) => x.done());
        if (uiDone && !failedUi.has(st.ui)) setStatus((s) => ({ ...s, [st.ui]: "done" }));
      } catch (e) {
        console.error(st.id, e);
        setStatus((s) => ({ ...s, [st.ui]: "err" }));
        failedUi.add(st.ui);
        setDebug((prev) => (prev ? prev + " | " : "") + st.id + ": " + String(e.message).slice(0, 90));
      }
      await sleep(400);
    }

    if (failedUi.size) {
      const names = { contexto: "Contexto", gap: "Gap analysis", acao: "Plano de ação", pitch: "Pitch", disc: "Discovery", analise: "Análise estratégica" };
      setError(`Seções pendentes: ${[...failedUi].map((f) => names[f]).join(", ")}. Clique em "Gerar Account Plan" para completar apenas o que falta.`);
    }
    setRunning(false);
  }

  function exportPDF() {
    const prevTitle = document.title;
    document.title = `Account Plan - ${form.empresa || "GTM Planner"}`;
    const wasDark = mode === "dark";
    if (wasDark) setMode("light"); // impressão sempre em claro, como documento
    setTimeout(() => {
      window.print();
      document.title = prevTitle;
      if (wasDark) setMode("dark");
    }, wasDark ? 250 : 50);
  }

  function loadDemo() {
    applyWisePreset();
    setForm(DEMO_FORM);
    runRef.current = { brief: "demo", intel: "demo" };
    setPlan(DEMO_PLAN);
    setStatus({ research: "done", contexto: "done", gap: "done", acao: "done", pitch: "done", disc: "done", analise: "done" });
    setError(null);
    setDebug(null);
  }

  const hasPlan = plan && plan.visaoGeral;
  const inputStyle = { border: "none", background: t.field, color: t.ink, borderRadius: 12 };

  return (
    <div style={{ ...body, background: t.paper, color: t.ink, minHeight: "100vh", colorScheme: mode, WebkitFontSmoothing: "antialiased" }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          @page { size: A4; margin: 13mm; }
          section, table, tr, svg { break-inside: avoid; page-break-inside: avoid; }
          article { margin-top: 0 !important; }
          main { padding-bottom: 0 !important; }
          a { text-decoration: none; }
        }
        input:focus, select:focus, textarea:focus { outline: none; box-shadow: 0 0 0 3px ${t.soft}, 0 0 0 1.5px ${t.bright}; }
        button:focus-visible { outline: 2px solid ${t.bright}; outline-offset: 2px; }
        input::placeholder, textarea::placeholder { color: ${t.gray}; opacity: 0.9; }
        input, select, textarea, button { font-family: ${SYSTEM_FONT}; transition: box-shadow .15s ease, background .2s ease, color .2s ease; }
        button { transition: transform .12s ease, opacity .15s ease, background .2s ease; }
        button:active:not(:disabled) { transform: scale(0.98); }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      `}</style>

      <header
        className="no-print"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: t.headerBg,
          backdropFilter: "saturate(180%) blur(20px)",
          WebkitBackdropFilter: "saturate(180%) blur(20px)",
          borderBottom: `1px solid ${t.mist}`,
        }}
      >
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center gap-3">
          <span style={{ width: 10, height: 10, borderRadius: 999, background: t.bright, display: "inline-block", boxShadow: `0 0 0 4px ${t.soft}` }} />
          <div style={{ lineHeight: 1.15 }}>
            <span style={{ ...display, color: t.ink, fontWeight: 700, fontSize: 19 }}>GTM Planner</span>
            <a
              href="https://www.linkedin.com/in/carloseduardovf/"
              target="_blank"
              rel="noopener noreferrer"
              className="block"
              style={{ ...body, color: mode === "light" ? t.forest : t.bright, fontSize: 12, fontWeight: 500, textDecoration: "none" }}
            >
              Developed by Carlos Eduardo ↗
            </a>
          </div>
          <span
            className="ml-auto px-2.5 py-1 rounded-full"
            style={{ ...body, fontSize: 11, fontWeight: 600, color: t.gray, background: t.segTrack, letterSpacing: "0.02em" }}
          >
            LATAM · B2B
          </span>
          <SegmentedControl t={t} mode={mode} onChange={setMode} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 pb-24">
        <section className="no-print mt-8 p-6" style={{ background: t.card, border: `1px solid ${t.mist}`, borderRadius: 20, boxShadow: t.shadow }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 style={{ ...display, fontSize: 18, fontWeight: 700 }}>1 · Sua empresa (vendedora)</h2>
            <button
              onClick={applyWisePreset}
              className="px-3 py-1.5 text-xs font-semibold"
              style={{ background: t.soft, color: mode === "light" ? t.forest : t.bright, border: "none", borderRadius: 999, cursor: "pointer" }}
            >
              Preencher com preset Wise
            </button>
          </div>
          <p className="mt-1 text-sm" style={{ color: t.gray }}>
            O plano é gerado com a lógica de venda DESTA empresa. Configure uma vez; fica salvo no navegador.
          </p>
          <div className="mt-4 grid gap-4">
            <label className="text-sm font-medium">
              Nome da empresa / produto
              <input
                value={seller.nome}
                onChange={(e) => setS("nome", e.target.value)}
                placeholder="Ex.: Wise, Adobe, RD Station, minha consultoria"
                className="mt-1 w-full rounded-lg px-3 py-2 text-base"
                style={inputStyle}
              />
            </label>
            <label className="text-sm font-medium">
              O que você vende, diferenciais e dores que resolve
              <textarea
                value={seller.descricao}
                onChange={(e) => setS("descricao", e.target.value)}
                rows={3}
                placeholder="Ex.: plataforma de automação de marketing B2B; reduz CAC e tempo de ramp de SDRs; resolve dados fragmentados entre CRM e mídia"
                className="mt-1 w-full rounded-lg px-3 py-2 text-base"
                style={inputStyle}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">
                Concorrentes típicos <span style={{ color: t.gray, fontWeight: 400 }}>(opcional)</span>
                <input value={seller.concorrentes} onChange={(e) => setS("concorrentes", e.target.value)} placeholder="Ex.: HubSpot, Salesforce, planilhas" className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={inputStyle} />
              </label>
              <label className="text-sm font-medium">
                Personas-alvo <span style={{ color: t.gray, fontWeight: 400 }}>(opcional)</span>
                <input value={seller.personas} onChange={(e) => setS("personas", e.target.value)} placeholder="Ex.: CMO, Head de Growth, CFO" className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={inputStyle} />
              </label>
            </div>
          </div>
        </section>

        <section className="no-print mt-6 p-6" style={{ background: t.card, border: `1px solid ${t.mist}`, borderRadius: 20, boxShadow: t.shadow }}>
          <h1 style={{ ...display, fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>
            2 · Conta-alvo
          </h1>
          <p className="mt-2 text-sm" style={{ color: t.gray }}>
            Informe a conta. A ferramenta pesquisa a empresa na web e monta o plano com a lógica de entrada da sua vendedora e metodologia GTM enterprise.
          </p>
          <div className="mt-5 grid gap-4">
            <label className="text-sm font-medium">
              Empresa-alvo
              <input
                value={form.empresa}
                onChange={(e) => set("empresa", e.target.value)}
                placeholder="Ex.: Loft, Infracommerce, Gol Linhas Aéreas"
                className="mt-1 w-full rounded-lg px-3 py-2 text-base"
                style={inputStyle}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">
                Segmento
                <select value={form.segmento} onChange={(e) => set("segmento", e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={inputStyle}>
                  {SEGMENTOS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium">
                Porte
                <select value={form.porte} onChange={(e) => set("porte", e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={inputStyle}>
                  <option>Startup / SMB (até 50 func.)</option>
                  <option>Mid-market (50 a 500 func.)</option>
                  <option>Enterprise (500+ func.)</option>
                </select>
              </label>
            </div>
            <label className="text-sm font-medium">
              Contexto adicional <span style={{ color: t.gray, fontWeight: 400 }}>(opcional)</span>
              <textarea
                value={form.contexto}
                onChange={(e) => set("contexto", e.target.value)}
                rows={2}
                placeholder="Ex.: já usa Payoneer para payouts; abriu escritório no México em 2025"
                className="mt-1 w-full rounded-lg px-3 py-2 text-base"
                style={inputStyle}
              />
            </label>
            <button
              onClick={generate}
              disabled={running || !form.empresa.trim() || !sellerReady}
              className="px-5 py-3 font-semibold text-base" 
              style={{
                background: running || !form.empresa.trim() || !sellerReady ? t.segTrack : t.bright,
                color: running || !form.empresa.trim() || !sellerReady ? t.gray : t.forest,
                cursor: running || !form.empresa.trim() || !sellerReady ? "not-allowed" : "pointer",
                border: "none",
                borderRadius: 14,
                fontSize: 17,
              }}
            >
              {running ? "Gerando plano..." : !sellerReady ? "Preencha sua empresa acima" : "Gerar Account Plan"}
            </button>
            <button
              onClick={loadDemo}
              disabled={running}
              className="px-5 py-3 font-semibold text-sm"
              style={{ background: t.soft, color: mode === "light" ? t.forest : t.bright, border: "none", borderRadius: 14, cursor: running ? "not-allowed" : "pointer" }}
            >
              Ver plano de exemplo (Infracommerce, sem IA)
            </button>
            {error && (
              <p className="text-sm" style={{ color: t.danger }}>
                {error}
              </p>
            )}
            {debug && (
              <p className="text-xs rounded-lg p-2" style={{ ...mono, color: t.gray, background: t.paper, border: `1px solid ${t.mist}`, wordBreak: "break-all" }}>
                Diagnóstico: {debug}
              </p>
            )}
          </div>
        </section>

        {Object.keys(status).length > 0 && (
          <section className="no-print mt-6 p-6" style={{ background: t.card, border: `1px solid ${t.mist}`, borderRadius: 20, boxShadow: t.shadow }}>
            <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.08em" }}>ROTA DO PLANO</p>
            <ol className="mt-3">
              {STAGES.map((st, i) => {
                const s = status[st.id];
                return (
                  <li key={st.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 999,
                          border: `2px solid ${s ? t.bright : t.mist}`,
                          background: s === "done" ? t.bright : s === "err" ? t.danger : t.card,
                          animation: s === "run" ? "pulse 1.2s infinite" : "none",
                        }}
                      />
                      {i < STAGES.length - 1 && (
                        <span style={{ width: 0, flex: 1, minHeight: 22, borderLeft: `2px dotted ${s === "done" ? t.bright : t.mist}` }} />
                      )}
                    </div>
                    <div className="pb-3">
                      <p className="text-sm font-semibold" style={{ color: s ? t.ink : t.gray }}>
                        {st.label}
                      </p>
                      <p className="text-xs" style={{ color: t.gray }}>
                        {st.sub}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {hasPlan && (
          <article className="mt-8">
            <div className="rounded-2xl p-6" style={{ background: t.forest, color: "#fff" }}>
              <p style={{ ...mono, fontSize: 11, color: t.bright, letterSpacing: "0.1em" }}>{`ACCOUNT PLAN · ${(seller.nome || "GTM").toUpperCase()} · FY26`}</p>
              <h2 style={{ ...display, fontSize: 30, fontWeight: 700, lineHeight: 1.1 }} className="mt-1">
                {form.empresa}
              </h2>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <Meta t={t} label="Tier" value={plan.tier || "-"} />
                <Meta t={t} label="Segmento" value={form.segmento.split(" /")[0]} />
                <Meta t={t} label="Potencial" value={plan.potencial || "-"} />
                <Meta t={t} label="Footprint" value="Greenfield" />
              </div>
              {plan.fitScore != null && (
                <div className="mt-4 rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="flex items-center justify-between gap-3">
                    <p style={{ ...mono, fontSize: 11, color: t.bright, letterSpacing: "0.08em" }}>ICP FIT SCORE</p>
                    <span style={{ ...display, fontSize: 26, fontWeight: 700, color: t.bright }}>{plan.fitScore}<span style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>/100</span></span>
                  </div>
                  <div className="mt-2 rounded-full overflow-hidden" style={{ height: 6, background: "rgba(255,255,255,0.15)" }}>
                    <div style={{ width: `${Math.min(100, Math.max(0, plan.fitScore))}%`, height: "100%", background: t.bright, borderRadius: 999, transition: "width .6s ease" }} />
                  </div>
                  {plan.fitRazoes && (
                    <ul className="mt-3 grid gap-1">
                      {plan.fitRazoes.map((r, i) => (
                        <li key={i} className="flex gap-2 text-xs" style={{ color: "rgba(255,255,255,0.85)" }}>
                          <span style={{ color: t.bright, fontWeight: 700 }}>·</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <Section t={t} n="1" title="Contexto da conta">
              <p className="text-base leading-relaxed">{plan.visaoGeral}</p>
              {plan.iniciativas && (
                <ul className="mt-3 grid gap-2">
                  {plan.iniciativas.map((it, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span style={{ color: t.bright, fontWeight: 700 }}>·</span>
                      {it}
                    </li>
                  ))}
                </ul>
              )}
              {plan.insight && (
                <div className="mt-4 rounded-xl p-4 text-sm" style={{ background: t.soft, borderLeft: `4px solid ${t.bright}` }}>
                  <strong>Insight estratégico:</strong> {plan.insight}
                </div>
              )}
            </Section>

            {plan.stakeholders && (
              <Section t={t} n="2" title="Mapa de stakeholders">
                <Table
                  t={t}
                  head={["Nome / Cargo", "Papel", "Próximo passo", "LinkedIn"]}
                  rows={plan.stakeholders.map((s, idx) => [
                    <span key={"n" + idx}>
                      <strong>{s.nome}</strong>
                      <span className="block text-xs" style={{ color: t.gray }}>
                        {s.area}
                        {s.sentimento ? " · " + s.sentimento : ""}
                      </span>
                    </span>,
                    s.papel,
                    s.proximoPasso,
                    <a
                      key={"l" + idx}
                      href={linkedinSearchUrl(s.nome, form.empresa)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block px-2 py-1 rounded-md text-xs font-semibold whitespace-nowrap"
                      style={{ background: t.soft, color: mode === "light" ? t.forest : t.bright, border: `1px solid ${t.bright}`, textDecoration: "none" }}
                    >
                      Abrir perfil ↗
                    </a>,
                  ])}
                />
                <p className="mt-2 text-xs" style={{ color: t.gray }}>
                  Os links abrem a busca do LinkedIn pelo nome/cargo + empresa, levando ao perfil real sem risco de link inválido.
                </p>
              </Section>
            )}

            {(plan.swot || (plan.faturamento && plan.faturamento.length > 0)) && (
              <Section t={t} n="3" title="Panorama estratégico — SWOT e faturamento">
                {plan.swot && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwotCard t={t} tone="pos" label="Forças" items={plan.swot.forcas} />
                    <SwotCard t={t} tone="neg" label="Fraquezas" items={plan.swot.fraquezas} />
                    <SwotCard t={t} tone="pos" label="Oportunidades de entrada" items={plan.swot.oportunidades} />
                    <SwotCard t={t} tone="neg" label="Ameaças ao deal" items={plan.swot.ameacas} />
                  </div>
                )}
                {plan.sinais && plan.sinais.length > 0 && (
                  <div className="mt-4 p-4" style={{ border: `1px solid ${t.mist}`, background: t.card, borderRadius: 14, boxShadow: t.shadow }}>
                    <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>POR QUE AGORA · SINAIS DE COMPRA</p>
                    <div className="mt-2 grid gap-2.5">
                      {plan.sinais.map((s, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-sm">
                          <span className="px-2 py-0.5 rounded-full whitespace-nowrap" style={{ fontSize: 10, fontWeight: 700, background: t.soft, color: mode === "light" ? t.forest : t.bright }}>
                            {s.tipo}
                          </span>
                          <p>
                            <strong>{s.sinal}.</strong> <span style={{ color: t.gray }}>{s.implicacao}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {plan.faturamento && plan.faturamento.length > 0 ? (
                  <div className="mt-4 rounded-xl p-4" style={{ border: `1px solid ${t.mist}`, background: t.card }}>
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>FATURAMENTO ANUAL ({plan.moeda || ""})</p>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: t.soft, color: mode === "light" ? t.forest : t.bright, border: `1px solid ${t.mist}` }}>
                        {plan.confiabilidade === "público (RI/imprensa)" || plan.confiabilidade === "público" ? "fonte pública" : "estimativa — validar"}
                      </span>
                    </div>
                    <RevenueBars t={t} data={plan.faturamento} />
                  </div>
                ) : (
                  plan.swot && (
                    <p className="mt-3 text-xs" style={{ color: t.gray }}>
                      Faturamento: sem dados públicos confiáveis encontrados na pesquisa; gráfico omitido por rigor (nada foi estimado).
                    </p>
                  )
                )}
              </Section>
            )}

            {plan.gaps && (
              <Section t={t} n="4" title="Current state e gap analysis">
                <Table t={t} head={["Categoria", "Atual (estimado)", "Maturidade", `Gap ${seller.nome || "vendedora"}`]} rows={plan.gaps.map((g) => [g.categoria, g.atual, g.maturidade, g.gapWise])} />
              </Section>
            )}

            {plan.plays && (
              <Section t={t} n="5" title="Oportunidades de entrada">
                <div className="grid gap-4">
                  {plan.plays.map((p, i) => (
                    <div key={i} className="p-4" style={{ border: `1px solid ${t.mist}`, background: t.card, borderRadius: 14, boxShadow: t.shadow }}>
                      <div className="flex items-start justify-between gap-2">
                        <h4 style={{ ...display, fontWeight: 700 }}>
                          Play #{i + 1} — {p.titulo}
                        </h4>
                        <span className="text-xs px-2 py-1 rounded-full whitespace-nowrap" style={{ background: i === 0 ? t.bright : t.mist, color: i === 0 ? t.forest : t.ink, fontWeight: 600 }}>
                          {i === 0 ? "Entry point" : `Impacto ${p.impacto || "-"}`}
                        </span>
                      </div>
                      <p className="text-xs mt-1" style={{ ...mono, color: t.gray }}>
                        {p.produtos} · {p.potencial} · esforço {p.esforco}
                      </p>
                      <p className="text-sm mt-2">{p.descricao}</p>
                      {p.trigger && (
                        <p className="text-sm mt-2" style={{ color: mode === "light" ? t.forest : t.bright }}>
                          <strong>Trigger:</strong> {p.trigger}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {plan.acoes && (
              <Section t={t} n="6" title="Plano de ação — 90 dias">
                <Table t={t} head={["Quando", "Ação", "Objetivo"]} rows={plan.acoes.map((a) => [a.quando, a.acao, a.objetivo])} />
              </Section>
            )}

            {plan.riscos && (
              <Section t={t} n="7" title="Riscos e mitigações">
                <Table t={t} head={["Risco", "Prob.", "Impacto", "Mitigação"]} rows={plan.riscos.map((r) => [r.risco, r.prob, r.impacto, r.mitigacao])} />
              </Section>
            )}

            {plan.pitch && (
              <Section t={t} n="8" title="Core pitch — framework 4C (15 min)">
                <div className="grid gap-3">
                  <PitchCard t={t} label="Contexto da conta (2 min)" c={plan.pitch.abertura} />
                  <PitchCard t={t} label="Conflito · problema estrutural (3 min)" c={plan.pitch.problema} />
                  <PitchCard t={t} label={`Capacidade ${seller.nome || "da vendedora"} (5 min)`} c={plan.pitch.solucao} />
                  <PitchCard t={t} label="CTA · pedido pequeno (2 min)" c={plan.pitch.cta} accent />
                </div>
              </Section>
            )}

            {plan.descoberta && (
              <Section t={t} n="9" title="Discovery e contorno de objeções">
                <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>PERGUNTAS DE QUALIFICAÇÃO (MEDDIC)</p>
                <ol className="mt-2 grid gap-2">
                  {plan.descoberta.map((q, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span style={{ color: t.bright, fontWeight: 700, minWidth: 18 }}>{i + 1}.</span>
                      {q}
                    </li>
                  ))}
                </ol>
                {plan.matriz && plan.matriz.length > 0 && (
                  <div className="mt-4">
                    <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>MATRIZ DE MENSAGEM POR PERSONA</p>
                    <div className="mt-2">
                      <Table
                        t={t}
                        head={["Persona", "Dor específica", "Mensagem-chave", "Canal"]}
                        rows={plan.matriz.map((m, i) => [<strong key={"p" + i}>{m.persona}</strong>, m.dor, m.mensagem, m.canal])}
                      />
                    </div>
                  </div>
                )}
                {plan.objecoes && (
                  <div className="mt-4 grid gap-3">
                    <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>OBJEÇÕES PROVÁVEIS</p>
                    {plan.objecoes.map((o, i) => (
                      <div key={i} className="p-4" style={{ border: `1px solid ${t.mist}`, background: t.card, borderRadius: 14, boxShadow: t.shadow }}>
                        <p className="text-sm font-semibold" style={{ color: mode === "light" ? t.forest : t.bright }}>
                          "{o.objecao}"
                        </p>
                        <p className="text-sm mt-1">{o.resposta}</p>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            <Section t={t} n="10" title="Cadência de abordagem — Tier 1">
              <p className="text-sm mb-3" style={{ color: t.gray }}>
                8 touchpoints em 30 dias contados a partir do primeiro contato (Dia 0 = solicitação de conexão). Regra: quanto maior o tier, mais manual e menos automatizado.
              </p>
              <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${t.mist}` }}>
                {CADENCIA_T1.map((c, i) => (
                  <div key={i} className="flex gap-3 px-4 py-3" style={{ background: i % 2 ? t.zebra : t.card, borderTop: i ? `1px solid ${t.mist}` : "none" }}>
                    <span style={{ ...mono, fontSize: 12, color: mode === "light" ? t.forest : t.bright, fontWeight: 700, minWidth: 56 }}>{c.dia}</span>
                    <div>
                      <p className="text-xs font-semibold" style={{ color: mode === "light" ? t.forest : t.bright }}>{c.canal}</p>
                      <p className="text-sm">{c.acao}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {plan.sintese && (
              <Section t={t} n="11" title="Síntese estratégica e recomendações">
                <div className="rounded-xl p-5" style={{ background: t.forest, color: "#fff" }}>
                  <p style={{ ...mono, fontSize: 11, color: t.bright, letterSpacing: "0.08em" }}>LEITURA DA CONTA</p>
                  <p className="text-sm mt-2 leading-relaxed">{plan.sintese}</p>
                </div>
                {plan.recomendacoes && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {plan.recomendacoes.map((r, i) => (
                      <div key={i} className="rounded-xl p-4" style={{ border: `1px solid ${t.mist}`, background: t.card, borderTop: `3px solid ${t.bright}` }}>
                        <p style={{ ...mono, fontSize: 10, color: t.gray }}>{"0" + (i + 1)}</p>
                        <p className="text-sm font-semibold mt-1" style={{ color: mode === "light" ? t.forest : t.bright }}>{r.titulo}</p>
                        <p className="text-sm mt-1">{r.detalhe}</p>
                      </div>
                    ))}
                  </div>
                )}
                {plan.proximoPasso && (
                  <div className="mt-3 rounded-xl p-4 flex items-start gap-3" style={{ background: t.soft, border: `1px solid ${t.bright}` }}>
                    <span style={{ ...mono, fontSize: 11, color: mode === "light" ? t.forest : t.bright, fontWeight: 700, whiteSpace: "nowrap" }}>PRÓXIMO PASSO →</span>
                    <p className="text-sm font-medium">{plan.proximoPasso}</p>
                  </div>
                )}
              </Section>
            )}

            <div className="no-print mt-8">
              <div className="flex gap-3 flex-wrap">
                <button onClick={exportPDF} className="px-5 py-3 font-semibold" style={{ background: mode === "light" ? t.forest : t.bright, color: mode === "light" ? "#fff" : t.forest, cursor: "pointer", border: "none", borderRadius: 14, fontSize: 17 }}>
                  Salvar em PDF
                </button>
              </div>
              <p className="mt-2 text-xs" style={{ color: t.gray }}>
                Na janela que abrir, escolha o destino "Salvar como PDF". O arquivo sai nomeado com a conta e com sua assinatura no rodapé.
              </p>
            </div>
            <p className="mt-4 text-xs" style={{ color: t.gray }}>
              Rascunho gerado por IA com pesquisa web. Valide dados de stakeholders e stack antes de usar com o time.
            </p>
            <footer className="mt-8 pt-4 flex items-center gap-2" style={{ borderTop: `1px solid ${t.mist}` }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: t.bright, display: "inline-block" }} />
              <p className="text-xs" style={{ ...mono, color: t.gray, letterSpacing: "0.06em" }}>
                GTM PLANNER · DEVELOPED BY{" "}
                <a
                  href="https://www.linkedin.com/in/carloseduardovf/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: mode === "light" ? t.forest : t.bright, fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 3 }}
                >
                  CARLOS EDUARDO VIEIRA FIGUEIREDO
                </a>{" "}
                · B2B GTM & REVENUE MARKETING
              </p>
            </footer>
          </article>
        )}
      </main>
    </div>
  );
}

// ---------- Componentes ----------
function SegmentedControl({ t, mode, onChange }) {
  const opts = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Tema"
      className="flex p-0.5"
      style={{ background: t.segTrack, borderRadius: 10 }}
    >
      {opts.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            className="px-3 py-1 text-xs font-semibold"
            style={{
              background: active ? t.segActive : "transparent",
              color: active ? t.ink : t.gray,
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              boxShadow: active ? "0 1px 4px rgba(0,0,0,0.12)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Meta({ t, label, value }) {
  return (
    <div>
      <p style={{ ...mono, fontSize: 10, color: t.bright, letterSpacing: "0.08em" }}>{label.toUpperCase()}</p>
      <p className="font-semibold text-sm mt-0.5">{value}</p>
    </div>
  );
}

function Section({ t, n, title, children }) {
  return (
    <section className="mt-9">
      <div className="flex items-center gap-2.5">
        <span style={{ fontFamily: SYSTEM_FONT, color: t.forest, fontWeight: 700, fontSize: 13, background: "#9FE870", borderRadius: 999, minWidth: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>{n}</span>
        <h3 style={{ ...display, fontSize: 21, fontWeight: 700 }}>{title}</h3>
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

function Table({ t, head, rows }) {
  return (
    <div className="overflow-x-auto" style={{ border: `1px solid ${t.mist}`, borderRadius: 14, boxShadow: t.shadow }}>
      <table className="w-full text-sm" style={{ background: t.card, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: t.tableHead }}>
            {head.map((h) => (
              <th key={h} className="text-left px-3 py-2 font-semibold" style={{ whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${t.mist}` }}>
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SwotCard({ t, tone, label, items }) {
  const accent = tone === "pos" ? t.bright : "#E0A458";
  return (
    <div className="rounded-xl p-4" style={{ border: `1px solid ${t.mist}`, background: t.card, borderLeft: `4px solid ${accent}` }}>
      <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>{label.toUpperCase()}</p>
      <ul className="mt-2 grid gap-1.5">
        {(items || []).map((it, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span style={{ color: accent, fontWeight: 700 }}>·</span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevenueBars({ t, data }) {
  // Ano único: indicador em destaque com nota honesta (sem série, sem gráfico enganoso)
  if (data.length === 1) {
    return (
      <div className="mt-3">
        <p style={{ fontFamily: SYSTEM_FONT, fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {data[0].valor}
          <span className="text-sm font-medium ml-2" style={{ color: t.gray }}>em {data[0].ano}</span>
        </p>
        <p className="text-xs mt-1" style={{ color: t.gray }}>
          Série histórica dos anos anteriores não localizada em fontes públicas; exibindo apenas o dado confirmado.
        </p>
      </div>
    );
  }
  // Série: gráfico de linha com pontos, valores e variação ano a ano
  const vals = data.map((d) => Number(d.valor) || 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || max || 1;
  const W = 560;
  const H = 170;
  const padX = 46;
  const padTop = 34;
  const padBot = 40;
  const x = (i) => (data.length === 1 ? W / 2 : padX + (i * (W - padX * 2)) / (data.length - 1));
  const y = (v) => padTop + (H - padTop - padBot) * (1 - (v - min) / range);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${H - padBot} ${pts} ${x(data.length - 1)},${H - padBot}`;
  return (
    <div className="mt-2" style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 320, height: "auto", display: "block" }} role="img" aria-label="Evolução do faturamento anual">
        <polygon points={area} fill={t.soft} />
        <polyline points={pts} fill="none" stroke="#9FE870" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {vals.map((v, i) => {
          const delta = i > 0 && vals[i - 1] ? ((v - vals[i - 1]) / vals[i - 1]) * 100 : null;
          return (
            <g key={i}>
              <circle cx={x(i)} cy={y(v)} r="6" fill={t.card} stroke="#9FE870" strokeWidth="3" />
              <text x={x(i)} y={y(v) - 14} textAnchor="middle" style={{ fontFamily: SYSTEM_FONT, fontSize: 14, fontWeight: 700, fill: t.ink }}>
                {v}
              </text>
              {delta != null && (
                <text x={x(i)} y={y(v) - 30} textAnchor="middle" style={{ fontFamily: SYSTEM_FONT, fontSize: 10, fontWeight: 600, fill: delta >= 0 ? "#34A853" : t.danger }}>
                  {(delta >= 0 ? "+" : "") + delta.toFixed(1)}%
                </text>
              )}
              <text x={x(i)} y={H - 14} textAnchor="middle" style={{ fontFamily: SYSTEM_FONT, fontSize: 12, fill: t.gray }}>
                {d0(data, i)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function d0(data, i) {
  return data[i].ano;
}

function PitchCard({ t, label, c, accent }) {
  return (
    <div className="rounded-xl p-4" style={{ background: accent ? t.soft : t.card, border: `1px solid ${t.mist}` }}>
      <p style={{ ...mono, fontSize: 11, color: t.gray, letterSpacing: "0.06em" }}>{label.toUpperCase()}</p>
      <p className="text-sm mt-1 leading-relaxed">{c}</p>
    </div>
  );
}
