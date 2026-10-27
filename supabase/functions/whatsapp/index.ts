// Edge Function `whatsapp`: conecta o WhatsApp do usuário (aparelho conectado via
// Baileys, não oficial) e envia figurinhas da coleção para a conversa dele mesmo.
// Ações (POST JSON, com o JWT do usuário logado):
//   { acao: "conectar" }                  inicia o pareamento; o QR aparece em whatsapp_status
//   { acao: "enviar", caminhos: [...] }  envia figurinhas do bucket `figurinhas`
//   { acao: "desconectar" }              remove o aparelho e apaga a sessão
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
} from "npm:baileys@7.0.0-rc14";
import pino from "npm:pino@9.14.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const logger = pino({ level: "silent" });
const BUCKET = "figurinhas";
const MAX_FIGURINHAS = 30;
const PAREAMENTO_MS = 135_000; // abaixo do limite de 150 s da função
const ORIGENS = ["https://cadueduu.github.io", "http://localhost:8765", "http://localhost:8000"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENS.includes(origin) ? origin : ORIGENS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ---------- Sessão da Baileys guardada em public.whatsapp_auth ----------
async function lerChaves(owner: string, chaves: string[]) {
  const mapa = new Map<string, unknown>();
  for (let i = 0; i < chaves.length; i += 100) {
    const { data, error } = await admin.from("whatsapp_auth").select("chave,valor")
      .eq("owner_id", owner).in("chave", chaves.slice(i, i + 100));
    if (error) throw error;
    for (const r of data) mapa.set(r.chave, JSON.parse(r.valor, BufferJSON.reviver));
  }
  return mapa;
}

async function authState(owner: string) {
  const creds = (await lerChaves(owner, ["creds"])).get("creds") ?? initAuthCreds();
  const keys = {
    get: async (type: string, ids: string[]) => {
      const mapa = await lerChaves(owner, ids.map((id) => `${type}-${id}`));
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        let valor = mapa.get(`${type}-${id}`);
        if (valor && type === "app-state-sync-key") valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
        if (valor) out[id] = valor;
      }
      return out;
    },
    set: async (data: Record<string, Record<string, unknown>>) => {
      const gravar: { owner_id: string; chave: string; valor: string }[] = [];
      const apagar: string[] = [];
      for (const type in data) {
        for (const id in data[type]) {
          const valor = data[type][id];
          const chave = `${type}-${id}`;
          if (valor) gravar.push({ owner_id: owner, chave, valor: JSON.stringify(valor, BufferJSON.replacer) });
          else apagar.push(chave);
        }
      }
      for (let i = 0; i < gravar.length; i += 500) {
        const { error } = await admin.from("whatsapp_auth").upsert(gravar.slice(i, i + 500));
        if (error) throw error;
      }
      for (let i = 0; i < apagar.length; i += 100) {
        await admin.from("whatsapp_auth").delete().eq("owner_id", owner).in("chave", apagar.slice(i, i + 100));
      }
    },
  };
  const saveCreds = async () => {
    const { error } = await admin.from("whatsapp_auth")
      .upsert({ owner_id: owner, chave: "creds", valor: JSON.stringify(creds, BufferJSON.replacer) });
    if (error) throw error;
  };
  return { state: { creds, keys: makeCacheableSignalKeyStore(keys as never, logger) }, saveCreds };
}

async function status(owner: string, campos: Record<string, unknown>) {
  await admin.from("whatsapp_status").upsert({ owner_id: owner, atualizado: new Date().toISOString(), ...campos });
}

async function limpar(owner: string, erro: string | null = null) {
  await admin.from("whatsapp_auth").delete().eq("owner_id", owner);
  await status(owner, { estado: "desconectado", qr: null, numero: null, erro });
}

function criarSocket(state: unknown) {
  return makeWASocket({
    auth: state as never,
    logger,
    browser: Browsers.ubuntu("Fig Figurinhas"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    shouldSyncHistoryMessage: () => false,
  });
}

// ---------- Pareamento por QR (roda em segundo plano) ----------
async function parear(owner: string) {
  const { state, saveCreds } = await authState(owner);
  const limite = Date.now() + PAREAMENTO_MS;
  let terminou = false;
  await new Promise<void>((resolve) => {
    const iniciar = () => {
      const sock = criarSocket(state);
      sock.ev.on("creds.update", saveCreds);
      const timer = setTimeout(async () => {
        if (terminou) return;
        terminou = true;
        sock.end(undefined);
        await status(owner, { estado: "desconectado", qr: null, erro: "O QR expirou. Toque em “Conectar” para gerar outro." });
        resolve();
      }, Math.max(limite - Date.now(), 1000));
      sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (terminou) return;
        if (qr) await status(owner, { estado: "aguardando_qr", qr, erro: null });
        if (connection === "open") {
          terminou = true;
          clearTimeout(timer);
          await saveCreds();
          await status(owner, { estado: "conectado", qr: null, numero: jidNormalizedUser(sock.user!.id).split("@")[0], erro: null });
          await sleep(4000); // deixa as chaves iniciais serem gravadas
          sock.end(undefined);
          resolve();
        } else if (connection === "close") {
          clearTimeout(timer);
          const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          if (code === DisconnectReason.restartRequired) return iniciar(); // normal logo após escanear
          terminou = true;
          if (code === DisconnectReason.loggedOut) await limpar(owner, "O celular recusou a conexão.");
          else await status(owner, { estado: "desconectado", qr: null, erro: `Conexão encerrada (${code ?? "?"}).` });
          resolve();
        }
      });
    };
    iniciar();
  });
}

// Abre uma conexão com a sessão salva; falha se ela não existir mais.
async function abrir(owner: string) {
  const { state, saveCreds } = await authState(owner);
  if (!state.creds.registered) throw new Erro(409, "WhatsApp não conectado. Escaneie o QR primeiro.");
  return await new Promise<ReturnType<typeof makeWASocket>>((resolve, reject) => {
    const sock = criarSocket(state);
    sock.ev.on("creds.update", saveCreds);
    const timer = setTimeout(() => {
      sock.end(undefined);
      reject(new Erro(504, "O WhatsApp demorou para responder. Tente de novo."));
    }, 40_000);
    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        clearTimeout(timer);
        resolve(sock);
      } else if (connection === "close") {
        clearTimeout(timer);
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          await limpar(owner, "O aparelho foi desconectado pelo celular. Conecte de novo.");
          reject(new Erro(409, "O aparelho foi desconectado pelo celular. Conecte de novo."));
        } else {
          reject(new Erro(502, `Não foi possível conectar ao WhatsApp (${code ?? "?"}).`));
        }
      }
    });
  });
}

function webpAnimada(b: Uint8Array) {
  return b.length > 21 && String.fromCharCode(...b.subarray(12, 16)) === "VP8X" && (b[20] & 0x02) !== 0;
}

async function enviar(owner: string, caminhos: unknown) {
  if (!Array.isArray(caminhos) || !caminhos.length) throw new Erro(400, "Nenhuma figurinha selecionada.");
  if (caminhos.length > MAX_FIGURINHAS) throw new Erro(400, `Envie no máximo ${MAX_FIGURINHAS} por vez.`);
  const arquivos: Uint8Array[] = [];
  for (const c of caminhos) {
    if (typeof c !== "string" || !c.startsWith(`${owner}/`) || c.includes("..")) throw new Erro(403, "Figurinha de outra conta.");
    const { data, error } = await admin.storage.from(BUCKET).download(c);
    if (error) throw new Erro(404, `Figurinha não encontrada: ${c.split("/").pop()}`);
    arquivos.push(new Uint8Array(await data.arrayBuffer()));
  }
  const sock = await abrir(owner);
  try {
    const eu = jidNormalizedUser(sock.user!.id);
    for (const bytes of arquivos) {
      await sock.sendMessage(eu, { sticker: Buffer.from(bytes), isAnimated: webpAnimada(bytes), width: 512, height: 512 });
      await sleep(800);
    }
    await sleep(1500);
  } finally {
    sock.end(undefined);
  }
  await status(owner, { estado: "conectado", erro: null });
  return arquivos.length;
}

async function desconectar(owner: string) {
  try {
    const sock = await abrir(owner);
    await sock.logout();
  } catch {
    // sessão já inválida: só limpa
  }
  await limpar(owner);
}

class Erro extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const responder = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return responder({ erro: "Faça login." }, 401);
    const { data: liberado } = await admin.from("whatsapp_permitidos").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!liberado) return responder({ erro: "O envio pelo WhatsApp não está liberado para esta conta." }, 403);

    const { acao, caminhos } = await req.json().catch(() => ({}));
    if (acao === "conectar") {
      const { data: atual } = await admin.from("whatsapp_status").select("estado,atualizado").eq("owner_id", user.id).maybeSingle();
      const recente = atual && Date.now() - new Date(atual.atualizado).getTime() < PAREAMENTO_MS;
      if (atual?.estado === "conectado") return responder({ estado: "conectado" });
      if (recente && (atual.estado === "aguardando_qr" || atual.estado === "iniciando")) return responder({ estado: atual.estado });
      await admin.from("whatsapp_auth").delete().eq("owner_id", user.id); // pareamento novo começa limpo
      await status(user.id, { estado: "iniciando", qr: null, numero: null, erro: null });
      EdgeRuntime.waitUntil(parear(user.id).catch((e) => status(user.id, { estado: "desconectado", qr: null, erro: String(e?.message ?? e) })));
      return responder({ estado: "iniciando" });
    }
    if (acao === "enviar") return responder({ enviadas: await enviar(user.id, caminhos) });
    if (acao === "desconectar") {
      await desconectar(user.id);
      return responder({ estado: "desconectado" });
    }
    return responder({ erro: "Ação inválida." }, 400);
  } catch (e) {
    const code = e instanceof Erro ? e.status : 500;
    return responder({ erro: e instanceof Error ? e.message : String(e) }, code);
  }
});
