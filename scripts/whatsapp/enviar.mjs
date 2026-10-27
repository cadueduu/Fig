#!/usr/bin/env node
// Conecta ao seu WhatsApp como "aparelho conectado" e envia figurinhas para a
// sua própria conversa ("Você"). Usa a biblioteca não oficial Baileys: use só
// com o seu número e poucas mensagens, há risco de bloqueio pelo WhatsApp.
//
// Uso:
//   node enviar.mjs [opções] ARQUIVO.webp|PASTA|PACOTE.wastickers ...
// Opções:
//   --qr ARQUIVO.png   onde salvar a imagem do QR code (padrão: figurinhas/whatsapp-qr.png)
//   --codigo NUMERO    conecta por código de pareamento em vez de QR (ex.: 5511999999999)
//   --manter           mantém o aparelho conectado no fim (padrão: desconecta)
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, useMultiFileAuthState } from "baileys";
import JSZip from "jszip";
import pino from "pino";
import QRCode from "qrcode";

const ROOT = path.resolve(import.meta.dirname, "../..");
const AUTH_DIR = path.join(homedir(), ".fig-whatsapp");
const MAX_STATIC = 100 * 1024;
const MAX_ANIMATED = 500 * 1024;

function parseArgs(argv) {
  const opts = { qr: path.join(ROOT, "figurinhas", "whatsapp-qr.png"), codigo: null, manter: false, entradas: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--qr") opts.qr = path.resolve(argv[++i]);
    else if (a === "--codigo") opts.codigo = argv[++i].replace(/\D/g, "");
    else if (a === "--manter") opts.manter = true;
    else opts.entradas.push(path.resolve(a));
  }
  return opts;
}

// Lê dimensões e animação do cabeçalho RIFF/WebP.
function webpInfo(b) {
  const str = (o, n) => b.subarray(o, o + n).toString("latin1");
  if (b.length < 30 || str(0, 4) !== "RIFF" || str(8, 4) !== "WEBP") return null;
  const chunk = str(12, 4);
  if (chunk === "VP8X") {
    return { animated: (b[20] & 0x02) !== 0, width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") return { animated: false, width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    return { animated: false, width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
  }
  return null;
}

async function collect(entradas) {
  const found = [];
  for (const entrada of entradas) {
    if (/\.(wastickers|zip)$/i.test(entrada)) {
      const zip = await JSZip.loadAsync(await readFile(entrada));
      const names = Object.keys(zip.files).filter((n) => /\.webp$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) found.push({ name: `${path.basename(entrada)}/${n}`, data: Buffer.from(await zip.file(n).async("uint8array")) });
    } else if ((await stat(entrada)).isDirectory()) {
      const names = (await readdir(entrada)).filter((n) => /\.webp$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) found.push({ name: n, data: await readFile(path.join(entrada, n)) });
    } else {
      found.push({ name: path.basename(entrada), data: await readFile(entrada) });
    }
  }
  const stickers = [];
  for (const f of found) {
    const info = webpInfo(f.data);
    const limit = info?.animated ? MAX_ANIMATED : MAX_STATIC;
    if (!info) console.warn(`[pulando] ${f.name}: não é WebP`);
    else if (info.width !== 512 || info.height !== 512) console.warn(`[pulando] ${f.name}: ${info.width}x${info.height}, precisa ser 512x512 (use scripts/figurinhas.py)`);
    else if (f.data.length > limit) console.warn(`[pulando] ${f.name}: ${Math.round(f.data.length / 1024)} KB, limite ${limit / 1024} KB`);
    else stickers.push({ ...f, animated: info.animated });
  }
  return stickers;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stickers = await collect(opts.entradas);
  if (!stickers.length) {
    console.error("Nenhuma figurinha válida para enviar.");
    process.exit(1);
  }
  console.log(`${stickers.length} figurinha(s) pronta(s) (${stickers.filter((s) => s.animated).length} animada(s)).`);

  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let pairingRequested = false;
  let attempts = 0;

  const connect = () =>
    new Promise((resolve, reject) => {
      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Fig Figurinhas"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr && !opts.codigo) {
          await mkdir(path.dirname(opts.qr), { recursive: true });
          await QRCode.toFile(opts.qr, qr, { width: 480, margin: 2 });
          console.log(`QR code atualizado: ${opts.qr}`);
          console.log("No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie o QR.");
          console.log(await QRCode.toString(qr, { type: "terminal", small: true }));
        }
        if (qr && opts.codigo && !pairingRequested) {
          pairingRequested = true;
          const code = await sock.requestPairingCode(opts.codigo);
          console.log(`Código de pareamento: ${code.match(/.{1,4}/g).join("-")}`);
          console.log("No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone → digite o código.");
        }
        if (connection === "open") {
          attempts = 0;
          resolve(sock);
        }
        if (connection === "close") {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (status === DisconnectReason.loggedOut) {
            await rm(AUTH_DIR, { recursive: true, force: true });
            reject(new Error("sessão encerrada pelo celular; rode de novo para conectar"));
          } else if (++attempts > 5) {
            reject(new Error(`não foi possível conectar (${lastDisconnect?.error?.message || status}); a rede bloqueia o WhatsApp?`));
          } else {
            connect().then(resolve, reject); // ex.: reinício pedido logo após escanear o QR
          }
        }
      });
    });

  const sock = await connect();
  const me = jidNormalizedUser(sock.user.id);
  console.log(`Conectado como ${me.split("@")[0]}. Enviando para a sua própria conversa…`);

  for (const [i, s] of stickers.entries()) {
    await sock.sendMessage(me, { sticker: s.data, isAnimated: s.animated, width: 512, height: 512 });
    console.log(`  ${i + 1}/${stickers.length} ${s.name}${s.animated ? " (animada)" : ""}`);
    await sleep(1500); // ritmo calmo para não parecer automação
  }

  if (opts.manter) {
    console.log("Pronto. O aparelho continua conectado (--manter).");
    await sleep(3000);
    process.exit(0);
  }
  await sleep(3000); // deixa os envios terminarem
  await sock.logout().catch(() => {});
  await rm(AUTH_DIR, { recursive: true, force: true });
  console.log("Pronto. Aparelho desconectado do seu WhatsApp.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
