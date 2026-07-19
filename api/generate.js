// Função serverless (Vercel) que protege a chave da API.
// A chave fica na variável de ambiente ANTHROPIC_API_KEY, nunca no navegador.
// maxDuration 60s: a pesquisa web pode exceder os 10s padrão e derrubar a função (causa do travamento).
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada na Vercel" });
  }
  try {
    const { messages, tools, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages obrigatório" });
    }
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: Math.min(Number(max_tokens) || 2500, 4000),
      messages,
    };
    if (tools) payload.tools = tools;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
